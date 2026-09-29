# Part IV · The engine in motion

## 31 · One real turn, annotated

`snapshots/session/text-turn/` — prompt: *"Reply with exactly the word: PONG. Do not use any tools."* The smallest complete turn, so every event present is one the engine cannot skip.

**Line numbers are not sequence numbers.** The file has 25 lines but the session has **43 events**, because line 15 is a packed chunk row holding twenty. The mapping is verifiable from the data itself, by two citations produced by different mechanisms at different times: `session/title` carries `messageSeqs: [7]`, and `assistant/message` carries `sourceEventSeqs` spanning **12–39** (28 values, matching `39 − 12 + 1`). Both agree with one arithmetic model — §6's provenance system verifying a reading of itself.

| Line | Seq | Event | Mechanism |
|---|---|---|---|
| 1 | — | `session` header — `version:0`, `delegationDepth:0` | **not an event**; storage metadata (§5) |
| 2–4 | 0–2 | `permission/preset`, `sandbox/mode`, `approval/policy` | three plugins the engine knows nothing about; none surface-eligible |
| 5 | 3 | `agent/inbox/spliced` target `next-turn` | `followup()`; the queue *is* the log (§12) |
| 6 | 4 | `turn/start` turn 1 | turn 1 because `turnBoundary` folded an empty log (§8) |
| 7 | 5 | `agent/inbox/spliced` `removedCount:1` | `claim()` popping **one**; logged *before* `step/start` |
| 8 | 6 | `step/start` | |
| 9 | 7 | `user/message`, `source.kind: 'user'` | the human's prompt, now on the surface |
| 10 | 8 | `user/message`, `source.plugin: dsh-system-prompt`, `form:'snapshot'` | **the runtime-context snapshot** (§21) |
| 11 | 9 | `session/title`, `source.kind:'fallback'`, `messageSeqs:[7]` | a plugin; same provenance discipline |
| 12 | 10 | `request/header`, `reason:'initial'` | first request of this instance over a log with no header (§10) |
| 13 | 11 | `request/context` | |
| 14 | 12 | `assistant/chunk` `block-start` idx 0 `reasoning` | |
| 15 | 13–32 | **20 packed** `reasoning-delta` | one storage row (§30) |
| 16 | 33 | `block-start` idx 1 `text` | **blocks interleave** — 1 opens before 0 closes |
| 17–18 | 34–35 | `text-delta` `"P"`, `"ONG"` | |
| 19–20 | 36–37 | `block-end` idx 0, idx 1 | authoritative closes (§24) |
| 21 | 38 | `usage` — 3091 in / 23 out / 20 reasoning | |
| 22 | 39 | `finish` `{kind:'stop'}` | |
| 23 | 40 | `assistant/message`, `sourceEventSeqs:[12…39]` | cites **all 28** chunk events |
| 24–25 | 41–42 | `step/end`, `turn/end` `{kind:'completed'}` | no tool calls → completed (§9 ⑨) |

Line 10 is the single best illustration in the book. That message: was produced because `retained === undefined` and context was non-empty; entered as the **innermost default** of `agent/pre-step`, so every listener inherited it by delegating; carries the two sections lines 3–4 caused, each attributed to its plugin; and was appended as an ordinary `user/message` — **indistinguishable from line 9 except by its source tag**. Its second section reads *"do not request sandbox escalation (do not set `sandbox_permissions`)"* — the policy from line 4 enforced *and explained*, so the model does not waste a turn on something auto-rejected (§18).

**The cost:** 43 events, 2 surface nodes, 2 messages sent, 1 model call, **3,091 input tokens for a 23-token answer** — almost all of it system prompt and 35.5 KB of tool schemas, for a request told not to use tools. That is the standing price of a stable catalog, and the reason it *stays* stable (§15).

## 32 · When things go wrong

### A · Context overflow — recovers

