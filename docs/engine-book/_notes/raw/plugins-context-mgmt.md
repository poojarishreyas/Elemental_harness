# Context-window management and orchestration plugins — raw research notes

Scope: `packages/compaction/**`, `packages/spill/**`, `packages/subagent/**`,
`packages/hooks/**`, `packages/skill/**`, `packages/workflow/**`,
`packages/jobs/**`, `packages/schedule/**`, `packages/todo/**`,
`packages/plan/**`, `packages/goal/**`, plus whichever extension points on
`packages/core/agent-loop` these packages actually use.

All line numbers are as read on 2026-09-21. Paths are relative to the repo
root `C:\Users\shrey\desktop\Elemental_harness` unless stated otherwise.

---

## 0. How composition actually works (read this before the table)

The `web` profile is not one `cordis.yml`. `packages/boot/app-boot/src/profile.ts`
resolves `PROFILE_TEMPLATES.web.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']`
(`packages/boot/app-boot/src/profile.ts:137-142`) and composes their patch
layers with `composeEntries()` (`profile.ts:830-837`), last-write-wins per row
`id`. There is a **third** composition layer the two bundle patches do not
show: `packages/preset/agent-presets`, which the web-app bundle mounts
(`packages/bundle/web-app/cordis.patch.yml:451-456`, `id: agent-presets`,
`config.default: standard`) and which re-mounts a whole second agent-plane
composition **per session**, from
`packages/preset/agent-presets/presets/standard/agent.cordis.yml`, via
`mountPreset()` (`packages/preset/agent-presets/src/mount.ts:378-433`), which
does `agentCtx.plugin(PresetTree, config)` where `PresetTree extends Include`
(`mount.ts:58-124`) — i.e. it plugs the preset's own entry tree directly under
the agent's scope context.

So the real answer to "is X mounted in the default web session" requires
three layers, net effect last:

