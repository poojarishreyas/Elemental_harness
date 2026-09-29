# Control flow of the engine core

Source of record: `packages/core/agent-loop/src/` (6 files, 1,756 lines total).
Everything in this file is ✅ **Verified (code)** unless explicitly marked. No claim here rests on a name, comment, or doc.

Evidence limitation for the whole book: `node_modules` is **absent** in this checkout, so nothing has been 🧪 run-verified. Every claim below comes from reading the implementation.

---

## 1. The three nested loops

The engine is three loops, not one:

| Loop | Location | Iterates over | Exit condition |
|---|---|---|---|
| driver | `agent.ts:221` → `while (await this.turn()) {}` | turns | `turn()` returns `false` |
| turn | `agent.ts:272` → `while (true)` | steps | `break` or `return false` (§4) |
| step | `agent.ts:348` → `while (true)` | model request retries | returns, or `continue` on retry (§5) |

`kick()` (`agent.ts:219-232`) owns the driver. It **swallows every error** at `agent.ts:222-224` — the `catch (_error)` body is empty, with the comment "Reported failures and cancellation are contained at the driver boundary." Failures have already been surfaced via `throwError()` (`agent.ts:212-217`), which emits `agent/error` before rethrowing.

---

## 2. Phase state machine

`Phase` (`agent.ts:39-47`) is a closed union of three states:

```ts
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }
```

Externally visible `status` (`agent.ts:108-110`) collapses this to two values: `'running'` only when `phase.kind === 'running'`; both `idle` and `maintenance` report `'idle'`.

`setPhase()` (`agent.ts:113-120`) emits `agent/status` **only when the collapsed status actually changes** — so an idle→maintenance transition emits nothing.

Transitions:
- idle → running: `wakeDriver()` (`agent.ts:192-201`)
- idle → maintenance: `runMaintenance()` (`agent.ts:154-160`)
- maintenance → idle: `runMaintenance` `finally` (`agent.ts:166`)
- running → idle: `kick()` `finally` (`agent.ts:226-230`)

**The abort controller is per-phase, and is replaced between turns** (`agent.ts:334`). That replacement is what makes a latched wake stale — see §6.

---

## 3. Input: three entry points, one primitive

`followup`/`steer`/`inject` (`agent.ts:131-141`) are all thin wrappers over `send(message, target, wakeup)`:

| Method | target | wakeup | Meaning |
|---|---|---|---|
| `followup` | `'next-turn'` | `true` | new turn, wake the driver |
| `steer` | `'next-step'` | `true` | join the current turn at the next step boundary, wake |
| `inject` | `'next-step'` | `false` | join the next step, do **not** wake an idle agent |

`send()` (`agent.ts:122-129`) contains one subtle reclassification:

```ts
const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
```

A waking message that arrives after the current activity was already aborted is **retargeted to `next-turn`**, because it cannot join an aborted activity. The flag is computed *before* `inbox.splice()` so a reentrant `cancel()` fired by a splice observer cannot reclassify it (comment at `agent.ts:124-125`, and the value is captured in a local).

---

## 4. Turn control decisions (`turn()`, `agent.ts:255-339`)

This is the highest-risk area to get wrong; each branch below was read individually.

Entry: throws if not in `running` phase (`agent.ts:256-258`, via `throwError`). Appends `turn/start` — and a failure to append is itself routed through `throwError` (`agent.ts:263-267`).

Inside `while (true)`:

1. `signal.throwIfAborted()` (`:273`)
2. `preStep(target, {turn, step})` (`:275`)
3. **reject** → `turnEnds = {kind:'blocked'}`, `return false` (`:276-279`) — the driver stops entirely; no further turn.
4. `if (turnEnds && decision.messages.length === 0) break` (`:280`) — turn already has an ending and nothing new arrived.
5. `if (phase.step === 0 && decision.messages.length === 0)` → `turnEnds = {kind:'completed'}`, `return false` (`:283-286`). Comment: a removed waking message or an enter-decision rewritten to empty "still owns the initial turn boundary, but it spends no model call." **So a turn can open and close without any LLM request.**
6. Append `step/start`, then one `user/message` per claimed message (`:288-293`)
7. `stepEnd = await this.step(...)` (`:296`)
8. **max-tokens is sticky** (`:299`): `if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd`. Once any step hits the ceiling, a later completed step cannot downgrade the turn outcome.
9. `finally` → append `step/end` (`:301`) — always, including on throw.
10. If `turnEnds` is set **and** `inbox.nextStep` is empty → `await dispatch.serial('agent/turn-stopping', {turn, signal})` (`:304-307`). This is a last-chance extension point: a listener can enqueue into `nextStep` and the condition is **re-tested** at `:308`.
11. `if (turnEnds && this.inbox.nextStep.length === 0) break` (`:308`)
12. otherwise `target = 'next-step'` and loop.