Adapter throws → `normalizeLlmFailure` recognizes the provider's text → `CONTEXT_WINDOW_EXCEEDED` → terminal `error` finish → `agent/request-error` waterfall → **compaction claims it**, skipping the threshold entirely (the provider already answered) → prune first, re-measure → if needed, lock, select a tool-pair-balanced range retaining ~16%, summarize replaying the same prefix, refuse if not smaller, commit as `replace` → return `{kind:'retry'}` **only if `replaceGeneration` advanced** → `continue` rebuilds the request.

**Four things differ in the rebuilt request:** the derived cache rebuilt (§7); the header logs `series` despite identical bytes (§10); the runtime-context snapshot may re-inject (§21); the prepared call is new, the old one being single-use (§23). Capped at `maxOverflowRetries` (default 1).

### B · Cancellation mid-stream — unwinds cleanly

`cancel(cause)` clears the inbox and the latch, then aborts. Partial output is salvaged via `interruptedBlocks()` and logged `interrupted: true`, then the error rethrows. **In-flight tools drain** and commit in model order; **unstarted calls get synthetic `ABORTED_BEFORE_DISPATCH` results** so replay stays valid. The turn records `{kind:'aborted', reason}` — the cause, not just the fact. `step/end` and `turn/end` come from `finally` blocks, so the log stays balanced. A message arriving in the aborting window is retargeted to `next-turn`, classified *before* the splice.

**The property preserved: a cancelled session is resumable** — balanced boundaries, every call paired with a result, partial output kept and marked. **Where it can still stall:** convergence is cooperative with no watchdog.

### C · No provider configured — cannot be fixed by the engine

The most surprising path, and it took three composition layers plus two plugins to establish.

`llm-deepseek` is `disabled: true` in web (`web-app:41-42`) — *"The Web surface exposes only providers declared through the Models settings document."* `llm-pi-ai` **is** mounted but its `providers` dict defaults to `{}`, so `ensureRegistrationFacts` sees `routes.length === 0`, records the facts and **returns without registering anything** (`:284-287`) — the documented "dormant posture."

So: **zero routes registered.** `prepareCall` throws `NO_ADAPTER` → `buildRequest` catches *only that code* and proceeds unresolved, `preparedCall` stays `undefined` → the fallback `llm.stream` throws `NO_ADAPTER` again → terminal error chunk → compaction delegates (wrong code) → **`llm-retry` receives `retryPolicy: undefined` and its first line is `if (policy === undefined) return next()`** → nothing else listens → the turn fails.

**The fix is a settings write, not re-enabling the row.** `llm-pi-ai` installs a settings section whose `onChange` re-runs `ensureRegistrationFacts`, which on the first non-empty profile set calls `registerAdapter` (`:288`); later changes use `registration.replace(routes)`, an atomic same-instance swap. No restart, no composition change. And `registeredFacts` only advances once the registry actually holds the new set, so a refused update **keeps the previous routes serving**.

| | A · Overflow | B · Cancellation | C · No provider |
|---|---|---|---|
| Recoverable | automatically | n/a — user-initiated | only by configuration |
| Handled by | a plugin on an extension point | the loop's own `finally` blocks | nobody |
| Log stays valid | yes | yes | yes |
| Turn ending | `completed` after retry | `aborted` with cause | `error` with a code |

All three leave a **resumable session** — the design's strongest claim, each path testing a different part of it.

# Part V · Extending and changing

## 33 · Adding a tool

Six decisions determine whether a tool behaves correctly under replay, cancellation, concurrency, and compaction.

| Decision | Getting it wrong costs |
|---|---|
| What is the canonical **value**? | replay cannot re-render; the UI has nothing structured |
| **Concurrency-safe?** | data races, or needless serialization |
| Needs **approval**? | a security hole, or an unusable tool |
| **Host plane or preset?** | a service collision, or an invisible registry |
| What does it **present**? | a wall of text where a diff belongs |
| Should it **conclude the turn**? | almost always no |

**Value, not prose.** `bash` returns `{kind:'foreground', exitCode, signal, timedOut, …}` so a UI can parse the exit code into a pill and replay re-renders without re-running; `str_replace_editor` returns a bare string and gives that up. Rule: if any consumer might branch on part of the result, it belongs in the value. And `value` is **never persisted** — use `meta` for replay-time data.