| id | `dsh-base` (`packages/bundle/base/cordis.patch.yml`) | `dsh-web-app` (`packages/bundle/web-app/cordis.patch.yml`) | `standard` preset (`packages/preset/agent-presets/presets/standard/agent.cordis.yml`) | **Net effect in a default web session** |
|---|---|---|---|---|
| `compaction-basic` | mounted, `auto` defaults true (base:326-327) | `disabled: true` (web-app:392-393) | re-mounted inside `isolate:{compaction:true, toolResultPruner:true}` group (preset:137-155), no config override → schemastery defaults apply | **LIVE**, defaults (`thresholdRatio 0.8`, `retainRatio 0.16`, `auto true`) |
| `command-compact` | mounted (base:331-332) | `disabled: true` (web-app:395-396) | re-mounted in same group (preset:147-149) | **LIVE** |
| `tool-result-pruner` | mounted, `thresholdChars 8192/head 4096/tail 1024` (base:404-409) | `disabled: true` (web-app:398-399) | re-mounted, same config (preset:150-155) | **LIVE**, same budgets |
| `subagent` (registry) | mounted (base:334-335) | not disabled — stays host-plane | n/a (registry is host-plane by design, comment at web-app:401-406) | **LIVE**, one process-wide registry |
| `subagent-spawn-in-process` / `subagent-fork-in-process` | mounted, providerName `spawn`/`fork` (base:337-345) | not disabled | n/a (host-plane) | **LIVE** |
| `tool-subagent` (spawn) | mounted, `backgroundMode: continuable` (base:355-360) | `disabled: true` (web-app:414-415) | re-mounted, `modelSelectionSettings:true`, `backgroundMode: continuable` (preset:186-192) | **LIVE**, continuable |
| `tool-subagent-fork` | mounted, `backgroundMode: one-shot` (base:368-373) | `disabled: true` (web-app:417-418) | re-mounted, **`backgroundMode: continuable`** (preset:198-203) — differs from base | **LIVE**, continuable (preset value wins, not base's one-shot) |
| `workflow-worker-thread` / `tool-workflow` | mounted, provider `spawn` (base:379-386) | `disabled: true` (web-app:426-430) | re-mounted inside `isolate:{workflowEngine:true}` (preset:205-211) | **LIVE** |
| `tool-ralph` | mounted, `maxRounds:64` (base:422-427) | `disabled: true` (web-app:432-433) | re-mounted, same config (preset:213-217) | **LIVE** |
| `plan-mode` | mounted (base:307-321) | `disabled: true` (web-app:382-383) | re-mounted inside `isolate:{planMode:true}` (preset:104-124) | **LIVE** |
| `tool-todo` | mounted, `allowParallelInProgress:true` (base:411-414) | `disabled: true` (web-app:438-439) | re-mounted, same config (preset:224-227) | **LIVE** |
| `skill` (registry) | mounted (base:279-280) | not disabled — host-plane registry | n/a | **LIVE** |
| `skill-filesystem` | mounted (base:282-283) | `disabled: true` (web-app:367-368) | re-mounted (preset:83-84) | **LIVE**, per-preset local discovery |
| `tool-skill` | mounted (base:289-290) | `disabled: true` (web-app:370-371) | re-mounted (preset:86-87) | **LIVE** |
| `skill-badge` | mounted **`disabled: true`** in base itself (base:285-287) | not mentioned | not mentioned | **NOT MOUNTED** anywhere in web |
| `command-goal` / `tool-goal` | mounted (base:298-306, 418-419) | `disabled: true` (web-app:376-380) | re-mounted (preset:94-98) | **LIVE** |
| `goal` (service) / `goal-round-driver` | mounted (base:298-303) | not disabled — host-plane | n/a | **LIVE** |
| `tool-web` | mounted, **`fetch:false`** (base:464-468) | `disabled: true` (web-app:441-442) | re-mounted, **`fetch:true`** (preset:231-235) | **LIVE**, `fetch:true` wins (preset value) |
| `tool-jobs` | mounted (base:260-261) | `disabled: true` (web-app:346-347) | re-mounted (preset:73-74) | **LIVE** |
| `jobs` (`dsh-jobs-local`, registry) | mounted (base:81-82) | not disabled — host-plane | n/a | **LIVE**, one process-wide registry |
| `agent-instructions` | mounted, `maxBytes 65536` (base:274-277) | `disabled: true` (web-app:435-436) | re-mounted, same (preset:30-33) | **LIVE** |
| `token-meter` | mounted (base:323-324) | not disabled — host-plane (deliberately, comment web-app:385-390) | n/a | **LIVE**, one process-wide meter |
| `spill-local` / `spill-policy` | mounted, `maxInlineBytes 50000` (base:390-396) | **not mentioned in web-app at all** | not in preset either | **LIVE**, host-plane, base values stand (`50000` bytes) |
| `tool-bash` / `tool-pwsh` / `tool-fs` / `tool-fs-search` / `tool-str-replace-editor` | mounted (base, platform-gated) | `disabled: true` (web-app:330-356) | re-mounted (preset:44-62), **`tool-str-replace-editor` is NOT re-mounted by the preset** | shell/fs tools **LIVE**; `tool-str-replace-editor` **NOT MOUNTED** in the standard preset (still disabled from web-app, preset roster omits it) |
| `hooks-claude-code` / `hooks-codex` | **never appears in base or web-app** | **never appears** | **never appears** | **NOT MOUNTED** — only example configs and tests reference these packages |
| `dsh-schedule` | **never appears in base or web-app** | **never appears** | **never appears** | **NOT MOUNTED** — only `apps/server/config/examples/schedule/cordis.yml` and its own tests |

Verified: `packages/bundle/web-app/cordis.patch.yml:441-442` disables `tool-web`
with no override on that row (base's `fetch:false` config is irrelevant once
disabled); the *live* config a default web session actually runs with is the
preset row at `packages/preset/agent-presets/presets/standard/agent.cordis.yml:231-235`
(`fetch: true`). Likewise `tool-subagent-fork`'s live `backgroundMode` is
`continuable` (preset:198-203), not the base bundle's `one-shot` (base:368-373)
— the base value never reaches a web session because web-app disables that row
outright (web-app:417-418) and the preset re-declares it from scratch.

`mountPreset()` additionally *rejects* the mount if any row publishes a
service outside its `isolate` realm (`leakedServices()`,
`packages/preset/agent-presets/src/mount.ts:210-224`, checked at
`mount.ts:407-413`) or if any row never reached a usable state
(`inactiveRows()`, `mount.ts:304-322`, checked at `mount.ts:403-406`) — so a
misconfigured preset fails session creation loudly rather than silently
running with a partial agent plane.

---

## 1. COMPACTION

### 1.1 What triggers it

Two triggers, both wired in `BasicCompactionEngine._registerAutomaticCompaction()`
(`packages/compaction/compaction-basic/src/index.ts:138-225`), gated by
`config.auto` (default `true`, `packages/compaction/compaction-basic/src/config.ts:95`):

1. **Step-boundary pressure.** A listener on the `agent/pre-step` waterfall
   (`compaction-basic/src/index.ts:148-166`) calls
   `this.compactIfNeeded(agent, 'pressure', signal)` before delegating to
   `next()`. This runs on *every* proposed step, not on a timer.
2. **Context-overflow recovery.** A listener on `agent/request-error`
   (`compaction-basic/src/index.ts:180-224`) fires only when
   `failure.code === CONTEXT_WINDOW_EXCEEDED_CODE` (imported from
   `@deepseek-ai/dsh-llm`, i.e. the provider itself reported the window was
   exceeded). It calls `compactIfNeeded(agent, 'context-overflow', signal)`
   and, if the surface's `replaceGeneration` actually advanced, returns
   `{ kind: 'retry' }` to the agent loop's request-error extension point
   (`index.ts:219-223`) — i.e. compaction here causes the very same LLM
   request to be re-issued against the now-smaller history. Retries are capped
   by `maxOverflowRetries` (default `1`, `config.ts:93`) tracked per-agent in
   `this.overflowRetries` (a `WeakMap<Agent, number>`), reset on the next
   `assistant/message` session event (`index.ts:174-178`) or when the agent
   goes idle (`agent/status` listener, `index.ts:168-170`).

### 1.2 Extension points it hooks

- `agent/pre-step` (waterfall) — pressure check, always calls `next()`
  (`index.ts:165`), so it never itself rejects a step; it only mutates history
  as a side effect before the step proceeds.
- `agent/request-error` (waterfall) — overflow recovery; returns
  `{ kind: 'retry' }` or delegates to `next()`.
- `agent/status` (emit) — clears retry counters when `status === 'idle'`.
- `session/event` (emit, from `dsh-session`) — clears retry counters on
  `assistant/message`.

Both `agent/pre-step` and `agent/request-error` are extension points on the
agent loop named exactly as given in the task brief, confirming compaction is
implemented entirely as a plugin outside `packages/core/agent-loop`.

### 1.3 How it decides it is needed

`compactIfNeeded()` (`compaction-basic/src/index.ts:259-333`):

1. Resolves the *durable routed* provider/model for the session
   (`routedTarget()`, reads `session.requestHeader()?.config`,
   `index.ts:53-61`) — if no request has ever been routed yet, it returns
   `null` (nothing to measure against).
2. Resolves a per-target policy (`resolveTargetPolicy`,
   `packages/compaction/compaction-basic/src/config.ts:105-125`) that lets a
   deployment override thresholds for an exact `provider/model` pair via
   `modelPolicies` (none configured in web's default composition, so the
   top-level defaults apply everywhere).
3. Calls `ctx.tokenMeter.measure(agent.session)` (`TokenMeter` service,
   `@deepseek-ai/dsh-token-meter`, injected via `static inject = ['llm',
   'tokenMeter', 'sessions']`, `index.ts:105`) to get a `TokenMeasurement`
   (per-surface-node token counts).
4. **For `pressure`:** resolves the model's real context window via
   `ctx.llm.resolveModelInfo(provider, model, signal)` (`index.ts:294`),
   computes `thresholdTokens = floor(contextWindow * thresholdRatio)` (default
   `thresholdRatio = 0.8`, `config.ts:20`) via `resolveCompactSpec()`
   (`config.ts:133-167`), and only proceeds if
   `measurement.totalTokens >= spec.thresholdTokens` (`index.ts:305,313`).
   So: **token counting via a token-meter estimate against a fixed 80%-of-
   context-window threshold**, not a hardcoded token count and not a wall-clock
   or turn-count trigger.
5. **For `context-overflow`:** the threshold check is skipped entirely — the
   provider already said the window was exceeded, so it unconditionally tries
   to shrink (`index.ts:284-291`).
6. Before summarizing, it *optionally* runs the model-free
   `ctx.get('toolResultPruner')` (`ToolResultPruner` from
   `dsh-compaction-tool-result-pruner`, an independently loadable sibling —
   see §1.5) and re-measures (`index.ts:282-291,309-313`). This is a cheap
   first pass that can bring the session back under threshold without any LLM
   call at all — if it does, `compactIfNeeded` returns without summarizing.

### 1.4 What it does to the message history

The real work is `compactSurfaceRegion()`
(`packages/compaction/compaction-basic/src/region.ts:154-256`), invoked via
`compactRegion()` (`index.ts:344-359`). It is a **single durable transaction**
recorded directly in the append-only session log — compaction does not
"rewrite" the log file, it *appends* new log events that the session's replay
projects into a smaller effective surface:

1. `selectCompactableRange()` (`region.ts:100-136`) walks the surface nodes
   from the end backward, accumulating token counts until at least
   `retainTokens` (default `16%` of context window, `retainRatio = 0.16`,
   `config.ts:23`) is preserved verbatim, then walks forward from that cut
   point to the nearest boundary that does not split a tool-call/result pair
   (`toolPairingBalancedBefore`, from `@deepseek-ai/dsh-compaction`). This
   yields an inclusive `[start, end]` seq range of the OLDEST messages to
   shadow, always retaining the most recent messages.
2. `session.append('compaction/start', { compactionId, turn })`
   (`region.ts:191`) is written **synchronously**, before any async
   summarization work — this is the durable lock: `assertCompactionInactive`
   rejects a second concurrent compaction while one `compaction/start` has no
   matching `compaction/end` (`region.ts:288-300`, checked again after any
   `await` at `region.ts:307-314`).
3. `prepareCompaction()` snapshots the exact token-priced nodes in range
   (`region.ts:341-364`) and `buildSummarizationInput()`
   (`region.ts:508-524`) replays the **conversation's own last routed system
   prompt, tools, and the shadowed messages verbatim** — deliberately reusing
   the same prefix as the last real request so the provider's KV/prefix cache
   is not invalidated by the auxiliary summarization call.
4. **It does call an LLM.** `summarizeWithLlm()`
   (`packages/compaction/compaction-basic/src/summarizer.ts:121-182`) appends
   one final synthetic user message containing a fixed
   `COMPACTION_INSTRUCTION` prompt (`summarizer.ts:31-66`) asking the model to
   produce a structured Markdown checkpoint with sections "Primary Request and
   Intent", "Key Technical Concepts", "Files and Code", "Errors and Fixes",
   "Pending Jobs", "Current Work", "Next Step", "Critical Context"
   (`summarizer.ts:36-58`), then calls `ctx.llm.stream(options)` — one real
   auxiliary generation request (`purpose: 'compaction'`,
   `summarizer.ts:161`), separate from the main turn.
5. The returned summary text is size-checked: if the framed summary's
   estimated token cost is **not smaller** than the shadowed span's, the whole
   compaction throws and nothing is committed (`region.ts:383-388`) — a
   compaction that would not shrink anything is refused.
6. On success, `commitCompactionBody()` (`region.ts:437-488`) appends, in
   order: a `compaction/summary` event recording the summary text, provenance,
   shadowed range/seqs/token count (`region.ts:457-471`); then a
   `user/message` event carrying the framed checkpoint text
   (wrapped by `frameSummary()`,
   `summarizer.ts:189-195`, with `<compacted-summary>` tags) with
   `surfaceOp: { op: 'replace', start, end }` (`region.ts:472-475`) — this is
   the mechanism that actually shrinks the model-visible surface: the session
   replay treats the replaced range as shadowed (excluded from the live
   surface) and substitutes the one synthetic checkpoint message in its place.
   Finally `compaction/end` closes the transaction (`region.ts:217`).
7. So: **compaction never deletes or drops raw log events** (the full
   original messages remain in the append-only JSONL log forever, per the
   repo's "Released Session JSONL... never move, overwrite, or delete
   committed generations" rule in `AGENTS.md:9`); it *shadows* them from the
   live surface by inserting a `replace` surface-op tied to a smaller
   synthesized summary message. This is confirmed by `region.ts`'s
   `SurfaceSelection.shadowedSeqs` bookkeeping and the `surfaceOp: {op:
   'replace', ...}` call shape, and by the module doc comment at
   `region.ts:1-6` ("Surface retention selection and the shared log-recorded
   compaction transaction").
8. Failure handling: if summarization or commit throws after
   `compaction/start` landed, the code still appends a `compaction/end` with
   an `error` field (`region.ts:224-230`) so the durable lock is always
   released, even on failure — `assertCompactionInactive`'s job is only to
   reject a *second* concurrent attempt, not to leave the session stuck.

### 1.5 Relationship to `dsh-compaction-tool-result-pruner`

`ToolResultPruner` (`packages/compaction/compaction-tool-result-pruner/src/index.ts`)
is a **separate, model-free** service (`static inject = ['tokenMeter']`,
`index.ts:47`). `pruneContent()` (`index.ts:83-122`) does deterministic
head/tail character truncation of existing `tool/result` surface nodes whose
text exceeds `thresholdChars` (default `8192`, keeping `headChars=4096` /
`tailChars=1024`, all configured identically in base and the preset — see the
table in §0). `pruneSession()` (`index.ts:136-184`) walks every current
`tool/result` surface node, and for each over-budget one appends a
`compaction/prune` shadow-price event immediately followed by a replacement
`tool/result` event (`surfaceOp: {op:'replace', start:seq, end:seq}`,
`index.ts:162-173`) — same replace-in-place surface mechanism as
`compaction-basic`, but scoped to one tool result at a time, no LLM call, and
callable independently. `BasicCompactionEngine` treats it as optional
(`this.ctx.get('toolResultPruner')`, `compaction-basic/src/index.ts:282`) and
always tries it first, both for pressure and for overflow recovery, before
falling back to LLM summarization (`index.ts:284-291, 309-313`).

### 1.6 Manual compaction (`/compact`)

`dsh-command-compact` (mounted identically to `compaction-basic` in all three
layers — see §0 table) drives `BasicCompactionEngine.compactNow()`
(`compaction-basic/src/index.ts:369-421`), which requires the agent to be
*idle* (`agent.runMaintenance(...)`, throws `ManualCompactionError('busy', ...)`
otherwise, `index.ts:414-420`), selects a range with `retainTokens: 0` (i.e.
compact as much as possible, `index.ts:380-384`), and runs the same
`compactSurfaceRegion()` transaction with `stability: 'selected-span'` instead
of `'whole-surface'` (`index.ts:392`) — a looser stability check that only
requires the *selected span* to remain unchanged during summarization, not the
whole surface, since a human-invoked compaction can race with the agent's own
concurrent activity less strictly than the automatic pressure path.

---

## 2. SPILL

`packages/spill/spill` defines the abstract `SpillStore extends Service`
Service Definition — `ctx.spillStore`, one method `saveText(input):
Promise<SpillRef>` (`packages/spill/spill/src/index.ts:45-58`). It has **no**
retention policy, no tool-result-replacement logic, and no retrieval API of
its own (doc comment, `index.ts:8-13`) — deliberately minimal.

`packages/spill/spill-local`'s `LocalSpillStore` is the concrete host-filesystem
implementation (`packages/spill/spill-local/src/index.ts:65-162`): it writes
the full text to a private (`0700` dir, `0600` file), session-scoped path
under either a configured `root` or a lazily-created OS-temp default
(`privateRoot()`), and returns a `SpillRef` with a path locator and the
retrieval hint `'Use read with offset/limit, or grep this path to search
within it.'` (`index.ts:159`). It also runs one best-effort startup cleanup
sweep for files older than `cleanupPeriodDays` (default `30`,
`index.ts:68`).

`packages/spill/spill-policy`'s `apply()` (`packages/spill/spill-policy/src/index.ts:110-232`)
is the actual **policy plugin** — a prepended listener on the *tools package's*
`tools/post-execute` waterfall (`index.ts:190-209`, note: this is a `dsh-tools`
extension point, not one of the four agent-loop points named in the task) and
on `tools/ptc-dispatch-log` (`index.ts:217-231`). It is a no-op unless
`maxInlineBytes` is configured (`index.ts:113`); in the web profile it is
configured to `50000` bytes in `packages/bundle/base/cordis.patch.yml:393-396`
(`id: spill-policy`), and **is not touched by web-app's disable list at all**
(confirmed absent from `packages/bundle/web-app/cordis.patch.yml`), so it
stays live at the host-plane 50000-byte cap for every web session.

Mechanism: when a *plain-text* tool result exceeds the cap
(`flattenPlainText`, `spill-policy/src/index.ts:80-87`; non-text/multimodal
results are left untouched), it calls `ctx.spillStore.saveText(...)`
(`index.ts:155`) to persist the full text, then replaces the model-facing
result with a bounded head/tail preview (via `TextRetainer` from
`dsh-output-retention`, `index.ts:98-101`) plus a notice line naming the
spill locator and retrieval hint (`spillNotice`, `index.ts:104-108`). It
explicitly skips the `read` tool to avoid a `read → spill → read again` loop
(`index.ts:197`) and is best-effort: any save failure just logs and keeps the
original inline content (`index.ts:156-161`).

**Relationship to compaction:** spill and compaction are independent, layered
defenses against context growth, operating at different times and
granularities. Spill acts **at tool-execution time**, before a result ever
enters the session surface as a full-size message (`tools/post-execute` fires
per call). Compaction (and its sibling the tool-result-pruner) act **on the
session surface itself**, after messages already exist in history, either
proactively at `agent/pre-step` or reactively at `agent/request-error`. A
result small enough to pass the spill cap but which later accumulates with
many others to exceed the *conversation's* pressure threshold is exactly the
case compaction (and the pruner) exist for. There is no code path where spill
calls compaction or vice versa; they compose only through the shared session
event log and the shared `ctx.tokenMeter`.

---

## 3. SUBAGENT

### 3.1 Creation and execution

`SubagentRuntime` (`ctx.subagents`, `packages/subagent/subagent/src/index.ts:197-651`)
is a named-provider registry: `start(name, request)`
(`index.ts:565-577`) resolves a provider by name (e.g. `spawn`, `fork`) and
delegates to `provider.start(resolved)`.

The in-process spawn provider (`packages/subagent/subagent-spawn-in-process/src/index.ts:41-70`)
calls the shared driver `startInProcessRun()`
(`packages/subagent/subagent-in-process-driver/src/index.ts:103-149`), whose
key line is:

```
const handle = await parent.ctx.agents.create({ sessionId: childId, meta: ..., agentOptions: ..., signal, setup })
```

(`subagent-in-process-driver/src/index.ts:133-140`) — **yes, it creates a
genuine nested `Agent` through the same agent factory** (`ctx.agents.create`,
the `dsh-agent` service) every top-level session uses; there is no separate
"lite" subagent execution path. `resolveChildDepth()`
(`packages/subagent/subagent/src/child-agent.ts:49-58`) enforces a recursion
cap (`SubagentDepthError` if exceeded) using the *persisted* parent depth as a
floor, so even a resumed parent cannot escape the cap. The `fork` provider
(`packages/subagent/subagent-fork-in-process/src`, same driver via
`InProcessRunOptions.seed`) differs only by seeding the child session's log
with a copy of completed turns from the parent (`seed?: SessionEvent[]`,
`subagent-in-process-driver/src/index.ts:69-72`), so the child inherits parent
conversation history and can reuse the KV cache — the spawn provider's
`inheritsParentContext = false` (`subagent-spawn-in-process/src/index.ts:50`)
confirms spawn children start with zero parent context.

The child's own composition (tools, prompt sections, delegation scope) is
installed inside its creation window via `applyChildComposition()`
(`packages/subagent/subagent/src/child-agent.ts:199-218`), which — critically —
calls `childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)`
(`child-agent.ts:204`) to **join the parent's own mounted preset**, so a child
spawned under the `standard` preset gets the same tool roster, not an empty
one. It also injects a fixed `SUBAGENT_DELEGATION_CONTEXT` runtime-context
string (`child-agent.ts:171-176`) telling the model its permission scope is
fixed and cannot be widened.

### 3.2 Results flowing back to the parent

`drivePublishedRun()` (`subagent-in-process-driver/src/index.ts:155-206`)
sends the prompt via `child.followup(...)`, awaits `child.whenIdle()`, then
`readResult()` (`index.ts:209-234`) extracts the final assistant output text
from the child's own session events after its activation boundary
(`finalAssistantOutput()`) and maps the turn-end reason to a
`SubagentStopReason` (`completed | max-tokens | aborted | refusal | error`,
`toStopReason()`, `index.ts:49-66`). That `SubagentResult` is what the calling
tool receives as its tool-call result. For *continuable* children (background
mode), results instead flow back through `SubagentContinuationManager`
(`packages/subagent/subagent/src/continuation.ts`) and an explicit
`reportFrom()` RPC the child can call to push content to its parent's inbox
at any time (`index.ts:296-302`), not just at turn end — this is the
`tool-subagent-report` package (host-plane row, registers a "continuable
setup" contribution, `subagent/src/index.ts:312-318`).

### 3.3 Exposed as a tool

Yes — `packages/subagent/tool-subagent/src/index.ts` calls `defineTool(...)`
(confirmed import at line 14) and registers under a configurable `toolName`
(default `subagent`, `index.ts:55`). In the web profile it is mounted twice
under different names/providers per the standard preset:
`subagent` (provider `spawn`, continuable) and `subagent_fork` (provider
`fork`, continuable) — see §0 table.

---

## 4. HOOKS

`packages/hooks/hook-protocol` is a shared library (never itself a plugin —
`packages/hooks/README.md:25`: "Shared hook engine both bridges use; never
configured directly"). It provides the process-execution primitives
(`runHook`), matcher logic (`matchesMatcher`), output merging
(`mergeHookOutputs`), and the durable `hook/invoked` / `hook/result` session
events (`packages/hooks/hook-protocol/src/events.ts:75-104`).

The two consumer plugins, `hooks-claude-code` and `hooks-codex`, are bridges
that replay an existing Claude-Code-format or Codex-format `hooks.json`
against the harness's own extension points. Reading `hooks-claude-code`
(`packages/hooks/hooks-claude-code/src/index.ts`), the mapping onto the task's
named extension points is exact:

- `SessionStart` (CC event) → listens on `agent/session-start`
  (`index.ts:207-216`), injects returned context via `agent.inject(context)`.
- `UserPromptSubmit` → listens on `agent/pre-step`
  (`index.ts:220-236`); a `deny` decision maps to `{ kind: 'reject' }`
  (the `PreStepDecision` variant named in the task brief, confirmed at
  `index.ts:225`); otherwise it can append extra context messages onto a
  downstream `enter` decision.
- `PreToolUse` / `PostToolUse` → `tools/pre-execute` / `tools/post-execute`
  (`index.ts:239-266`) — again a `dsh-tools` extension point, not one of the
  four agent-loop points, but functionally the tool-level equivalent.
- `Stop` → `agent/turn-stopping` (`index.ts:271-278`): a blocking Stop hook
  calls `agent.steer(...)` with a synthetic user message to force another
  step rather than letting the turn end — this is a concrete, real use of
  `agent/turn-stopping`.
- `SubagentStart` / `SubagentStop` → listens on `subagent/start` /
  `subagent/end` (emitted events from `dsh-subagent`, `index.ts:282-296`).

Configuration: one `configPath` pointing at a `hooks.json` (or a settings file
whose `hooks` key holds the config), parsed once at plugin load
(`index.ts:97-117`); `pluginRoot`/`projectDir` substitute `${CLAUDE_PLUGIN_ROOT}`
/ `${CLAUDE_PROJECT_DIR}` in hook command strings. A hook's `updatedInput` and
`systemMessage` fields are explicitly logged-and-ignored, not honored
(`index.ts:176-181`) — a documented partial implementation.

**Mount status: NOT MOUNTED in the web profile.** Neither `hooks-claude-code`
nor `hooks-codex` nor the underlying `hook-protocol` plugin id appears
anywhere in `packages/bundle/base/cordis.patch.yml`,
`packages/bundle/web-app/cordis.patch.yml`, or
`packages/preset/agent-presets/presets/standard/agent.cordis.yml` (grep across
the whole repo for `dsh-hook` found only test fixtures, the packages' own
tests/READMEs, and doc-graph generator code — no bundle or preset composition
file references either package). They are available for a user to add to
their own profile's `cordis.patch.yml` or a custom preset, but the shipped web
profile never runs them.

---

## 5. SKILL

`SkillRegistry` (`ctx.skills`, `packages/skill/skill/src/index.ts:358-662`) is
a **layered** merge registry (global layer + one layer per scope in the
ancestor chain, `ScopedLayers`, mirroring the tools registry's own
host+per-scope shape per the module doc comment at `index.ts:347-357`).
Skills come from two kinds of contribution: `registerProvider()`
(`index.ts:392-430`, e.g. filesystem discovery) and `register()`
(`index.ts:441-462`, direct in-memory `SkillRegistration`, e.g. a plugin
shipping a bundled skill under the reserved `runtime` provider name).
Duplicate names are resolved first by scope-nearness (nearest layer's entry
wins outright), then by numeric `rank` within a layer, then registration
order (`collectFresh`/`collectLayer`, `index.ts:553-621`).

`skill-filesystem` (`packages/skill/skill-filesystem`) is the concrete
provider that discovers Markdown-with-frontmatter skill files from
directories (project `.dsh`/`.agents`, user home, custom roots) — mounted per
preset (§0 table), not host-plane, "presets own local discovery" per the
web-app comment at `packages/bundle/web-app/cordis.patch.yml:358-366`.

Injection into the model happens two ways, both via `tool-skill`'s two
`agent/pre-step` listeners (`packages/skill/tool-skill/src/index.ts:177-204`
and `:213-` onward):

1. **Explicit user invocation.** If a claimed user message's first line
   starts with `/<name>` naming a user-invocable skill, the listener loads the
   full skill body and appends it as an injected `UserMessage` with source
   `{ kind: 'skill-invocation', name, form: 'instructions' }`
   (`index.ts:196-200`) — placed *last* among injections, closest to what the
   model must act on, by deliberate registration order (comment at
   `index.ts:163-176`).
2. **Durable catalog maintenance.** The second listener maintains a
   `<available_skills>`-style catalog message (`SkillCatalogSource`,
   `form: 'catalog'`, `index.ts:34-41`) that is kept in sync with the current
   discoverable skill list on every accepted step, replacing or removing the
   catalog message when the digest of model-invocable skills changes
   (`index.ts:213-238`, code continues past the read window but the
   mechanism — digest comparison, `catalogMessage()`/`catalogHistory()` — is
   established at these lines).

The model-facing `skill` tool (`defineTool`, `index.ts:81-160`) takes an
exact `name`, loads the full definition via `ctx.skills.get()`, and its
`render` step wraps the body in a `<skill_content>` block
(`renderSkillContent()`, `packages/skill/skill/src/index.ts:172-185`) that
becomes the tool-call result content the model sees — i.e., a skill is
injected into the conversation as a **tool result**, not as a system-prompt
rewrite.

Mount status: `skill` (registry) and `tool-skill`/`skill-filesystem` (per
preset) are all LIVE in the default web session; `skill-badge` is disabled at
its own base-bundle row (`packages/bundle/base/cordis.patch.yml:285-287`,
`disabled: true`) and never appears anywhere else — NOT MOUNTED.

---

## 6. workflow / jobs / schedule / todo / plan / goal

- **workflow.** `dsh-tool-workflow`'s `workflow` tool
  (`packages/workflow/tool-workflow/src/index.ts:1-11` doc comment) runs a
  JavaScript orchestration **script** that fans out subagents and returns the
  script's final value; script parsing/execution/caps live behind
  `ctx.workflowEngine`, implemented by `dsh-workflow-worker-thread` — i.e. the
  script actually executes in a worker thread, isolated from the main
  process, and the tool awaits `run.result` and always disposes the run.
  **MOUNTED**: `workflow-worker-thread` + `tool-workflow` are re-mounted by
  the standard preset inside an `isolate:{workflowEngine:true}` group
  (`packages/preset/agent-presets/presets/standard/agent.cordis.yml:205-211`),
  live in the default web session (see §0 table).

- **jobs.** `dsh-jobs-local`'s `LocalJobRegistry` (`ctx.jobs`,
  `packages/jobs/jobs-local/src/index.ts:1-10` doc comment) is a
  process-local, in-memory background-job registry (`run_in_background`
  support) — "keeps every record in memory and hands out fresh snapshots,
  never live state." It caps concurrent jobs per owner (default 10,
  `index.ts:28`). `dsh-tool-jobs` exposes the model-facing `job_*` controls.
  **MOUNTED**: the `jobs` registry is host-plane (base bundle,
  `packages/bundle/base/cordis.patch.yml:81-82`, never disabled by web-app);
  `tool-jobs` is disabled at web-app (`web-app:346-347`) then re-mounted by
  the standard preset (`preset:73-74`) — live end to end.

- **schedule.** `dsh-schedule` ("Agent-scoped durable after, at, and
  fixed-rate reminders over the session event log",
  `packages/schedule/schedule/package.json:3`) is a full package with domain,
  runtime, tools, and client UI (`ui-schedule`). **NOT MOUNTED** in the web
  profile: it never appears in `packages/bundle/base/cordis.patch.yml` or
  `packages/bundle/web-app/cordis.patch.yml`; its only appearances outside its
  own package are `apps/server/config/examples/schedule/cordis.yml` (an
  example overlay a deployer must opt into) and its own tests. Confirming
  this, the web-app bundle's own client roster mounts `ui-schedule`
  **`disabled: true`** with the comment "The shipped Web graph resolves the
  client package but leaves it disabled; the explicit Schedule overlay
  enables this same row together with the host Schedule services"
  (`packages/bundle/web-app/cordis.patch.yml:266-271`) — direct confirmation
  from the codebase itself that Schedule is an opt-in overlay, not part of
  the default web profile.

- **todo.** `dsh-tool-todo`'s `todo` tool
  (`packages/todo/tool-todo/src/index.ts:1-6` doc comment) is model-facing
  whole-list replacement: each call appends a `todo/write` snapshot event to
  the session; there is no separate todo *service*, just the tool plus a
  session projection (`todos` projection key) that folds the log for UI
  rendering; replay is last-write-wins. `allowParallelInProgress` (required
  config, `true` in this deployment) controls whether the tool accepts
  several simultaneously `in_progress` items. **MOUNTED**: disabled at
  web-app (`web-app:438-439`), re-mounted by the standard preset
  (`preset:224-227`) — live.

- **plan.** `dsh-plan-mode`'s `PlanModeController`
  (`packages/plan/plan-mode/src/index.ts:1-23` doc comment) is logged
  per-agent collaboration state: while active, a fixed guidance section
  (defined once, identically, in both the base bundle row
  (`base:307-321`) and the standard preset row (`preset:110-124`)) is
  included in every model request, folded from a `plan/mode` session event
  via a registered `PlanProjection`; `exit_plan_mode` is a always-registered
  tool that presents the completed plan for user review; the actual mode flag
  only changes after an *accepted* `agent/pre-step`. **MOUNTED**: disabled at
  web-app (`web-app:382-383`), re-mounted inside `isolate:{planMode:true}` by
  the standard preset (`preset:104-124`) — live.

- **goal.** Three packages: `dsh-goal` (`ctx.goals`, the domain/session
  service — host-plane, never disabled), `dsh-goal-round-driver` (host-plane,
  "same-session goal-round driver over public agent, session, and goal
  services", `packages/goal/goal-round-driver/src/index.ts:1-3` doc comment —
  drives automatic goal-continuation turns by queueing `GoalMessageSource`
  user messages into the agent's own inbox), and `dsh-command-goal` /
  `dsh-tool-goal` (the human `/goal` command and the model-facing tool,
  both per-preset). **MOUNTED end-to-end**: `goal`/`goal-round-driver` are
  host-plane (base bundle, never disabled by web-app); `command-goal`/
  `tool-goal` are disabled at web-app (`web-app:376-380`) then re-mounted by
  the standard preset (`preset:94-98`) — live.

---

## 7. Extension-point listener census

Grepped across the whole repo (`.ts` files, excluding generated doc scripts)
for each of the six extension points/emitted-event names named in the task.
"Listener" below means a real `ctx.on('<event>', ...)` registration in
non-test source (`src/`), not a test fixture and not the agent-loop's own
definition/emission site.

### `agent/pre-step` (waterfall) — many real listeners; NOT zero
Defined/emitted in `packages/core/agent-loop/src/agent.ts`. Real listeners in
`src/` (non-test):
- `packages/compaction/compaction-basic/src/index.ts:148` (pressure compaction)
- `packages/skill/tool-skill/src/index.ts:177,213` (skill invocation + catalog)
- `packages/session/session-checkpoint-policy/src/index.ts` (durability
  checkpoint before request)
- `packages/plan/plan-mode/src/index.ts` (plan-mode step assembly / `plan/mode` append)
- `packages/hooks/hooks-claude-code/src/index.ts:220` and
  `packages/hooks/hooks-codex/src/index.ts` (UserPromptSubmit bridge — **not
  mounted in web**, see §4)
- `packages/guard/repeat-tool-reminder/src/index.ts` (consecutive-repeat tool
  reminders — mounted, base bundle `id: repeat-tool-reminder`)
- `packages/goal/goal-round-driver/src/index.ts` (goal round admission)
- `packages/context/tmux-context/src/index.ts`,
  `packages/context/time-context/src/index.ts`,
  `packages/context/session-reference/src/index.ts`,
  `packages/context/agent-instructions/src/index.ts` (runtime-context
  injection plugins)
- `packages/subagent/subagent-in-process-driver/src/index.ts:82` (appends the
  one-shot `subagent/descriptor` event on first accepted step)
- `packages/extensions/tool-cordis/src/api-catalog.ts` (introspection catalog
  entry describing the extension point, not a behavioral listener)

### `agent/request` (waterfall) — has real listeners; NOT zero
Defined in `packages/core/agent/src/runtime-types.ts:251` and emitted at
`packages/core/agent-loop/src/agent.ts:479`. Real (non-test) listeners:
- `packages/core/agent/src/model-selection.ts:54-70` —
  `installModelSelection()` overrides `provider`/`model`/`reasoningEffort` on
  the outgoing `LlmCallConfig` from a mutable per-agent selection ref. This is
  wired up by `packages/api/session-controller/src/agent.ts` (confirmed via
  grep — session-controller is the host-plane `/model` command backend,
  mounted in web-app), i.e. **this listener is live in the default web
  session** whenever a user or the client picks a model.
- `packages/webhook/webhook/src/session.ts:93` — a per-session override for
  the (separate, non-target) webhook package; not part of this task's scope
  and not mounted by base/web-app bundles as far as this pass checked.

So `agent/request` is **not** an unused extension point, contrary to what a
narrower grep (matching only the literal event-name-with-parenthesis pattern)
first suggested — the earlier pass under-counted because `model-selection.ts`
calls `agentCtx.on('agent/request', ...)` across a line break from the
callback, which a naive single-line regex misses.

### `agent/request-error` (waterfall) — has real listeners; NOT zero
Defined/emitted in `packages/core/agent-loop/src/agent.ts`. Real listeners:
- `packages/compaction/compaction-basic/src/index.ts:180` (context-overflow
  recovery, §1.1)
- `packages/llm/llm-retry/src/index.ts` (provider-routed retry policy —
  `LlmRetryEventData`, mounted host-plane in the base bundle as `id:
  llm-retry`, `packages/bundle/base/cordis.patch.yml:84-85` — LIVE)

### `agent/turn-stopping` (waterfall, `void`-returning per the task's given
signature — actually used to *veto* stopping via side effect, not a return
value) — has real listeners; NOT zero
Defined/emitted in `packages/core/agent-loop/src/agent.ts`. Real listeners:
- `packages/hooks/hooks-claude-code/src/index.ts:271` and
  `packages/hooks/hooks-codex/src/index.ts` (Stop-hook bridge, calls
  `agent.steer(...)` to force continuation — **not mounted in web**, see §4)

**In the shipped web profile specifically, `agent/turn-stopping` has ZERO
live listeners** — its only known implementations are the two hook bridges,
neither of which is mounted by `dsh-base`, `dsh-web-app`, or the `standard`
preset. This is worth flagging explicitly: the extension point exists and is
exercised by tests, but nothing in the default running system currently uses
it to veto or steer turn-stopping.

### `agent/status`, `agent/error`, `agent/session-start` (emitted events)
All three have real listeners:
- `agent/status`: `packages/compaction/compaction-basic/src/index.ts:168`
  (clears overflow-retry counters on `idle`).
- `agent/session-start`: `packages/hooks/hooks-claude-code/src/index.ts:207`
  (SessionStart bridge — not mounted in web); no other non-test listener was
  found for `agent/session-start` specifically in the packages scoped to this
  task. UNKNOWN — checked this task's package group and the hooks package;
  would need a full-repo audit of `packages/context/**` and
  `packages/session/**` to be exhaustive about every consumer.
- `agent/error`: appears in `packages/core/scope` generated scoped-event
  tables and `packages/core/agent`/`agent-loop` definition sites; no listener
  specific to this task's package group was found (compaction, subagent, etc.
  do not listen to it). UNKNOWN beyond this — would need to grep the full
  repo (session-telemetry, session-persistence) outside this task's scope to
  find its consumers with confidence.

### `agent/inbox/inserted` / `agent/inbox/discarded` / `agent/inbox/claimed` (emitted events)
Real listeners found in this task's scope:
- `packages/subagent/subagent/src/continuation.ts` (continuable-child FIFO
  inbox lifecycle)
- `packages/jobs/tool-jobs/src/index.ts`
- `packages/goal/goal-round-driver/src/index.ts` (its `RoundAttempt` state
  machine tracks `queued`/`claimed`/`admitted`, consistent with observing
  these inbox lifecycle events)

None of these three specific sub-event names showed zero listeners.

### Summary: any extension point with zero listeners?
Of the points named in the task brief, only **`agent/turn-stopping`** has a
real implementation restricted entirely to code that is **not mounted** in
the shipped web profile (the two hook bridges) — so it is exercised in tests
and available to a user who mounts a hook bridge or writes their own plugin,
but has zero effective listeners in the default running system today. The
other five named points (`agent/pre-step`, `agent/request`,
`agent/request-error`, `agent/status`, `agent/error`/`agent/session-start`,
and the `agent/inbox/*` triad) all have at least one listener that is
genuinely mounted in the default web profile.

---

## 8. `packages/experimental/**`

Grepped `packages/bundle/base/cordis.patch.yml` and
`packages/bundle/web-app/cordis.patch.yml` for the string `experimental` —
**zero matches**. No package under `packages/experimental/**` (e.g.
`webworker-runtime`, `agent-team`) is referenced by either bundle patch or by
the standard preset. This corroborates the repository layout doc's own
description of `packages/experimental/` as "private prototypes"
(`AGENTS.md:112`) — confirmed here by absence from every composition file
actually read, not merely trusted from the comment.

---

## 9. Things marked UNKNOWN (not independently confirmed)

- Full enumeration of every `agent/error` and `agent/session-start` listener
  repo-wide — checked only the packages in this task's scope plus the hooks
  bridges; a `packages/session/**` or `packages/api/**` consumer may exist
  that was not searched. Would need a repo-wide grep restricted to
  `src/*.ts` for `ctx.on('agent/error'` and `ctx.on('agent/session-start'`
  outside this task's package list.
- Whether any user-authored custom preset (under `$DSH_HOME/.agent-presets`,
  per `packages/preset/agent-presets`'s `includeUserRoot`) ships with hooks or
  schedule enabled by default in some other distribution channel — this note
  covers only the shipped `standard` preset file in the repository.
- The exact behavior of `dsh-tool-subagent-control` / `list-agents` (host-plane,
  mounted, referenced but not read in depth) beyond what its file listing
  suggests.