Exit paths after the loop:
- `catch` (`:311-324`): if `signal.aborted` → `turnEnds = {kind:'aborted', reason}` and rethrow. Otherwise the error is **structured**: an `LlmError` keeps `error.failure`; anything else becomes `{message: errorChain(error), code: 'UNKNOWN'}` (`:318-323`), then `throwError`.
- `finally` (`:325-332`): append `turn/end` with the accumulated reason. A failure to append that is itself routed through `throwError`.
- `if (!this.inbox.hasPending) return false` (`:333`) — driver stops.
- Otherwise (`:334-338`): **new `AbortController`**, `wakeRequested = false`, `step = 0`, `return true` → another turn.

`TurnEndReason` kinds observed: `completed`, `max-tokens`, `blocked`, `aborted`, `error`.

---

## 5. Step control decisions (`step()`, `agent.ts:341-438`)

Returns `StepEndReason | null`, where **`null` means "keep going — another step in this turn"**.

Inside `while (true)` (the retry loop):

1. Capture `surfaceGeneration = session.surface.replaceGeneration` (`:349`) — feeds request-series detection (§7).
2. `buildRequest(...)` (`:350-359`), then `startsRequestSeries = false` (`:360`) so only the first iteration can start a series.
3. Stream: `preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)` (`:364`). **The prepared call is preferred; the bare `llm.stream` is the fallback when no adapter was resolved.**
4. Per chunk (`:366-370`): `throwIfAborted`, append `assistant/chunk`, collect its `seq`, `assembler.push(chunk)`.
5. `catch` (`:372-389`): **only when `signal.aborted`**, salvage `assembler.interruptedBlocks()`; if non-empty, append an `assistant/message` with `interrupted: true` and the collected `sourceEventSeqs`. Then rethrow regardless.
6. `finish.kind === 'error' | 'aborted'` (`:391-408`): run the `agent/request-error` **waterfall**. If the returned action is not `{kind:'retry'}` → `throw new LlmError(...)`. If it *is* retry → `continue`, i.e. rebuild the request and stream again. **The loop itself never decides to retry; a listener must.**
7. Otherwise append `assistant/message` (`:418-427`).
8. `finish.kind === 'max-tokens'` → `return {kind:'max-tokens'}` (`:428`).
9. `toolCalls.length === 0` → `return {kind:'completed'}` (`:430-431`).
10. Else `executeToolCalls(...)` (`:432-435`) and `return concluded ? {kind:'completed'} : null` (`:436`).

So the **only** way a turn continues to another step is: the assistant emitted ≥1 tool call **and** no committed result set `concludesTurn`.

---

## 6. Wake latching (`wakeDriver`, `agent.ts:181-202`)

When not idle, the wake cannot be delivered, so it may be *latched* (`phase.wakeRequested = true`) for replay at convergence. The latch is set **only** when:

```ts
reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)
```

(`agent.ts:186-189`). Two consequences:
- **Disposal never latches** — so teardown never waits on a model turn.
- A live, non-aborted running driver does not latch; it claims queued work itself.

Replay happens in two places, both guarded by `inbox.hasPending`: `kick()`'s `finally` (`:229`) and `runMaintenance`'s `finally` (`:167`).

`turn()` clears the latch when it rotates the abort controller (`:336`) because a latch set on the *old* controller is stale.

---

## 7. Request construction (`buildRequest`, `agent.ts:444-544`)

Ordered decisions:

1. Seed config: on the **first** request of this loop instance, `{provider, model, reasoningEffort?, maxTokens?}` from `AgentOptions`; afterwards, `requestProposal(persistedHeader)` (`agent.ts:61-67`), which **strips** `reasoningEffort`/`maxTokens` when `header.adapterDefaults` marks them adapter-derived, so they get re-resolved.
2. A persisted `reasoningEffort` is restored **only if** the persisted config's provider *and* model both equal the declared route and the value was not adapter-derived (`:461-465`).
3. `deepFreeze(structuredClone(...))` the seed (`:468`), then run the `agent/request` **waterfall** (`:478-481`).
4. Hard failure if the proposal lacks provider or model (`:483-485`).
5. `llm.prepareCall(...)` (`:489`). On `LlmError` with code `NO_ADAPTER` **only**, fall back to using the proposed config directly (`:491-495`) — any other error propagates. Comment: "Middleware may serve an unregistered route."
6. `canonicalHeader({config, adapterDefaults?, system?, tools?})` (`:498-503`).
7. **Three-way header logging decision** (`:507-518`):
   - never logged yet → `request/header` with reason `'initial'` (no baseline) or `'resume'` (baseline exists)
   - baseline missing or `!headerEquals(baseline, header)` → reason `'change'`, plus `startsSeries: true` when applicable
   - unchanged but `startsSeries` → reason `'series'`
   - unchanged and not a series → **no event appended**
