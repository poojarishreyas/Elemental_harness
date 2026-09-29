# Chapter 32 · When things go wrong

**What you'll learn:** three failure paths traced end to end — one the system recovers from, one it unwinds cleanly, and one it cannot fix at all.

**Prerequisites:** Part III, and [Chapter 31](31-one-real-turn.md) for the happy path.

---

Failures are where a design's real structure shows. A system that only works when nothing goes wrong has not been designed; it has been demonstrated.

---

## A · Context overflow — recovery

**The situation.** A long session. The step loop builds a request, dispatches it, and the provider rejects it: the conversation no longer fits in the context window.

### The trace

**① The failure is normalized.** The adapter throws. `normalizeLlmFailure` reads its properties via descriptors, recognizes the provider's error text through `isContextWindowExceededError`, and produces `{ code: 'CONTEXT_WINDOW_EXCEEDED', ... }` ([Ch 25](25-failures-and-retry.md)). It arrives as a terminal chunk: `{ type: 'finish', reason: { kind: 'error', failure } }`.

**② The step loop asks.** `finish.kind === 'error'`, so it dispatches the `agent/request-error` waterfall with a default of `undefined` — terminal ([Ch 9](09-the-turn-and-step-loops.md) ⑥).

**③ Compaction claims it.** Its listener checks the code and matches (`compaction-basic/src/index.ts:180-224`). It calls `compactIfNeeded(agent, 'context-overflow', signal)` — and because the trigger is overflow, **the 80% threshold check is skipped entirely**. The provider has already given a definitive answer; arguing with it via a character-count estimate would be absurd ([Ch 26](26-measuring-and-spilling.md)).

**④ Cheap first.** The tool-result pruner runs: every oversized `tool/result` on the surface is replaced in place with a head/tail excerpt, one `replace` op each, content-only. No model call. Re-measure ([Ch 27](27-pruning-and-compaction.md)).

**⑤ Summarize, if needed.** A durable `compaction/start` lock is appended. A range is selected retaining ~16% of the window verbatim, ending at a boundary that does not split a tool call from its result. The summarization request **replays the conversation's own system prompt and tools**, keeping the provider's prefix cache warm. The summary is size-checked — a compaction that would not shrink is refused — then committed as `compaction/summary` plus a `user/message` with `surfaceOp: { op: 'replace', start, end }`. `compaction/end` closes the transaction.

**⑥ The claim is honest.** Compaction returns `{ kind: 'retry' }` **only if `replaceGeneration` actually advanced**. If nothing changed, it calls `next()` and `llm-retry` gets its turn — which, since `CONTEXT_WINDOW_EXCEEDED` is not in the default retryable set, means delegating to the terminal default.

**⑦ The request is rebuilt.** `continue` re-enters the step loop at `buildRequest` ([Ch 9](09-the-turn-and-step-loops.md)). Four things differ:

- `deriveMessages()` rebuilds from scratch, because the generation changed ([Ch 7](07-from-log-to-request.md));
- the header logs `reason: 'series'` even though its bytes are identical, because a surface rewrite starts a new series ([Ch 10](10-building-the-request.md));
- the runtime-context snapshot may re-inject, if the shadowed range contained one ([Ch 21](21-runtime-context-injection.md));
- the prepared call is new — the old one was single-use ([Ch 23](23-adapters-and-preparecall.md)).

**⑧ Bounded.** `maxOverflowRetries` defaults to `1`, tracked per agent and reset on the next `assistant/message` or when the agent goes idle. One rescue per failure, not a loop.

### What the user saw

A pause. The turn completed.

### What the log shows

```
turn/start · step/start · user/message · request/header(initial) · assistant/chunk…
compaction/prune · tool/result(replace) · compaction/start · compaction/summary
user/message(replace) · compaction/end
request/header(series) · assistant/chunk… · assistant/message · step/end · turn/end(completed)
```

Every step of the recovery is in the record, in order, and the superseded messages are still at their original positions.