**Placement**, from the preset's own comments: a row that **publishes a service** must sit in an `isolate` realm or it becomes process-global and collides; a **registry something outside the preset reads** belongs to the host plane. Worked cases — `tools`/`skill`/`jobs`/`subagents` registries and `token-meter` are host-plane; `tool-bash`/`tool-fs`/`tool-web` are preset rows that register *into* the host registry and publish nothing, so need no realm; `compaction-basic` + `tool-result-pruner` share one realm because the engine reads the pruner via `ctx.get`; `plan-mode` gets its own because plan state is per-agent by nature. **Default for a new tool: a preset row registering into a host registry, publishing nothing.**

**Presenters must be pure functions of their arguments** — they run against historical arguments during replay. **Thread `exec.signal`** into anything that can block; a tool ignoring it delays cancellation with no watchdog to save it.

Also reachable: `exec.deferContext(message)` → a message for the *next* step; `exec.concludeTurn()`; `meta` for replay-time presentation data; `finalizeContent` for content even when the pipeline bypasses post-execute; `timeoutMs`, cooperative and never shown to the model.

## 34 · Composition in full

```
apps/server/src/index.ts  (profile: 'web' hardcoded, --profile refused)
  → composeProfile → prepareProfile writes cordis.yml = "[]"
  → boot: new Context() → ctx.plugin(Loader) → mountRootInclude
  → Include[Service.init] → applyEntryPatches → EntryGroup.update (every row CONCURRENTLY)
  → Entry._start → registry.plugin → new Fiber → new AgentLoop(ctx, config)
```

**The patch stack**, in fixed order (`profile-boot.ts:136-143`): each bundle's `cordis.patch.yml` in `bundles` order → the profile's own → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays.

**The patch algebra** (`vendor/include/src/index.ts:58-128`): `insert` with no `id` appends top-level; `insert` with an `id` appends into that group's config; `{id, ...overrides}` copies each override key onto the row —

```ts
for (const [key, value] of Object.entries(overrides)) target[key] = value
```

**`config` is replaced wholesale, not merged.** A later layer restating `config:` discards every key the earlier set — which is why the preset restates the pruner's budgets identically rather than relying on the base. Inserted rows are indexed **immediately**, so a later patch in the same list can target a row an earlier patch just added.

**Row order is not load order**: rows create concurrently, and a fiber activates only when its `inject` dependencies resolve.

**`!!js`** is a tagged scalar parsed to inert `{__jsExpr: "<source>"}` (`include:9-23`). `!!foo` is YAML shorthand for `tag:yaml.org,2002:foo`; a single `!js` would not match the custom Type at all — the repo's rule is mechanical, not stylistic. Evaluation is **lazy and per row** via `internal/config`, **skipping tree-carrier plugins** whose config is entry lists and must stay literal. The evaluator:

```js
export const evaluate = new Function('ctx', 'expr', `with (ctx) { ... `)
```
— `vendor/loader/src/config/utils.ts:5-6`

Free identifiers resolve against the row's own context — which is why `ctx.webStartup.host` works in a row that injects `webStartup`, and why an unresolvable identifier throws rather than yielding `undefined`. It also means **`!!js` is arbitrary code at config-load time**, putting `cordis.patch.yml` in the same trust class as the code it composes.

### Two unrelated isolation mechanisms

**Isolate realms** (Cordis/Loader, `config/isolate.ts`) remap *which symbol a name resolves to* for one entry's subtree. `isolate: {x: true}` mints a `LocalRealm` (suffix `'#'+id`); a string label mints a `GlobalRealm` (`'@'+label`) shared by every entry naming it — but a shared label does **not** pool instances: `provide()` throws on a second registration under the same realm symbol. Labels *join* realms.

The key property: a service published with **no** `isolate:` is visible process-wide because its context inherits the root's symbol table unchanged. **Visibility is the default; a realm is an opt-in narrowing, never a widening.** `mountPreset` enforces it — `leakedServices()` flags any implementation stored at the *root's* symbol, so a row that forgot its realm **fails session creation loudly**.

**Scope parentage** (`packages/core/scope`) is application-level, built from `ctx.extend()`, a private `WeakMap`, and Cordis's listener-filter hook — it never touches `Context.isolate`. It provides event routing (`scopeTarget`) and registry layering (`ScopedLayers.merge` = global + chain, nearest wins). **One relation, `scopeParents`, with two consumers.**

### Agent presets

`ensureStanding(preset)` (`agent-presets/src/index.ts:747-795`) keys a single-flight map by preset id — and also stamps the composition **file's mtime/size** on every call, evicting and creating a **new generation** if it changed. So the file comment's "mounted once per process" is more precisely **"once per (preset id, on-disk file generation), single-flighted and lazily created on first use."** A live-edited preset forks a generation; sessions already joined keep theirs.

`mountPreset` does `agentCtx.plugin(PresetTree, config)` (`PresetTree extends Include`) — plugged directly, not through a Loader entry — then verifies every row activated and no row leaked a service.

Joining is the cheap part. `AgentPresets.mount` is called from the factory's `setup` hook (§14) and does:

```ts
this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))
```

**One `WeakMap` entry.** No new fiber, no new plugin instance, no module re-import — and because that same link drives both event routing and `ScopedLayers`, the agent immediately sees the preset's tools, sections, and scoped services.

`serviceForAgent` (`mount.ts:259-293`) is a deliberate backdoor for host code needing to read *inside* an agent's realm-private service: it walks the reflect store testing **fiber-tree membership** rather than using the isolate map — bypassing realm invisibility by using a different addressing scheme.

### Reading a composition correctly

1. **base** — what exists at all. 2. **web-app patch** — `disabled: true` rows, and `config:` replacing wholesale. 3. **the preset** — re-mounts most of what layer 2 disabled, sometimes with *different* config. 4. Check for **`!!js`**. 5. Check for **mounted-but-dormant** (`openAt: never`, empty `providers`).

Skipping step 3 produces confident wrong answers: compaction, subagents, skills, plan mode, and most tools all look disabled after step 2.

### The vendored framework

`cordis` **4.0.0-rc.7** from `cordiverse/cordis@56b3d4f7` (core + loader); the companions from a **private fork**, `deepseek-harness/cordis@abb0a307`. `vendor/README.md` logs 19 local modifications and asserts the log is exhaustive.

✅ **Audited: the log is accurate — no contradictions, no omissions.** Thirteen items were diffed against the exact pinned baseline. The strongest is item 7, which claims the JSDoc enrichment across seven files is "comment-only; no code changes" — stripping comments leaves **zero functional differences**, every residual being an import rewrite items 4/10/17 already declare or linter whitespace. Item 19 is a genuine bug fix: upstream classifies Node's module loader by `major >= 24`, but the v2 interface landed in **24.12.0**, so 24.0–24.11.1 are mistagged; the vendored copy probes for the actual API.

⚠️ Five items (1, 9, 12, 13, 14) target the private fork, so they were checked for *presence* — all present and matching — but "present here, absent from cordiverse" cannot separate a harness change from a fork change. **This is the one claim in the book unverifiable in this environment.**

## 35 · Limits and fragile areas

1. **The token meter is not a tokenizer.** 4 chars/token, no BPE, nothing provider-specific — wrong in both directions for code, CJK, and long identifiers. Compensated by preferring real usage after one success and by the 80% threshold. Bites hardest when a session's *first* request is already near the window (a large seeded fork), where no usage exists to anchor on.
2. **`maxParallelToolCalls` is deployment-wide.** No per-agent or per-tool cap; ten parallel file reads and ten parallel network fetches get the same budget, and each subagent inherits it.
3. **Sibling effects tear down concurrently.** Disposers *nested inside one* effect are strict LIFO, but a whole-fiber unload runs all top-level ones with `Promise.all` (`fiber.ts:675-696`). `AgentLoop` registers exactly two; their relative order is undefined.
4. **`ctx.emit()` does not contain listener failures.** One synchronous throw aborts the rest. The agent dispatcher works around it per-call-site; anything calling `ctx.emit()` directly inherits the hazard.
5. **Provider errors are classified by regex on vendor prose.** If a provider rewords its message, `CONTEXT_WINDOW_EXCEEDED` stops being produced and the symptom is *turns failing where they used to recover*, with nothing in the harness changed. **The most fragile behavior-critical coupling here.**
6. **Cancellation has no watchdog.** A tool ignoring its signal blocks `whenIdle()` → agent disposal → factory teardown (which `Promise.all`s every live agent). One unresponsive tool can stall shutdown indefinitely.
7. **`always` retry mode is unbounded** — no code gate, no cap; and its fall-through reads as if it returns early when downstream declines, and does not.
8. **Runtime invariants ship switched off** — so the central guarantee is enforced only in CI. Filters also compile once at startup; changing them needs a plugin reload.
9. **`agent/turn-stopping` has zero live listeners** — the first plugin to use it exercises an untested path.
10. **No working install out of the box** (§32) — the first failure a new user sees is one the engine cannot handle.
11. **No session-format migration path.** `SESSION_FORMAT_VERSION = 0`; mismatches refused in both directions; a structural change would strand every existing session.
12. **Acknowledged in-source:** `TODO(call-config-shape)` flags `LlmCallConfig` as unsettled — and it *is* the header's `config`, so changing it touches log compatibility; `DSH_TOOLS_MODE` is called a **"TEMPORARY workaround"** standing in for per-session selection; continuable fork invalidates the cache prefix forking exists to preserve.
13. **Smaller edges:** `str_replace_editor` is exclusive even for `view`; a live-edited preset forks a generation; the invariant's `JSON.stringify` comparison is key-order sensitive; a raw `ToolDefinition` gets no argument validation; **spill files are swept by `mtime` alone**, so a session resumed after 30 days holds dead locators (§26).

## 36 · Design decisions

**ADR-1 · The log is the single source of truth.** *Alternatives:* an in-memory array persisted periodically (resume needs separate serialization, fork needs deep copy, replay needs a drifting fixture format); log + synchronized cache (two sources that can disagree — and the disagreement surfaces as a session replaying differently than it ran). *Tradeoffs:* 43 events for a one-word turn, and a compression codec had to be written; derivation runs per request, needing an incremental cache with a generation guard. **Bought:** resume/fork/compaction/replay as one operation, and a correctness property that is *checkable*.

**ADR-2 · Rewrite by superseding, never mutating.** *Alternatives:* delete old events (contradicts ADR-1, user's scrollback loses content they saw); rewrite in place (breaks provenance — nothing can say what a summary stands for). *Tradeoffs:* an indirection every reader must learn, plus real provenance rules. **Bought:** compaction is a normal append with no special write path, and `replaceGeneration` gives four mechanisms a precise "history changed" signal.

**ADR-3 · Registrations are effects.** *Alternatives:* explicit `unregister(name)` (callers must remember names; double-unregister becomes a bug class); GC on plugin unload (the framework would need to know every registry — inverting the dependency the plugin system exists to avoid). *Tradeoff:* the concurrent-sibling-teardown nuance. **Bought:** teardown structurally correct by default; `provide()` is an effect too, so *un-providing* becomes a synchronization point.

**ADR-4 · The agent plane moves behind presets.** *Alternatives:* one global composition (every session identical); a full plugin tree per session (fresh imports and fibers each time, and every process singleton duplicated and colliding). *Tradeoffs:* the hardest thing here to read correctly, plus two similarly-named isolation mechanisms. **Bought:** the marginal cost of a session joining a preset is **one `WeakMap` entry**, and `mountPreset` mechanically rejects a leaked service.

**ADR-5 · Retry is an extension point.** *Alternatives:* retry in the loop (one policy shape for every deployment, and compaction-on-overflow would need a separate hook anyway); retry in the adapter (invisible to the log, so no durable budget, and compaction could not participate). *Tradeoffs:* no retries unless something is mounted; the loop cannot bound them. **Bought:** compaction and retry compose on one seam without knowing about each other — and because a retry rebuilds from the log, a listener can *change history* and have the rebuilt request pick it up. That falls out of ADR-1 rather than being designed.

**ADR-6 · `policy: 'never'` is not delegatable.** *Alternative:* a prepended listener — but "prepended" is only a position, and another listener can also prepend; correctness would depend on mount order. *Tradeoff:* an asymmetry a reader must notice. **Bought:** a guarantee no configuration can defeat. It pairs with the opposite use of the same insight — §11 uses `prepend: true` precisely *because* a short-circuiting listener could silence it. The codebase knows ordering is unreliable and reasons about it in both directions.

**Two principles recur.** *Make the correctness property checkable* — ADR-1 produces an assertion, ADR-4 produces `leakedServices()`, ADR-6 produces an undefeatable guarantee. *Prefer loud failure over quiet degradation* — unknown event types refuse a session, a malformed chunk row throws, a leaked service fails mount, an unanswerable approval is denied. The exceptions are narrow and deliberate: spill keeps the original on failure, presenters swallow invalid historical arguments, `emit` listener failures are contained.

# Part VI · Rebuild it

## 37 · A milestone path

Ten milestones in dependency order. **Milestones 1–7 need no plugin framework at all** — build the loop against concrete dependencies and extract seams once you know where they belong.

| # | Build | Real files | Test it | The trap |
|---|---|---|---|---|
| 1 | Event log: `append(type, data)`, `seq = log.length`, frozen, deep-snapshotted | `core/session/src/index.ts:602-653` | 10 events → seq `0..9`, no gaps; mutating your input doesn't change the log | storing a reference instead of a snapshot |
| 2 | `deriveMessages()` — project 3 types, skip the rest | `surface.ts:83-114`, `index.ts:724-745` | boundaries absent from the result | adding formatting here instead of at append time |
| 3 | The ~100-line loop with a mock adapter | `agent-loop/src/agent.ts:219-438` | ordered events; the mock received exactly `deriveMessages()` | keeping `this.messages` alongside the log |
| 4 | Tool calls: append `tool/call`, execute, append `tool/result` citing it | `tool-calls.ts`, `tools/index.ts:1028-1053` | two steps; second request contains the result | forgetting `null` means *continue* |
| 5 | The surface: `nodes`, `replaceGeneration`, mandatory `surfaceOp`, `replace` as splice | `surface.ts` | 5 msgs → replace middle 3 → 3 nodes, **all 5 still in the log** | letting a replacement cite less than it shadows |
| 6 | `BlockAssembler` keyed by index; `block-end` authoritative; drop tool calls on `max-tokens` | `llm/src/assembler.ts` | interleaved chunks assemble; truncated call dropped | keying by arrival order |
| 7 | Cancellation: per-turn `AbortController`, salvage partials, drain started tools, synthesize results for unstarted | `agent.ts:143-232`, `tool-calls.ts:238-260` | log **balanced**; a fresh request from the cancelled session is valid | abandoning unstarted calls — this is where "resumable" becomes true or false |
| 8 | Inbox: two queues as replayed events; claim all of `next-step`, one of `next-turn` | `agent/src/inbox.ts` | `inject` on idle → **no turn starts** | making the queue a plain array |
| 9 | Prompt sections with orders; `waterfall(listeners, payload, default)`; convert step logic to `agent/pre-step` | `system-prompt:536-611`, `cordis/events.ts:234-243` | a listener not calling `next()` suppresses the default | assuming listeners always delegate |
| 10 | Compaction: threshold, tool-pair-balanced range, summarize, commit as `replace`, refuse if not smaller | `compaction-basic/src/region.ts:154-256` | surface shrank, **log did not**; a second compaction of a terse session is refused | splitting a tool-call/result pair |

Result: ~1,500–2,000 lines that resume, fork, cancel cleanly, and compact. Everything beyond — the four-stage tool pipeline, parallel scheduling, adapters, retry, spill, subagents, persistence, presets — is genuinely optional. **None of it is needed to demonstrate the central property**, which is the strongest evidence that the property is the design rather than a consequence of the size.