8. `startsSeries` is `startsRequestSeries || this.requestSurfaceGeneration !== surfaceGeneration` (`:505-506`) — i.e. a surface replacement (compaction rewriting history) starts a new request series.
9. `request/context` appended only when provider, model, or contextWindow differs from the previous (`:527-532`).
10. Final request is `markAgentLoopRequest(deepFreeze({...}))` (`:535-542`), carrying `messages: boundaryMessages` — which the caller obtained from `session.deriveMessages()` (`agent.ts:355`).

---

## 8. The engine's central invariant

`src/invariant.ts` is a separate companion plugin (`name = 'agent-loop-invariant'`, `inject = ['invariants']`) that prepends a **global** `llm/stream` listener (`invariant.ts:21`, `{global: true, prepend: true}` — prepend so "a short-circuiting replay listener" cannot silence it).

For any request where `isAgentLoopRequest(options)`, it fails unless all hold (`invariant.ts:22-52`):
- the request object is frozen, and `options.messages` is frozen
- `options.sessionId` is present and resolves to a live session
- the session log contains at least one `step/start`
- `foldRequestHeader(events)` yields a header
- **`JSON.stringify(options.messages) === JSON.stringify(session.deriveMessages())`** — else "log-reconstruction desync"
- model, system, temperature, maxTokens, stop, and tools all match the folded header

This is the machine-checked statement of the engine's core design claim: **the request is a pure function of the session log.** It is the single best anchor for the book's thesis.

⚠️ Not yet established: whether this companion is mounted in the running `web` profile. It is exported as `./invariant` from the package (`package.json` exports), and `tsconfig.base.json:318` maps the subpath, but it does not appear as a row in `packages/bundle/base/cordis.patch.yml` or `packages/bundle/web-app/cordis.patch.yml`. **Open question** — see `open-questions.md`.

---

## 9. Tool-call scheduling (`tool-calls.ts`)

`executeToolCalls` (`:60-102`) walks the model-ordered calls, re-classifying at each group boundary:

- `ctx.tools.executionMode(first.exec).kind` (`:89`) decides the group: `'parallel'` → all remaining calls; anything else → **just the one call** (an exclusive barrier).
- Groups run via `runGroup` and `next += outcome.consumed`.
- On abort, every remaining planned call gets a **synthetic error result** appended (`:97`, `appendSkippedToolCall`) so the log stays replay-valid.

`runGroup` (`:122-247`) invariants:
- `maxParallelToolCalls` is **destructured per group** (`:132`), so a settings change caps the *next* group without disturbing one in flight (matches the read-through getter at `index.ts:389-391`).
- `commitReady()` (`:147-161`) advances `committed` **only across contiguous model-order slots** — dispatch may overlap, but results commit in model order.
- `finalize` vs `finish` is chosen by `slot.needsPost` (`:152-154`).
- `fillPool()` (`:199-214`) stops early if a later call re-classifies as non-parallel (`:204-205`) — a registry change mid-group creates a barrier.
- A scheduler failure stops new dispatches, awaits `Promise.allSettled(inFlight)`, and rethrows **without fabricating results** (`:232-236`).
- `concluded ||= result.concludesTurn === true` (`:158`) — any single result can conclude the turn.

`parseArguments` (`:105-111`): `raw ? JSON.parse(raw) : {}`, and on a parse error **returns the raw string unchanged** rather than throwing. Malformed model JSON therefore reaches the tool layer as a `string`.

---

## 10. Configuration actually in force

| Value | Default | Source |
|---|---|---|
| `maxParallelToolCalls` | `10` | `constants.ts:6`, validated by `resolveMaxParallelToolCalls` (`index.ts:189-195`): must be an integer ≥ 1 |
| `agents` | `[]` in the web profile | `packages/bundle/base/cordis.patch.yml:486-489` |

`maxParallelToolCalls` is user-owned through the `agent-loop` settings namespace (`index.ts:293-308`) and exposed as a **getter that re-reads on every access** (`index.ts:389-391`). `AgentLoopSettings` is deliberately a strict subset of `Config`: `agents` is boot-time-only, so a stored change "could only look like it had an effect" (`index.ts:296-303`).