---

## B · Cancellation mid-stream — clean unwinding

**The situation.** The model is streaming. Three tool calls from the previous step are still running. The user presses stop.

### The trace

**① The signal fires.** `cancel(cause)` clears the inbox, clears the wake latch, then aborts the current phase's controller ([Ch 13](13-phases-cancellation-quiescence.md)). The cause travels with it.

**② Partial output is salvaged.** The streaming loop's abort check throws. The `catch` runs `assembler.interruptedBlocks()` — text and reasoning with real content, **tool calls omitted** because "interruption precedes dispatch; retaining one would require a fabricated result." If anything survives, it is appended as an `assistant/message` with `interrupted: true`, citing every chunk seq so far ([Ch 24](24-streaming-and-assembly.md)). Then the error rethrows: salvaging is not recovering.

**③ In-flight tools drain.** The scheduler does not abandon them. It awaits everything already dispatched, commits their results in **model order**, and accepts their `additionalContexts` ([Ch 17](17-scheduling-tool-calls.md)).

**④ Unstarted calls get synthetic results.** Every call the scheduler never started receives a `tool/call` + `tool/result` pair with code `ABORTED_BEFORE_DISPATCH`. The module doc gives the reason: "so replay stays valid." A `tool/call` with no matching result would make the *next* request invalid — a cancelled turn must still be a well-formed conversation.

**⑤ The turn records why.** `turnEnds = { kind: 'aborted', reason: signal.reason }` — the cause, not just the fact. `step/end` and `turn/end` are appended by their `finally` blocks, so the log stays balanced ([Ch 9](09-the-turn-and-step-loops.md)).

**⑥ The driver returns to idle.** `kick()`'s empty `catch` contains the error — already reported via `agent/error` — and its `finally` sets the phase back to idle, replaying a latched wake only if the inbox still has something ([Ch 13](13-phases-cancellation-quiescence.md)).

**⑦ A late message is not lost.** A user message arriving during the aborting window is retargeted to `next-turn` by `send`'s `wakingAfterAbort` check, computed *before* the splice so a reentrant cancel cannot reclassify it ([Ch 12](12-the-inbox.md)).

### The property this preserves

**A cancelled session is resumable.** Balanced turn and step boundaries, every tool call paired with a result, partial output preserved and marked. Reopening it produces a valid request on the first try.

### Where it can still stall

Convergence is **cooperative**. There is no watchdog. A tool ignoring its abort signal delays `whenIdle()` — and therefore disposal — indefinitely ([Ch 13](13-phases-cancellation-quiescence.md)). The timeout-policy plugin bounds individual calls; the engine itself waits.

---

## C · No provider configured — the failure it cannot fix

**The situation.** A fresh install. The user opens the web UI, types a message, and sends it.

This is the most surprising path in the system, and establishing it took reading three composition layers plus two plugins.

### Why there is no provider

**① The native adapter is off.** The base bundle mounts `llm-deepseek`, but the web-app patch disables it:

```yaml
- id: llm-deepseek
  disabled: true
```
— `packages/bundle/web-app/cordis.patch.yml:41-42`

with the comment: "The Web surface exposes only providers declared through the Models settings document."

**② The generic adapter is dormant.** `llm-pi-ai` *is* mounted, but its `providers` dict defaults to `{}` (`llm-pi-ai/src/config.ts:340-342`). Its `ensureRegistrationFacts()` runs once at mount, sees `routes.length === 0`, records the facts and **returns without registering anything** (`llm-pi-ai/src/index.ts:284-287`). The source calls this "the dormant posture."

So with no user configuration, **zero provider routes are registered**.

### The trace

**③ `prepareCall` fails.** `registration(config.provider)` finds nothing → `LlmError('no adapter registered for provider "deepseek-official"', 'NO_ADAPTER')` ([Ch 23](23-adapters-and-preparecall.md)).

