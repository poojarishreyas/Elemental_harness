# Tools & the tool execution pipeline — raw research notes

Scope: `packages/core/tools/**` (the registry/scheduler), the approval seam
(`packages/interaction/user-approval/**`), the sandbox-escalation helper
(`packages/sandbox/sandbox/src/escalation.ts`), the agent-loop caller
(`packages/core/agent-loop/src/tool-calls.ts`), and two concrete tools
(`packages/shell/tool-bash/src/index.ts`, `packages/fs/tool-str-replace-editor/src/index.ts`).

All line numbers below are as read on the current `main` checkout (HEAD
`634053c`). All claims are grounded in the implementation, not comments or
docs, unless explicitly marked INFERRED or UNKNOWN.

---

## 1. Where the tools service is defined; registration; tool-definition shape

The tools service is `ToolRuntime`, a Cordis `Service` named `'tools'`:

- `packages/core/tools/src/index.ts:780` → `export class ToolRuntime extends Service`
- `packages/core/tools/src/index.ts:781` → `static inject = ['systemPrompt']`
- `packages/core/tools/src/index.ts:819-830` → `constructor(ctx, config)`: sets
  `defaultMode`, `maxParallelSubCalls`, registers a `ctx.systemPrompt.tools(...)`
  provider, and (when the deployment default mode is not `'native'`) registers
  the `tools:ptc-only` collapse section and the `tools:sdk` SDK section.
- `packages/core/tools/src/index.ts:129-132` → declaration-merge:
  `interface Context { tools: ToolRuntime }` (Cordis capability seam pattern).

### Registration is an effect

`packages/core/tools/src/index.ts:1028-1053` → `register(definition): () => void`:

```ts
register(definition: ToolDefinition): () => void {
  const name = definition.name
  ... // output-shape checks, timeoutMs checks, reserved-name check for `run_code`
  return this.layers.effect(
    this.ctx,
    layer => layer.tools.insert(name, definition),
    { label: 'tools.register()' },
  )
}
```

`this.layers` is a `ScopedLayers` (`@deepseek-ai/dsh-scope`) whose `.effect(...)`
runs inside `ctx.effect()` internally (confirmed by the AGENTS.md-documented
convention "every contribution goes through `ctx.effect()`" and by `register()`
returning "the exact disposer that unregisters the tool" per its own JSDoc,
line 1023-1027). A concrete tool plugin calls it directly, e.g.
`packages/shell/tool-bash/src/index.ts:241` → `ctx.tools.register(defineTool({...}))`
inside the plugin's `apply(ctx, config)` function (which Cordis itself runs
inside a plugin effect scope). So "registrations are effects" is true at two
levels: `register()`'s own layer insertion is one effect, and the plugin
`apply()` call that invokes it is itself run under the owning plugin's Cordis
effect scope, so unmounting the plugin disposes the registration.

Duplicate names in one scope throw
(`packages/core/tools/src/index.ts:719-721`, the `NamedEntries` constructor's
error factory), and the reserved transport name `run_code` can never be
registered or shadowed (`index.ts:1045-1047`).

### `ToolDefinition` shape

`packages/core/tools/src/index.ts:214-280` → `ToolDefinition extends ToolSchema`
(`ToolSchema` — `name`, `description`, `parameters` — comes from
`@deepseek-ai/dsh-llm`, projected in `schemaOf()` at `index.ts:1246-1258`).
Fields on `ToolDefinition`:

- `output: ToolOutputDefinition` (mandatory) — `{ schema, render(args,value), presentationMeta?(args,value) }` (`index.ts:204-211`).
- `execute(args: unknown, exec: ToolRunContext): Promise<unknown>` (`index.ts:227`) — returns only the **canonical value**, not model content; the registry projects content via `output.render`.
- `finalizeContent?(exec, result): ContentBlock[] | undefined` (`index.ts:239`) — snapshotted at call start, invoked exactly once per outcome, even on pipeline failures that bypass `tools/post-execute`.
- `timeoutMs?: number` (`index.ts:247`) — cooperative; enforced by a separate package `@deepseek-ai/dsh-tool-call-timeout-policy` (a `tools/execute` wrapper), never sent to the model.
- `isConcurrencySafe?(args: unknown): boolean` (`index.ts:261`) — see §4.
- `presentCall?(args): ToolCallView | undefined` / `presentResult?(args, result): ToolResultView | undefined` (`index.ts:271-279`) — pure UI presenters (see `presentation.ts`, §6/§8).

Most first-party tools do not build `ToolDefinition` by hand; they call
`defineTool()` (`packages/core/tools/src/schema.ts:545-617`), a typed helper
that:
1. Compiles the author-facing `ValueSchemaSpec`/`ParameterSchemaSpec` DSL to
   raw JSON Schema (`parameterSchemaSpecToJsonSchema`, `valueSchemaSpecToJsonSchema`,
   `schema.ts:449-458`, `438-442`).
2. Wraps `execute` so arguments are validated against the compiled parameter
   schema before the user body ever runs (`schema.ts:585-589`):
   ```ts
   async execute(args: unknown, exec: ToolRunContext): Promise<JsonValue> {
     const violations = validate(args)
     if (violations.length > 0) throw new ToolArgsError(violations)
     return userExecute(args as InferArgs<S>, exec) as Promise<JsonValue>
   }
   ```
3. Wraps `presentCall`/`presentResult`/`isConcurrencySafe` to validate softly
   (swallow invalid args → `undefined`/`false`) rather than throw, because
   presenters may run against old logged arguments on session replay
   (`schema.ts:594-616`).

A raw (non-`defineTool`) `ToolDefinition` is also legal and is exercised by
tests, e.g. `packages/core/tools/tests/execution-mode.spec.ts:83-93` registers
a plain object literal with `parameters: { type: 'object', properties: {} }`.

---

## 2. Full lifecycle: `executionMode` → `prepare` → `dispatch` → `finish`/`finalize`

### The scheduler surface

`packages/core/tools/src/index.ts:444-453` → `ToolRuntimeScheduler` interface:

```ts
export interface ToolRuntimeScheduler {
  prepare(exec: ToolExecutionInput): Promise<ScheduledToolPreparation>
  dispatch(exec: ToolRunContext): Promise<ScheduledToolDispatch>
  finalize(exec: ToolRunContext, result: ToolExecutionResult): Promise<ToolExecutionResult>
  finish(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult
}
```

Exposed on the `ToolRuntime` instance under a private symbol key
(`index.ts:459` → `export const TOOL_RUNTIME_SCHEDULER: unique symbol`), wired
at `index.ts:789-794`:

```ts
readonly [TOOL_RUNTIME_SCHEDULER]: ToolRuntimeScheduler = {
  prepare: exec => this.prepareScheduledExecution(exec),
  dispatch: exec => this.dispatchScheduledExecution(exec),
  finalize: (exec, result) => this.finalizeScheduledExecution(exec, result),
  finish: (exec, result) => this.finishScheduledExecution(exec, result),
}
```

`ToolRuntime.execute(exec)` (the ordinary, non-scheduler public API,
`index.ts:1333-1335`) is implemented by chaining the SAME four private methods
via `completeScheduledExecution` (`index.ts:1337-1353`) — the scheduler and
`execute()` are not two implementations, one is a decomposition of the other.

### Stage 1 — `executionMode(exec: ToolExecutionInput): ToolExecutionMode`

`index.ts:1267-1276`:

```ts
executionMode(exec: ToolExecutionInput): ToolExecutionMode {
  const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined)
  if (!tool?.isConcurrencySafe) return { kind: 'exclusive' }
  try {
    const concurrencySafe: unknown = tool.isConcurrencySafe(exec.arguments)
    return concurrencySafe === true ? { kind: 'parallel' } : { kind: 'exclusive' }
  } catch {
    return { kind: 'exclusive' }
  }
}
```

Purely synchronous, side-effect-free, callable before any policy runs. Used by
the agent-loop scheduler to decide whether to batch a call with its
neighbours (§ agent-loop below) and, internally, by `run_code`'s own
per-sub-call classification (`ptc.ts:529` → `classify: () => registry.executionMode(input).kind`).

### Stage 2 — `prepare(exec: ToolExecutionInput): Promise<ScheduledToolPreparation>`

`index.ts:1450-1452` delegates to the shared `prepareExecution` helper used by
both the scheduler and `execute()`:

```ts
private async prepareScheduledExecution(input: ToolExecutionInput): Promise<ScheduledToolPreparation> {
  return this.prepareExecution(input, prepared => prepared)
}
```

`prepareExecution` (`index.ts:1454-1498`) does, in order:

1. **`createExecution(input)`** (`index.ts:1355-1442`) — mints the
   `ToolExecutionToken`, resolves `rootCallId`, snapshots+freezes `arguments`
   via `snapshotJsonValue`/`deepFreeze`, and classifies the call as **PTC
   collapsed** (visible under the current view but blocked because the calling
   scope presents `mode: 'ptc'` and the call is model-direct, not a `run_code`
   sub-dispatch — see `collapses()`, `index.ts:1315-1317`). A collapsed call
   short-circuits straight to a `final-result` carrying `ToolNotFoundError`
   with an actionable "call it from inside `run_code`" message
   (`index.ts:1427-1434`), **before** any pre-execute listener or approval
   `ask` ever sees it (comment at `index.ts:1364-1370` states this is
   deliberate: "pre-execute listeners, approval `ask`, and guards must never
   observe — or worse, approve — a call that can only fail"). If arguments
   fail lossless-JSON snapshotting, this also short-circuits to a `final-result`
   error (`index.ts:1437-1441`).
2. If the created execution is not `'ready'` (i.e. it was already collapsed or
   invalid), `prepareExecution` returns it immediately as the next stage.
3. **Caller-cancellation check** (`index.ts:1461-1463`) — if the caller signal
   is already aborted, produce `final-result` with `toolAbortedBeforeDispatchResult()`.
4. **`tools/pre-execute` waterfall** (`index.ts:1466-1469`) — extensible;
   default (no listeners) is `{ kind: 'allow' }`. Result is a `PreToolDecision`
   (`allow` | `deny` | `ask`).
5. **`ask` → `serviceAsk`** (`index.ts:1470-1472`, detailed in §5).
6. **Post-ask cancellation race** (`index.ts:1474-1476`) — if the caller
   cancelled while `ask` was pending AND the approval channel itself reported
   cancellation, the call becomes a `post-result` (not `final-result`) carrying
   `toolAbortedBeforeDispatchResult()` — it still goes through post-execute.
7. **Guard chain** (`index.ts:1477-1490`) — `this.guardReason(exec)` is
   consulted only if the pre-execute decision was `allow`; if the decision was
   already `deny`, its own `reason` is used. A resulting denial (from either
   source) becomes `post-result` with a synthetic `Error: <reason>` failure
   result.
8. **Second caller-cancellation check** (`index.ts:1491-1493`) — same
   `post-result` abort pattern.
9. Otherwise → `{ kind: 'dispatch', exec }` (`index.ts:1494`).
10. Any thrown error at any point → `final-result` with `toolErrorResult(error)` (`index.ts:1495-1497`).

So `prepare()` runs: input validation/collapse check → caller-abort check →
`tools/pre-execute` waterfall → approval `ask` (if requested) → monotonic
guard chain → caller-abort check again → dispatch-readiness.

### Stage 3 — `dispatch(exec: ToolRunContext): Promise<ScheduledToolDispatch>`

`index.ts:1560-1590` → `dispatchScheduledExecution`:

1. Runs the `tools/execute` **around-dispatch waterfall**
   (`index.ts:1564-1567`), whose innermost `next()` is `dispatchToolBody(mutableExec)`.
2. `dispatchToolBody` (`index.ts:1523-1551`) fuses the caller's original
   signal with whatever signal the around-dispatch wrapper chain left on
   `exec.signal` (`fuseToolSignals`, `index.ts:1880-1907`), re-checks abort,
   resolves the tool definition via `resolveExecution` (respecting the PTC
   collapse a second time — a nested `run_code` sub-dispatch is exempt), marks
   `state.bodyInvoked = true`, and **calls `tool.execute(exec.arguments, exec)`**.
   The returned raw value is turned into a `ToolExecutionSuccess` via
   `createSuccessResult` (validates it against `output.schema`, calls
   `output.render`, optionally `output.presentationMeta` for a top-level call
   — `exec.parent === undefined`).
3. `normalizeDispatchResult` (`index.ts:1817-1835`) re-validates/re-renders an
   around-dispatch wrapper's own authored result through the SAME output
   contract, unless the result is already marked canonical for this exact
   token (`canonicalResults` WeakMap, `index.ts:1775-1781`).
4. Deferred contexts collected via `exec.deferContext()` during the tool body
   are merged into `additionalContexts` here (`index.ts:1569-1580`).
5. A **caller cancellation that arrived during dispatch** replaces a
   successful (non-error) result with the aborted-after-start outcome
   (`cancellationResult`, `index.ts:1509-1516`, `TOOL_ABORTED` — body was
   invoked, so this is the "started" cancellation code, not
   `ABORTED_BEFORE_DISPATCH`).
6. Returns `{ kind: 'post-result', result }` normally, or `{ kind: 'final-result', result: toolErrorResult(error) }` if anything in this stage throws (`index.ts:1587-1589`).

**`dispatch` never itself returns `'dispatch'`** — its only two outcome kinds
are `'post-result'` and `'final-result'` (`ScheduledToolDispatch`, `index.ts:434-437`).

### Stage 4a — `finalize(exec, result): Promise<ToolExecutionResult>` (needs post-execute)

`index.ts:1600-1612` → runs the `tools/post-execute` waterfall
(`postExecute`, detailed below), applies a caller-cancellation override
identical in shape to dispatch's, then calls `finishScheduledExecution`.
Wrapped in try/catch so a throwing post-execute listener becomes an error
result rather than propagating.

`postExecute` (`index.ts:1733-1772`):
- Runs `tools/post-execute` waterfall; default `{ kind: 'accept' }`.
- `block` → turns the result into `isError: true` with `content: decision.feedback` and a derived message (`failureMessageFromContent`, `index.ts:618-623`); tool-deferred context is discarded (only the block decision's own `additionalContexts` survive) — per its own JSDoc at `index.ts:1729-1730`.
- `accept` with `value` → re-validates/re-renders through `createSuccessResult` (cannot replace the value of an already-failed result — throws `TypeError` at `index.ts:1756-1758`).
- `accept` with `content` → replaces content only.
- Cannot specify both `content` and `value` (`index.ts:1748-1750`, throws `TypeError`).
- Every branch is wrapped via `markCanonical` (`index.ts:1778-1781`) so a later re-normalize is a no-op.

### Stage 4b — `finish(exec, result): ToolExecutionResult` (bypasses post-execute)

`index.ts:1622-1637` → synchronous. Materializes the result twice:
1. `materializeFinalResult(result)` (freezes + lossless-JSON-checks the presentation fields, `index.ts:1838-1853`) — falls back to `materializeFinalResult(toolErrorResult(error))` on failure.
2. `applyFinalContent(exec, materializedResult)` (`index.ts:1640-1645`) — invokes the SNAPSHOTTED `finalizeContent` callback (captured at `createExecution` time, `index.ts:1399-1401`) — then materializes again.
3. `notifyResult(exec, finalResult)` (`index.ts:1648-1667`) — freezes `exec` itself and emits `tools/result` (an `emit`-mode event; listener failures are logged and contained, never rethrown).

### `needsPost` — why some results skip post-execute

The distinction lives entirely in which scheduler stage produced the result,
not in the result's own shape. Concretely (looking at `agent-loop/src/tool-calls.ts:172-196`,
the ONLY consumer of the scheduler outside `ToolRuntime` itself):

```ts
switch (prepared.kind) {
  case 'dispatch': {
    const promise = ctx.tools[TOOL_RUNTIME_SCHEDULER].dispatch(prepared.exec).then(
      (outcome) => {
        slots[index] = { exec: prepared.exec, result: outcome.result, needsPost: outcome.kind === 'post-result' }
        ...
      }, ...)
    ...
  }
  case 'post-result':
    slots[index] = { exec: prepared.exec, result: prepared.result, needsPost: true }
    break
  case 'final-result':
    slots[index] = { exec: prepared.exec, result: prepared.result, needsPost: false }
    break
}
```

and later (`tool-calls.ts:152-154`):

```ts
const result = slot.needsPost
  ? await ctx.tools[TOOL_RUNTIME_SCHEDULER].finalize(slot.exec, slot.result)
  : ctx.tools[TOOL_RUNTIME_SCHEDULER].finish(slot.exec, slot.result)
```

So the exact rule is:
- `prepare()` returning `'final-result'` (PTC collapse denial, invalid args
  before dispatch, denied-by-guard-or-pre-execute-with-approval-cancelled-away... — actually see below) → **`finish`, no post-execute.**
- `prepare()` returning `'post-result'` (guard/pre-execute denial, or a
  cancellation raced against a pending approval `ask`) → **`finalize`, i.e. post-execute still runs**, even though the tool body never ran. `postExecute`'s waterfall can `block`/`accept`/replace a call that was denied before it ever dispatched.
- `dispatch()` always returns either `'post-result'` (the common case — body
  ran or threw) → **`finalize`**, or `'final-result'` (an internal scheduler
  exception thrown by the dispatch stage itself, e.g. `tools/execute`
  waterfall setup failing) → **`finish`, no post-execute.**

So the "which stage produced the outcome" table is: PTC-collapse and
pre-dispatch argument-snapshot failures are `final-result` (no post-execute
—correct because the call never became a real dispatch candidate); guard/ask
denials are `post-result` (post-execute DOES see synthetic denial results,
matching the JSDoc at `index.ts:420-422`: "Thrown tools still reach this
waterfall as errors"); genuine dispatch outcomes (success, thrown tool error,
around-dispatch wrapper outcome) are `post-result`; and dispatch-stage
internal scheduler failures are `final-result`.

---

## 3. `ToolExecutionInput` vs `ToolRunContext` vs `ToolExecutionResult`

### `ToolExecutionInput` — `packages/core/tools/src/index.ts:307-331`

```ts
export interface ToolExecutionInput {
  readonly callId: ToolCallId
  readonly rootCallId?: ToolCallId
  readonly name: string
  readonly arguments: unknown
  readonly agent?: Agent
  readonly parent?: ToolExecutionToken
  readonly signal: AbortSignal
}
```

Caller-supplied. `rootCallId` omitted for a root (model-direct) call, set by
nested dispatchers. `parent` set only by PTC mode sub-dispatches
(`ptc.ts:476` → `parent: exec.token`); its presence is what lets a call under
`mode: 'ptc'` bypass the model-direct collapse (`index.ts:1212-1217`,
`resolveExecution`).

### `ToolExecution` — `index.ts:372-377` (extends `ToolExecutionInput`)

Adds registry-assigned `rootCallId` (now required) and `token:
ToolExecutionToken` (an opaque `symbol`, `index.ts:297-300`, minted by
`createExecutionToken()`, `index.ts:1856-1859`). This is the pipeline-internal
object: created once by `createExecution`, frozen just before `tools/result`
fires (`Object.freeze(exec)` at `index.ts:1651`).

### `ToolDispatchExecution` — `index.ts:384-387`

```ts
export interface ToolDispatchExecution extends Omit<ToolExecution, 'signal'> {
  signal: AbortSignal
}
```

The around-dispatch (`tools/execute`) view: `signal` is mutable here so a
timeout/retry wrapper can substitute its own signal for the delegated
lifetime, but the registry always re-fuses the caller's original signal
underneath (`fuseToolSignals`) so a wrapper cannot detach caller cancellation.

### `ToolRunContext` — `index.ts:397-414` (extends `ToolExecution`)

The object handed to `tool.execute()`. Adds two callback methods implemented
as closures over per-execution state in `createExecution` (`index.ts:1382-1387`):

```ts
export interface ToolRunContext extends ToolExecution {
  deferContext(context: UserMessage): void
  concludeTurn(): void
}
```

Internally this is a `MutableToolRunContext` (`index.ts:417`,
`Omit<ToolRunContext, 'signal'> & { signal: AbortSignal }`) — the registry's
own live object; the public type keeps `signal` readonly to outside callers.

### `ToolExecutionResult` — `index.ts:549-573`

```ts
export interface ToolExecutionSuccess {
  readonly isError: false
  readonly value: JsonValue                 // execution-local only, never durable
  readonly content: ContentBlock[]
  readonly error?: never
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  readonly concludesTurn?: true
}
export interface ToolExecutionFailure {
  readonly isError: true
  readonly error: ToolFailure               // { message, info?: { name, code } }
  readonly value?: never
  readonly content: ContentBlock[]
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  readonly concludesTurn?: never
}
export type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure
```

`value` is explicitly "deliberately omitted from durable events" (comment at
`index.ts:551`) — `materializeFinalResult` (`index.ts:1838-1853`) keeps `value`
on the in-memory object it returns to `ToolRuntime.execute`'s caller, but the
durable `tool/result` session event only ever receives `message` (via
`createToolResultMessage`) plus `error.info`/`meta` — see
`agent-loop/src/tool-calls.ts:269-289` (`appendToolResult`), which reads only
`result.content`, `result.isError`, `result.error?.info`, `result.meta`; it
never touches `result.value`.

---

## 4. `executionMode` — parallel-safe vs exclusive, with real tools

Declared via `ToolDefinition.isConcurrencySafe?(args: unknown): boolean`
(`index.ts:249-261`, `schema.ts:501-506` for the typed `defineTool` variant).
The classifier is **fail-closed**: no declaration, a throwing classifier, or
any non-`true` return value → `exclusive` (`index.ts:1267-1276`, exercised by
`packages/core/tools/tests/execution-mode.spec.ts:40-107`, e.g. "defaults to
exclusive for a tool with no isConcurrencySafe declaration", "treats a
throwing raw classifier as exclusive", "treats a truthy non-boolean raw result
as exclusive").

Real examples:

- **Parallel-safe (pure reads):**
  - `packages/fs/tool-fs/src/read.ts:134` → `isConcurrencySafe: () => true,` with the adjacent comment "Observation races fail closed because guarded mutations re-check the version in-lock."
  - `packages/web/tool-web/src/search.ts:362` → `isConcurrencySafe: () => true,` ("Provider reads do not mutate parent-agent state.")
  - `packages/web/tool-web/src/fetch.ts` also declares it (grep hit; not read verbatim here).
  - `packages/fs/tool-fs/src/read-image.ts` also declares it.

- **Exclusive by omission (mutating or ambiguous tools):**
  - `packages/shell/tool-bash/src/index.ts` — the `bash` tool declares no `isConcurrencySafe` at all → defaults to `exclusive`. (Running arbitrary shell commands concurrently with siblings is unsafe by default.)
  - `packages/fs/tool-str-replace-editor/src/index.ts` — `str_replace_editor` (view/create/str_replace/insert) also declares none → `exclusive`, even for its read-only `view` command; the tool does not attempt per-command classification.

Two conditional examples from tests
(`execution-mode.spec.ts:56-67`) show a classifier reading its own arguments:
`isConcurrencySafe: args => args.mode === 'read'` — `{mode:'read'}` →
parallel, `{mode:'write'}` → exclusive. No shipped first-party tool does
per-argument classification like this — UNKNOWN whether any production tool
actually branches on args for concurrency (checked `tool-bash`, `tool-fs`,
`tool-web`, `str-replace-editor`, `tool-cordis`, `tool-subagent`; only static
`() => true` or omission found).

`executionMode` is consulted by the agent-loop scheduler
(`agent-loop/src/tool-calls.ts:89`, `204-205`) to decide whether an assistant
step's tool calls run as one exclusive call at a time or as a parallel pool
(`maxParallelToolCalls`, bounded, reclassified before each start), and
independently by the `run_code` bridge for each SDK sub-dispatch (`ptc.ts:529`).

---

## 5. Permissions / approval — where gating actually happens

There are **two independent gating mechanisms**, and they are wired very
differently in the shipped composition.

### 5a. The generic pipeline seam: `tools/pre-execute` → `ask` → `ApprovalService`

`PreToolDecision` (`index.ts:576-584`):

```ts
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }
```

A `tools/pre-execute` waterfall listener can return any of the three. `ask` is
resolved by `serviceAsk` (`index.ts:1680-1720`), called from inside `prepare()`
(`index.ts:1470-1472`) — **approval happens inside `prepare`, not as a
separate middleware stage and not inside `dispatch`.**

```ts
private async serviceAsk(exec, ask): Promise<ToolAskResolution> {
  const approval = this.ctx.get('approval')
  if (approval === undefined) return { decision: { kind: 'deny', reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)` }, approvalCancelled: false }
  if (exec.agent === undefined) return { decision: { kind: 'deny', reason: `... no agent to route it through` }, approvalCancelled: false }
  const outcome = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, ...reason, signal: exec.signal })
  switch (outcome) {
    case 'allowed-once': return { decision: { kind: 'allow' }, approvalCancelled: false }
    case 'rejected':     return { decision: { kind: 'deny', reason: `the user rejected tool "${exec.name}"` }, approvalCancelled: false }
    case 'cancelled':    return { decision: { kind: 'deny', reason: `approval for tool "${exec.name}" was cancelled` }, approvalCancelled: true }
    case 'unavailable':  return { decision: { kind: 'deny', reason: `... no approval channel is available` }, approvalCancelled: false }
  }
}
```

So: no composed `ApprovalService` → `ask` degrades to `deny` deterministically
("not yet supported"). No `exec.agent` → `deny` (no session to route the
prompt through). Otherwise the seam consults `ApprovalService.request()`
(`packages/interaction/user-approval/src/index.ts:222-241`), which:
1. Throws if the session has no open turn (`hasOpenTurn`, lines 92-99, 224-230)
   — approval audit events must live inside a turn boundary.
2. Appends `approval/asked` (durable, log-only, never in the model
   transcript — lines 232-237).
3. Calls `decide(req, session)` (lines 269-309): if the session's effective
   policy (`effectiveApprovalPolicy` fold over `approval/policy` events, or
   the plugin's configured default) is `'never'`, resolves `'rejected'`
   **before any answerer runs** (line 277, deliberately not delegatable —
   comment explains a `prepend: true` listener could not otherwise guarantee
   this). Otherwise dispatches the `approval/request` waterfall
   (`scope-filtered` on the agent), default fallback `'unavailable'`, racing
   against `req.signal` abort → `'cancelled'`.
4. Appends `approval/decided` with the same `id` (line 239).

**Grep across the whole `packages/` tree found only test files and
`packages/hooks/hooks-claude-code/src/index.ts:243` producing a real (non-test)
`{ kind: 'ask', ... }` `PreToolDecision`.** `hooks-claude-code` and
`hooks-codex` are compatibility shims that translate an external hook
protocol's `decision: 'ask'` into this seam. **No first-party, always-on
plugin in this repository wires `tools/pre-execute` to ask by default** —
UNKNOWN (not further chased) whether any bundled `apps/server` profile
actually loads `hooks-claude-code`/`hooks-codex` by default; checked
`packages/bundle/**` composition files only superficially via grep for
`tools/pre-execute`, found no match there.

### 5b. What real tools actually do instead: in-body approval via `ctx.approval` directly

The concrete, shipped approval-gated flow is **inside the tool's own
`execute()` body**, not through `tools/pre-execute`. Both sandbox-enforcing
tool families call a shared helper:

`packages/sandbox/sandbox/src/escalation.ts:157-189` → `approveEscalation(request, approval)`:
1. Checks the requested mode is strictly wider than the call's effective mode
   via a `WIDER_MODES` table (`read-only → workspace-write|danger-full-access`,
   `workspace-write → danger-full-access`) — throws (never asks) if not.
2. Throws if no `approval.approver` (`ctx.get('approval')` was `undefined`) or
   no `approval.agent`.
3. Calls `approval.approver.request({ agent, toolName, callId, reason:
   'escalate sandbox to <mode>: <justification>', signal })` — this `approver`
   is literally `ctx.get('approval')` (an `EscalationApprover`, structurally
   identical to `ApprovalService` so this package need not import it).
4. Maps `'allowed-once'` → returns the granted `SandboxMode`; every other
   outcome throws a distinct, model-facing `Error` (rejected / cancelled /
   unavailable), which the registry turns into the call's `isError` result
   exactly like any other thrown execution error — **there is no
   `PreToolDecision` involved at all for this path.**

Call site in `bash`: `packages/shell/tool-bash/src/index.ts:329-338`:

```ts
async execute(args: BashToolArgs, exec) {
  validateBashArgs(args)
  const standingPolicy = resolveSandboxPolicy(exec)
  const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
    ? await approveBashEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
    : undefined
  const policy = approvedMode === undefined ? standingPolicy : { ...standingPolicy, mode: approvedMode }
  ...
}
```

`approveBashEscalation` (lines 212-232) wraps `approveEscalation` with the
bash-specific ingredients (`approver: ctx.get('approval')`, `toolName: 'bash'`,
etc.). The model requests escalation by supplying `sandbox_permissions` +
`justification` **arguments to the SAME tool call**, not by any registry-level
mechanism — the tool schema documents this at
`packages/shell/tool-bash/src/index.ts:258-268` (the `sandbox_permissions`/
`justification` parameters, only advertised when a confining executor is
mounted — `escalationModes.length > 0`, line 192).

A denial becomes a result concretely as: `approveEscalation` throws a plain
`Error` (e.g. `` `the user rejected escalating this command to "${mode}"` ``)
→ this propagates out of `tool.execute()` → caught by `dispatchToolBody`'s
try/catch (`index.ts:1545-1546`, `catch (error) { return toolErrorResult(error) }`)
→ `toolErrorResult` (`index.ts:1861-1869`) wraps it as
`{ content: [{type:'text', text: 'Error: <message>'}], isError: true, error: { message, info? } }`.

**Conclusion for Q5:** the pipeline HAS a generic ask/deny seam
(`tools/pre-execute` → `ApprovalService`), fully implemented and tested, but
the two concrete tool families this research read (`bash`, filesystem
mutations via `str_replace_editor`'s sibling `dsh-fs`/`dsh-fs-sandbox`
packages — INFERRED to follow the same `approveEscalation` path since
`tool-str-replace-editor` imports `sandboxDenialMarker` from
`@deepseek-ai/dsh-sandbox` and `str_replace_editor` has no
`sandbox_permissions` schema fields itself — UNKNOWN, not directly confirmed
by reading `dsh-fs`/`dsh-fs-sandbox` source) call `ctx.approval` **directly
inside their own body**, bypassing the `tools/pre-execute`/`ask` seam
entirely. The seam and the concrete usage are two parallel, only
loosely-related mechanisms sharing the same underlying `ApprovalService`.

---

## 6. `additionalContexts` and `concludesTurn`

Both live only on `ToolExecutionSuccess`/failure result objects
(`index.ts:549-573`) and both propagate the same way through composite tools
(explicitly documented as parallel in `ToolRunContext.concludeTurn`'s JSDoc,
`index.ts:405-413`: "forwards it from the nested result, exactly like
additionalContexts").

### `additionalContexts: UserMessage[]`

Populated three ways:
1. `exec.deferContext(context)` calls during the tool body — collected into a
   per-execution array (`deferredContexts` WeakMap, `index.ts:797`,
   `1356/1383-1384/1408`) and merged into the dispatch result at
   `index.ts:1572-1580`.
2. A `tools/post-execute` listener's `PostToolDecision.additionalContexts`
   (`index.ts:590-593`, merged at `postExecute`, `index.ts:1738/1751-1754`).
3. For `run_code`, every image-bearing sub-dispatch result and every
   sub-dispatch's own `additionalContexts` are forwarded into the OUTER
   `run_code` call's `deferContext` (`ptc.ts:561-569`) — so a nested tool call
   inside a program can still inject context into the model's next turn even
   though its own result never enters model history directly.

Consumption: the agent loop's `runGroup` reads `result.additionalContexts`
off each committed result and calls the caller-supplied `acceptContext`
(`agent-loop/src/tool-calls.ts:157`), which "stages it in its next-step inbox
for the step boundary" (module doc, `tool-calls.ts:45-46`) — i.e. these
become new `UserMessage`s injected before the next model step, NOT part of
the tool-result message itself.

Real producer: `packages/goal/tool-goal/src/index.ts:312-324` — after a
goal-round tool call reports `complete`/`blocked` with
`authority.kind === 'goal-round'`, it calls:
```ts
exec.deferContext(createUserMessage({
  content: args.action === 'complete' ? renderWrapupContext(goal.objective) : renderWrapupContext(goal.objective, args.blocked_reason as string),
  source: { kind: 'plugin', plugin: 'tool-goal', form: 'notice', summary: ... },
}))
```
`renderWrapupContext` (`packages/goal/tool-goal/src/wrapup.ts:9-16`+) builds
the closing-message instruction telling the model to address the user before
the turn ends — this replaced "the former hard turn stop" per its own doc
comment, i.e. it is now injected as *additional context* rather than forcing
`concludesTurn`.

### `concludesTurn?: true`

Set via `exec.concludeTurn()` (`index.ts:385-387`, `1806`,
`concludingExecutions` WeakSet keyed by the live execution). Only
`createSuccessResult` ever stamps `concludesTurn: true` onto a result
(`index.ts:1806-1812`) — a failed result can never carry it (`ToolExecutionFailure.concludesTurn` is typed `never`, `index.ts:569`), and `postExecute`'s `block` branch cannot resurrect it either.

Real producer: `packages/subagent/subagent-in-process-driver/src/structured.ts:94`
— the in-process subagent driver's structured-output tool calls
`exec.concludeTurn()` immediately after staging the model's structured
answer, so the agent loop stops running further steps once this result
commits. The `run_code` bridge forwards a nested `concludesTurn` from ANY
sub-dispatch outward via `if (result.concludesTurn) exec.concludeTurn()`
(`ptc.ts:575`) — explicitly gated on `result.concludesTurn` rather than
blindly, "so a policy-converted failure cannot stop the turn through a
recovering program" (comment at `ptc.ts:571-574`).

Consumption: `agent-loop/src/tool-calls.ts:158` → `concluded ||= result.concludesTurn === true`, bubbled up through `runGroup`'s `GroupOutcome.concluded` (line 37-39) and `executeToolCalls`'s return value (`{ concluded }`, line 67, 95). UNKNOWN — not chased further — exactly how the driver loop upstream of `executeToolCalls` uses `{ concluded }` to stop stepping (out of scope: that lives in `agent-loop`'s step driver, not `tool-calls.ts`).

---

## 7. Argument parsing and validation

### Parsing (agent-loop, before the registry ever sees the call)

`packages/core/agent-loop/src/tool-calls.ts:104-111`:

```ts
function parseArguments(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return raw
  }
}
```

Empty string → `{}`. Valid JSON → parsed value (may be any JSON type, not
necessarily an object — nothing here enforces an object shape). Invalid JSON
→ the **raw string itself** is passed through as `exec.arguments`.

### What happens to malformed/invalid arguments downstream

1. `createExecution` (`index.ts:1402-1406`) snapshots `exec.arguments` via
   `snapshotJsonValue` — a raw non-JSON string is still valid JSON data (a
   string), so this snapshot step does not reject it; only genuinely
   non-lossless values (e.g. containing `-0`, non-finite numbers, functions)
   would fail here, producing a `final-result` `ToolOutputError`-flavored
   `toolErrorResult` before dispatch even starts.
2. `executionMode(exec)` — a tool's `isConcurrencySafe(args)` is a
   `defineTool`-wrapped classifier that validates args first and returns
   `false` on any violation (`schema.ts:610-615`), so malformed arguments are
   fail-closed to `exclusive` scheduling, never crash the classifier.
3. Inside `dispatchToolBody`, `tool.execute(exec.arguments, exec)` runs. For a
   `defineTool`-defined tool, this is where real validation happens:
   `schema.ts:585-589` → `validateJsonSchemaValue` against the compiled
   parameter schema; on any violation, throws `ToolArgsError` (`schema.ts:461-470`,
   `HarnessError` subtype, `code: 'INVALID_ARGS'`, message
   `` `invalid arguments: ${violations.join('; ')}` ``, carrying every
   violation, not just the first).
4. That throw is caught by `dispatchToolBody`'s catch (`index.ts:1545-1546`)
   → `toolErrorResult(error)` → `isError: true` result with
   `error.info = { name: 'ToolArgsError', code: 'INVALID_ARGS' }`
   (`errorInfo`, `index.ts:635-641`, keys off `error instanceof HarnessError`).
   This becomes a normal (non-pipeline) `post-result`, so it **still goes
   through `tools/post-execute` and content finalization** exactly like a
   successful call — the model sees `Error: invalid arguments: ...` as the
   tool result content and can retry within the same turn (this is stated
   explicitly as a design intent in a comment on the structured-output tool,
   `subagent-in-process-driver/src/structured.ts:87-89`: "the model retries
   within the same turn, exactly like a schema-validated defineTool call").
5. A raw (non-`defineTool`) `ToolDefinition` is NOT auto-validated — validation
   is entirely opt-in per-tool via `defineTool`; a hand-built `ToolDefinition`
   that never validates its `args` would receive whatever `parseArguments`
   produced, including a bare string, with no framework-level rejection.
   UNKNOWN — not verified — whether any shipped tool is defined this way in
   production (the raw-definition path is exercised only by
   `core/tools` package tests as of this reading).

Path summary: malformed JSON never crashes the pipeline; it becomes either
(a) a `ToolArgsError` result if the tool uses `defineTool` (the overwhelming
majority of first-party tools, confirmed for `bash`, `str_replace_editor`,
`tool-fs` reads, `tool-web`), reported to the model as a retryable tool error,
or (b) whatever the tool's own hand-rolled `execute` does with an `unknown`
value, for a raw `ToolDefinition`.

---

## 8. Two concrete tools, end to end

### 8a. `bash` — `packages/shell/tool-bash/src/index.ts`

- Registered at `apply(ctx, config)` (line 189), `ctx.tools.register(defineTool({...}))` at line 241.
- `name: 'bash'`, `description` built by `bashDescription()` (lines 69-92), which conditionally appends sandbox-escalation guidance only when `escalationModes.length > 0` (i.e. the mounted shell executor confines — `ctx.shell.sandboxMode !== undefined`, line 191-192).
- `parameters`: `command`, `description` (both required strings), optional `timeoutMs`, `workdir`, conditionally `run_in_background` (if `enableRunInBackground`), conditionally `sandbox_permissions`/`justification` (if `escalationModes.length > 0`) — lines 244-269.
- `output.schema`: a `oneOf` of two object shapes — `{kind:'background', jobId}` or `{kind:'foreground', exitCode, signal, timedOut, aborted, timeoutMs, stdout, stderr, sandbox?}` (lines 270-321).
- `execute` (lines 329-389): validates args (`validateBashArgs`, includes the shared `validateEscalationArgs` pairing check from `dsh-sandbox`), resolves the standing sandbox policy per-agent-session, optionally escalates via `approveBashEscalation`→`approveEscalation` (in-body approval, §5b), resolves `workdir` relative to the session cwd, then either starts a background job via `ctx.jobs.start(...)` (returns `{kind:'background', jobId}` immediately) or runs synchronously via `ctx.shell.run(...)` and returns `{kind:'foreground', ...canonicalBashResult(result)}`. Aborted execution throws a `HarnessError('tool call aborted', TOOL_ABORTED)` renamed to `'AbortError'`.
- `isConcurrencySafe`: **not declared** → always `exclusive` (§4).
- `presentCall`/`presentResult`: `presentBashCall` renders a `TerminalCallView` for foreground calls (or `GenericCallView` for background starts); `presentBashResult` renders a `TerminalCallView` (parsing the `[exit code: N]` marker into a pill) or falls back to a fenced generic block for background/erroring results.
- Timeout: no `timeoutMs` static field on the definition itself — per-call `timeoutMs` argument is passed down into the shell executor's own request instead of the registry's cooperative `ToolDefinition.timeoutMs` field.

### 8b. `str_replace_editor` — `packages/fs/tool-str-replace-editor/src/index.ts`

- Registered by `registerStrReplaceEditor(ctx, config)` (line 426), called from `apply(ctx, config)` (line 519), via `ctx.tools.register(defineTool({...}))` (line 428).
- `name: 'str_replace_editor'`; one `command` enum (`view|create|str_replace|insert`) dispatches to four internal async functions (`viewPath`, `createFile`, `replaceInFile`, `insertInFile`).
- `output.schema: { type: 'string' }` — unlike `bash`, the canonical value is a single human-readable string (no structured JSON payload); `render` just wraps it in one text block (line 469).
- Mutation policy: `class MutationPolicy` (lines 66-87) resolves the sandbox policy per-call (`ctx.get('sandboxPolicy')`, required when `ctx.fs.sandboxMode !== undefined`, throwing a composition error otherwise) and rewrites an `FS_SANDBOX_DENIED` `FsError` into the shared `sandboxDenialMarker(mode)` text — but note this tool has **no `sandbox_permissions`/`justification` schema fields at all**; escalation for filesystem writes is not exposed as arguments on this tool (UNKNOWN whether escalation for fs writes exists elsewhere — not chased into `dsh-fs`/`dsh-fs-sandbox` source).
- `execute` per-command: `view` reads a file (`ctx.fs.readText`) or lists a directory 2 levels deep, emitting `fs/observed` events; `create` calls `ctx.fs.writeText` with intent `{kind:'createIfAbsent'}` after a `fs/write-intent` waterfall; `str_replace` requires the `old_str` to match exactly one location (throws `FsError('FS_EDIT_NOT_FOUND')` or `FsError('FS_AMBIGUOUS_EDIT')` otherwise) and writes with `{kind:'replaceIfVersion', version}` (optimistic concurrency against a `fs/edit-intent` waterfall or the last-read `info.version`); `insert` splices lines similarly.
- `isConcurrencySafe`: **not declared** → always `exclusive`, even for the read-only `view` command (contrast with `tool-fs`'s dedicated `read` tool, which DOES declare `isConcurrencySafe: () => true` — these are two different first-party file-reading tools with different concurrency policies).
- `presentCall`: `presentEditorCall` (lines 376-423) returns a `DiffCallView` for `create`/`str_replace` (with `oldText`/`newText`) or a `GenericCallView` for `view`/`insert`. No `presentResult` — falls back to generic rendering of the raw string result.

---

## 9. `TOOL_ABORTED_BEFORE_DISPATCH`

`packages/core/tools/src/index.ts:465` →
`export const TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'`

Paired with `TOOL_ABORTED = 'ABORTED'` (`index.ts:462`). Both are
`ToolErrorInfo.code` values (`index.ts:468-471`), the closed distinction
being **whether the tool body was ever invoked**:

- `toolAbortedBeforeDispatchResult()` (`index.ts:1924-1935`) — used whenever
  cancellation is observed BEFORE `dispatchToolBody` sets
  `state.bodyInvoked = true`: at `createExecution` for an already-collapsed
  call (`index.ts:1420`), at the top of `prepareExecution` (`index.ts:1462`),
  after a cancelled approval `ask` (`index.ts:1475`), after guard/pre-execute
  denial with a subsequent abort (`index.ts:1492`), and inside
  `dispatchToolBody` itself if the fused signal is already aborted before the
  tool is even looked up (`index.ts:1531-1534`). Message: `'Error: tool call
  aborted before dispatch'`.
- `toolAbortedResult()` (`index.ts:1910-1921`) — used when
  `state.bodyInvoked === true` (the tool's `execute()` actually started) and
  cancellation is later observed, via `cancellationResult()`
  (`index.ts:1509-1516`) picking between the two based on
  `state.bodyInvoked`. Message: `'Error: tool call aborted'`.

Consumer: `agent-loop/src/tool-calls.ts:249-260` (`appendSkippedToolCall`) —
every model-requested tool call that the scheduler skips entirely after an
abort (never even reaches `prepare()`) gets a **synthetic** `tool/call` +
`tool/result` pair appended with exactly this code, "so replay stays valid"
(module doc, `tool-calls.ts:8`). So `TOOL_ABORTED_BEFORE_DISPATCH` is not dead
code — it is the canonical code for two distinct but related situations: (a)
a call that started `prepare()` but was cancelled before the body ran, and
(b) a call that the agent-loop scheduler never even started because an
earlier sibling's abort short-circuited the whole batch.

Not found: any code path that could react differently to `TOOL_ABORTED` vs
`TOOL_ABORTED_BEFORE_DISPATCH` downstream (e.g. a retry policy). UNKNOWN —
checked only `packages/core/tools` and `packages/core/agent-loop`; a
consumer in `packages/guard/timeout-policy` or elsewhere was not read in
this pass, so whether any policy branches on this specific code is
unconfirmed.

---

## Other notable findings (flagged, not directly asked)

- **`ToolExecutionMode` is genuinely re-read live, not cached per call**:
  the agent-loop's `fillPool()` re-invokes `ctx.tools.executionMode(nextCall.exec)`
  immediately before starting each subsequent call in a parallel group
  (`tool-calls.ts:200-205`), and breaks out of the pool early (forming a new
  barrier) the moment a later call reclassifies as non-parallel — so a
  registry mutation mid-batch (e.g. an agent's tool restriction changing)
  can retroactively split a batch that started as all-parallel.
- **`run_code` (PTC mode) is a full nested scheduler**, not a simple loop
  over sub-calls: it re-implements the SAME ordered-prepare / overlapping-dispatch
  / ordered-commit discipline as the top-level agent-loop scheduler, using
  the identical `TOOL_RUNTIME_SCHEDULER` interface (`ptc.ts:280-587`). This
  is a second, independent consumer of the same internal scheduler symbol,
  confirming `TOOL_RUNTIME_SCHEDULER` is deliberately package-private-but-not-instance-private
  (exported from `index.ts:459` but typed `@internal`).
  Sub-dispatch under PTC mode always uses `parent: exec.token` (`ptc.ts:476`),
  which is what lets a nested call bypass the `mode:'ptc'` model-direct
  collapse (§2, `collapses()`).
- **Approval "never" policy is intentionally NOT waterfall-overridable**:
  `ApprovalService.decide()` special-cases `policy === 'never'` inline
  (`user-approval/src/index.ts:277`) rather than as an early `approval/request`
  listener, specifically so no listener registration order can leak a grant
  through — a deliberate hardening choice worth noting as a security-relevant
  design decision.
- **`finalizeContent` is captured at call-creation time, not at finish time**:
  `contentFinalizers.set(execution, finalizerFor())` happens inside
  `createExecution` (`index.ts:1409`, `1439`), before policy runs — so a tool
  that unregisters itself (or is unregistered by a hot-reload) mid-flight
  still gets its OWN `finalizeContent` applied to its own outcome, not
  whatever tool now occupies that name.