**④ The loop tolerates it — narrowly.** `buildRequest` catches **only** `NO_ADAPTER` and proceeds with the unresolved config. `preparedCall` stays `undefined` ([Ch 10](10-building-the-request.md)).

**⑤ The fallback path fails identically.** `preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)` takes the bare call, which does its own registration lookup and throws `NO_ADAPTER` again — caught by the adapter-failure wrapper and turned into a terminal `error` finish chunk.

**⑥ Nothing retries.** The `agent/request-error` waterfall runs. Compaction checks the code — not `CONTEXT_WINDOW_EXCEEDED` — and delegates. `llm-retry` receives `retryPolicy: undefined`, because there was no prepared call to carry one, and its first line is `if (policy === undefined) return next()` ([Ch 25](25-failures-and-retry.md)). Nothing else listens.

**⑦ The turn fails.** The default `undefined` is terminal, so the step throws `LlmError`. `turn()` records `{ kind: 'error', error: failure }`, `throwError` emits `agent/error`, and the driver contains it.

### The fix, and why it is not "re-enable the row"

A disabled Cordis row stays disabled. What makes a route live is a **settings write**:

`llm-pi-ai` installs a settings section named `llm-pi-ai` (`index.ts:296-330`). When the Models page writes it to `$DSH_HOME/settings.yaml` — hot-reloaded by `dsh-settings-file` — the section's `onChange` re-runs `ensureRegistrationFacts()`, which now sees a non-empty route set and calls `ctx.llm.registerAdapter(routes, adapter)` (`:288`). Later changes use `registration.replace(routes)` (`:290`), an atomic same-instance swap.

**No restart, no composition change.** And the failure handling is careful: `registeredFacts` only advances once the registry actually holds the new set, so a rejected update leaves the previous routes serving and returning to a working configuration re-applies (`:274-292`).

### Why this is worth documenting

A reader who knows the default model is `deepseek-v4-flash` ([Ch 23](23-adapters-and-preparecall.md)) would reasonably assume it works out of the box. It does not. The default names a *route*; whether that route is *registered* is a separate question answered by a different layer.

It is also a good demonstration of the composition hazard this book keeps returning to: **the base bundle mounts it, the surface bundle disables it, and a settings document revives it.** No single file tells you the answer.

---

## What the three have in common

| | A · Overflow | B · Cancellation | C · No provider |
|---|---|---|---|
| Recoverable? | yes, automatically | n/a — user-initiated | only by configuration |
| Who handles it | a plugin on an extension point | the loop's own `finally` blocks | nobody |
| Log stays valid | yes | yes | yes |
| Turn ending | `completed` after retry | `aborted` with cause | `error` with a code |

All three leave a **resumable session**. That is the strongest claim the design makes, and each failure path tests a different part of it: A tests that history can be rewritten safely, B tests that boundaries close under abort, C tests that an unhandleable failure is still structured.

---

## Key takeaways

- Overflow recovery is compaction claiming the retry seam — and it only claims it if the surface actually changed.
- A rebuilt request differs in four ways from the one that failed, each traceable to a different mechanism.
- Cancellation drains started tools and synthesizes results for unstarted ones, so a cancelled turn is still a valid conversation.
- Salvaged partial output is marked `interrupted: true` and the error still propagates.
- A fresh install has **no registered provider**; the first turn fails `NO_ADAPTER` and nothing retries it.
- The fix is a settings write that registers routes live, not a change to the disabled row.

## Exercises

1. In path A, compaction runs but the summary is not smaller, so the commit is refused. Trace what happens next and give the turn's ending.
2. In path B, a tool ignores its signal and runs for ten minutes. What exactly is blocked, what still proceeds, and which config bounds it?
3. In path C, suppose `llm-retry` had *not* checked for an undefined policy. Describe the resulting behavior and say why the guard is load-bearing rather than defensive.

**Next:** [Chapter 33 · Adding a tool](33-adding-a-tool.md)
