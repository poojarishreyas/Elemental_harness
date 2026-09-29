# Prompt assembly, runtime context injection, and the Agent extension-point surface

Scope of this note: `packages/core/system-prompt/**`, `packages/context/**`, `packages/core/agent/**`,
plus the consuming call sites in `packages/core/agent-loop/src/agent.ts` and
`packages/core/agent-loop/src/runtime-context.ts`. All claims are cited as
`path:LINE → symbol()`. Anything not directly confirmed in code is marked UNKNOWN or INFERRED.

---

## 1. `PromptAssembly`, `systemPrompt.assemble()`, contributing fragments, `renderPrompt()`

### 1.1 The type

`packages/core/system-prompt/src/index.ts:114-119 → interface PromptAssembly`:

```ts
export interface PromptAssembly {
  sections: AssembledSection[]
  contexts: AssembledContext[]
  tools: ToolSchema[]
  variables: Record<string, string | undefined>
}
```

- `sections` — ordered `{ name, text }` pairs (`AssembledSection`, line 87-92) that become the
  literal system prompt string once `renderPrompt()` interpolates and joins them.
- `contexts` — ordered `{ name, text }` pairs (`AssembledContext`, line 95-100) that become the
  **dynamic runtime-context snapshot**, a separate artifact from the system prompt (see §3/§4).
- `tools` — the canonically ordered `ToolSchema[]` visible to this exact assembly.
- `variables` — the resolved `{{name}}` substitution table (`Record<string, string | undefined>`).

Both `sections` and `contexts` text values remain **uninterpolated** at this point
(`index.ts:112-113`, doc comment on `PromptAssembly`): `{{variable}}` references are only expanded
later by `renderPrompt` / `renderContextSections`.

### 1.2 How contributors add fragments

Two registries live on the `SystemPrompt` service, each a `NamedEntries<T>` inside a `PromptLayer`
(`index.ts:355-386 → class PromptLayer`), one global layer plus one layer per scope key
(`ScopedLayers`, from `@deepseek-ai/dsh-scope`, `packages/core/scope/src/store.ts:159-267`):

- **`systemPrompt.section(section: PromptSection)`** (`index.ts:432-441`) registers a
  `PromptSection` (`index.ts:53-74`): `{ name, order, text, complete? }`. `text` is either a
  literal string or `(context: AssembleContext) => string`. Duplicate names within one layer throw
  (`PromptLayer` constructor, `index.ts:366-376`); a scoped section of the same name **shadows** a
  global one (see §1.3).
- **`systemPrompt.context(context: PromptContext)`** (`index.ts:467-476`) registers a
  `PromptContext` (`index.ts:77-84`): `{ name, order, text }`, feeding `PromptAssembly.contexts`
  instead of `sections`.
- **`systemPrompt.tools(provider)`** (`index.ts:499-505`) registers a
  `(context: AssembleContext) => ToolProviderResult` (`ToolProviderResult`, line 103-108: `{
  schemas, knownNames? }`). Unlike sections/contexts, tool providers are **anonymous**
  (`AnonymousEntries`, `store.ts:114-150`) — multiple registrations coexist without name
  collisions; the tool *names themselves* are what must stay unique (checked at render/order time,
  not registration time).
- **`systemPrompt.variable(name, provider)`** (`index.ts:515-524`) registers a
  `(context: AssembleContext) => string | undefined`, keyed like sections/contexts.

All four registration methods return `() => void`, the exact Cordis effect disposer
(`ScopedLayers.effect`, `store.ts:226-266`); registering/disposing fires `system-prompt/change`
(`index.ts:37`, emitted via the `onChange` callback wired in the `SystemPrompt` constructor,
`index.ts:398-401`).

Central placement constants prevent order collisions: `SECTION_ORDERS` (`index.ts:121-152`, e.g.
`HARNESS_IDENTITY: -1000`, `TOOL_BASH: 1000`, `STRUCTURED_OUTPUT: 9900`) and `CONTEXT_ORDERS`
(`index.ts:157-161`: `SANDBOX_POLICY: 110`, `APPROVAL_POLICY: 115`, `SUBAGENT_DELEGATION: 120`).
`getSectionOrder(name)` / `getContextOrder(name)` (`index.ts:448-459`) look these up; a test
(`packages/core/system-prompt/tests/system-prompt.spec.ts:33-49`) asserts every declared order is a
unique integer at least ten apart.

### 1.3 Ordering / shadowing / composition algorithm — `assemble()`

`index.ts:536-611 → SystemPrompt.assemble(context)`:

1. `scopeLayers = this.layers.chainLayers(scope)` — existing scope-chain overlays, **farthest
   ancestor first, exact scope last** (`ScopedLayers.chainLayers`, `store.ts:192-199`), so nested
   agent scopes can shadow a parent scope which shadows global.
2. Runtime-context suppression is computed as "any suppressor registered globally or in the scope
   chain" (`index.ts:539-540`).
3. **Variables**: global providers evaluate first, then each scope-chain layer's providers
   overwrite by name (`index.ts:542-551`) — "farthest first, so the nearest scope wins a name."
4. **Sections/contexts**: `this.layers.merge(scope, layer => layer.sections)` /
   `...contexts` (`index.ts:553-554`) builds a `Map<string, T>` the same way — global entries first,
   then each scope-chain layer's entries override by name (`ScopedLayers.merge`, `store.ts:208-217`).
   This is literal replacement-by-name, not textual merging: a scoped `deployment:persona` section
   *replaces* the global one under that entry (confirmed by
   `packages/core/system-prompt/tests/scoped.spec.ts:33-44`, "a scoped persona shadows
   deployment:persona for that scope only").
5. **Tools**: every global tool provider plus every scope-chain tool provider is called and their
   schemas concatenated (`index.ts:556-572`) — tool providers do **not** shadow, they all
   contribute (no name-collision check happens for known-name aggregation, only at final ordering
   — see `orderTools`, `index.ts:205-219`, which throws if a provider returns the reserved
   `TOOL_ORDER_REST` name).
6. Sections are sorted by `comparePromptSections` (`index.ts:227-229`): ascending numeric `order`,
   ties broken by code-unit name comparison (`compareNames`, `index.ts:222-224`) — this is
   locale-independent, deterministic across machines.
7. At most one section may have `complete: true` (`PromptSection.complete`, doc at
   `index.ts:68-73`); more than one throws (`index.ts:574-577`). A `complete` section signals
   "treat this as the entire system prompt" but the waterfall (next step) still runs so tools /
   contexts / variables resolve; afterwards the *original* complete section text is forcibly
   restored as the sole section (`index.ts:605-609`), discarding anything the waterfall did to
   `sections`. UNKNOWN — no in-repo consumer of `complete: true` was found by grep in this pass; may
   be dead/unused today (checked `grep 'complete: true'`/`complete:true` across `packages/**/src`
   turned up no producers besides the type itself; would need a full-repo semantic search to be
   certain no deployment config sets it dynamically).
8. The assembled object is run through the **`system-prompt/assemble` waterfall**
   (`index.ts:601-604`): `this.ctx.waterfall(scopeTarget(this, scope), 'system-prompt/assemble',
   assembly, context, () => Promise.resolve(assembly))`. This is the sole "expert" extension point
   for rewriting an entire assembly (doc at `index.ts:19-31`: "listeners cannot add to or replace
   that scope's system prompt" once a complete section is registered — restored right after).
9. Finally, if runtime context was suppressed, `contexts` is forced to `[]` regardless of what the
   waterfall did (`index.ts:605-610`).

An installed invariant (`packages/core/system-prompt/src/invariant.ts:46-52`) wraps the same
`system-prompt/assemble` event with `{ global: true, prepend: true }` and validates the
**post-waterfall** result: non-empty, non-duplicate section/context names, string text, non-empty
tool names, valid variable names/types (`invariant.ts:16-43 → validateAssembly`). This runs as an
Invariant-package companion, not as ordinary business logic — it can only fail loud on
misconfiguration, not repair it.

### 1.4 `renderPrompt()`

`index.ts:263-268 → renderPrompt(assembly)`:

```ts
export function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections
    .map(section => interpolate(section, assembly.variables, 'section'))
    .filter(text => text.length > 0)
    .join('\n\n')
}
```

It interpolates each section's `{{variable}}` references (§2), drops sections that render empty,
and joins the rest with a blank line. Empty input yields `''`. This is exactly the string the loop
passes as `system` to the LLM request (`packages/core/agent-loop/src/agent.ts:346 → step()`: `const
system = renderPrompt(assembly)`).

Confirmed example (`packages/core/system-prompt/tests/system-prompt.spec.ts:52-65`): with
`persona: 'You are DeepSeek Harness.'`, `assembly.sections` is exactly
`['harness:identity', 'deployment:persona']` and
`renderPrompt(assembly) === 'You are an AI agent powered by DeepSeek Harness.\n\nYou are DeepSeek Harness.'`.

---

## 2. Prompt "variables" and their interpolation

A variable is a named `(context: AssembleContext) => string | undefined` provider
(`index.ts:352 → type VariableProvider`), registered via `systemPrompt.variable(name, provider)`
(`index.ts:515-524`). The name must match `VARIABLE_NAME = /^[a-z][a-z0-9_]*$/`
(`index.ts:175`); invalid names throw at registration (`index.ts:516-518`).

During `assemble()` every registered variable is evaluated once per assembly and stored by name in
`PromptAssembly.variables` (`index.ts:542-551`); a provider may legally return `undefined` — the
name still exists in the map (registered), but rendering any section/context that actually
*references* `{{name}}` then fails at render time (doc `index.ts:509-510`; enforced at
`index.ts:339-341`).

### Substitution implementation — `interpolate()`

`index.ts:309-346`. This is a hand-rolled scanner, not a regex-global-replace, specifically so that
substituted values are never re-scanned for further `{{...}}` groups ("substituted values are not
scanned again", doc `index.ts:257`):

```ts
function interpolate(
  input: AssembledSection | AssembledContext,
  variables: Record<string, string | undefined>,
  kind: 'section' | 'context',
): string {
  const text = input.text
  let result = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open))     // /^\{\{([^{}]*)\}\}/
    if (group === null) {
      if (text.indexOf('}}', open + 2) >= 0) throw ...  // malformed: a later }} exists
      result += text.slice(last, open + 2)              // lone "{{" is literal prose
      last = open + 2
      continue
    }
    const name = group[0].slice(2, -2)
    if (!VARIABLE_NAME.test(name)) throw ...
    if (!Object.hasOwn(variables, name)) throw ...      // never falls through Object.prototype
    const value = variables[name]
    if (value === undefined) throw ...                  // registered but no value this assembly
    result += text.slice(last, open) + value
    last = open + group[0].length
  }
  return result + text.slice(last)
}
```

Behavior pinned by this code:
- A `{{` with no matching `}}` anywhere later in the string is literal prose, not an error
  (`index.ts:320-326`).
- A `{{` that *does* have a later `}}` but the content between contains another `{`/`}` (so
  `GROUP_AT` doesn't match) is a hard error ("malformed prompt variable reference").
- `{{}}` (empty name) is also malformed (fails `VARIABLE_NAME`).
- Unknown variable names error with the full list of registered names in the message
  (`index.ts:335-336`).
- A registered-but-`undefined`-valued variable errors distinctly from an unregistered one.

`renderPrompt` calls `interpolate(section, variables, 'section')` per section;
`renderContextSections` calls it per context with `'context'` (§3). Both throw synchronously —
`assemble()` itself doesn't call `interpolate`, so a malformed template is only caught when
`renderPrompt`/`renderContextSections`/`renderContextSnapshot` is actually invoked on the returned
assembly (i.e. by the loop, `agent.ts:241-242,346`).

Known variable producers registered by the loop: `provider`, `model`, `cwd` (per the task
description; not directly inspected in this pass — UNKNOWN, would need to grep
`agent-loop/src/index.ts` for `systemPrompt.variable(`. This note's file-list scope did not include
that file's full read; the three names are asserted by the task brief, not independently verified
here).

---

## 3. Context sections — `renderContextSections()` / `joinContextSections()` and contributors

"Context sections" are the resolved contents of `PromptAssembly.contexts`
(`AssembledContext[]`), rendered as `ContextSnapshotSection` — a type actually owned by the LLM
package, not system-prompt: `packages/llm/llm/src/message.ts:65-70`:

```ts
export interface ContextSnapshotSection {
  readonly name: string
  readonly text: string
}
```

### `renderContextSections()`

`index.ts:302-306`:

```ts
export function renderContextSections(assembly: PromptAssembly): ContextSnapshotSection[] {
  return assembly.contexts
    .map(context => ({ name: context.name, text: interpolate(context, assembly.variables, 'context') }))
    .filter(section => section.text.length > 0)
}
```

Interpolates each context's `{{variable}}`s (same `interpolate()` as sections) and drops empty
results. This is what the loop calls at `agent.ts:241 → sections = renderContextSections(assembly)`.

### `joinContextSections()`

`index.ts:287-291`:

```ts
export function joinContextSections(sections: readonly ContextSnapshotSection[]): string {
  const body = sections.map(section => section.text).join('\n\n')
  if (body.length === 0) return ''
  return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`
}
```

Joins already-rendered sections with the fixed preamble "Current runtime context. This snapshot
supersedes earlier runtime-context snapshots." This is the literal text the loop passes to
`this.runtimeContext.project(...)` (`agent.ts:242`) and eventually to the model as a synthetic
user message (§4). A convenience wrapper, `renderContextSnapshot(assembly)` (`index.ts:275-277`),
composes both calls (`joinContextSections(renderContextSections(assembly))`) for callers that don't
need the per-section attribution — the loop itself calls the two functions separately because it
also needs the `sections` array to pass into `RuntimeContextProjection.project`.

### Who actually contributes `PromptContext` entries

Grepped every call site of `systemPrompt.context(` / `getContextOrder(` in `packages/**/src`.
Exactly three producers exist in the whole repo, matching the three `CONTEXT_ORDERS` constants:

1. **`packages/sandbox/sandbox-policy/src/index.ts:140-151`** — `sandbox:policy`,
   order `SANDBOX_POLICY` (110). Text provider reads `context.agent?.session`, returns `''` for an
   agentless assembly, otherwise `renderPolicyContext(this.resolve({ session }))`.
2. **`packages/interaction/user-approval/src/index.ts:169-181`** — `approval:policy`,
   order `APPROVAL_POLICY` (115). Renders `NEVER_SENTENCE` or `ASK_SENTENCE` depending on the
   agent's effective approval policy; also returns `''` for a bare `assemble()` with no agent
   (comment: "A bare assemble() (tests, diagnostics) has no session to state").
3. **`packages/subagent/subagent/src/child-agent.ts:205-209 → applyChildComposition()`** —
   `subagent:delegation`, order `SUBAGENT_DELEGATION` (120), a static `SUBAGENT_DELEGATION_CONTEXT`
   string, registered directly on `childCtx` (not behind `ctx.inject`) as part of composing a
   child (subagent) agent's scope.

**Important, book-relevant finding**: none of the packages that live under `packages/context/**`
(`agent-instructions`, `file-reference`, `file-reference-local`, `session-reference`,
`time-context`, `tmux-context`) use `systemPrompt.context()` at all. Despite the directory name
"context", these packages inject content through the **`agent/pre-step` waterfall** directly,
appending or prepending durable `UserMessage`s into the messages that enter the step — a
structurally different mechanism from the `PromptContext` / runtime-context-snapshot pipeline (see
§7 for the full `agent/pre-step` contract). Concretely:
- `time-context` prepends a synthetic user message with the current timestamp on `agent/pre-step`
  (`packages/context/time-context/src/index.ts:178-218`, listener registered with `{ prepend: true
  }`).
- `tmux-context` does the same for tmux pane location, only on `step === 1`
  (`packages/context/tmux-context/src/index.ts:236-264`).
- `agent-instructions` composes/reconciles a workspace-instructions message and splices it into
  `decision.messages` right after the claimed batch (`packages/context/agent-instructions/src/index.ts:313-339`).
- `session-reference` rewrites direct user messages that cite `@session` mentions and appends a
  `session-reference` context message after each citing message
  (`packages/context/session-reference/src/index.ts:111-118, 129-153`).
- `file-reference-local` does **not** touch `agent/pre-step` at all; it registers an ordinary
  **`PromptSection`** (`context:file-reference`, order `FILE_REFERENCE`) via
  `scope.systemPrompt.section(...)` (`packages/context/file-reference-local/src/index.ts:66-76`),
  gated on whether the `read` tool is registered for that agent.

So "context" in `packages/context/**` names a *product category* (things that inject situational
information into a step), not a shared implementation of the `PromptContext` mechanism defined in
`system-prompt`. Only sandbox-policy, user-approval, and subagent's child composition actually use
`systemPrompt.context()` / the runtime-context-snapshot pipeline described in §4.

---

## 4. `RuntimeContextProjection` (`packages/core/agent-loop/src/runtime-context.ts`, 77 lines)

### Purpose

Tracks, across resumes and compaction, whether the *last durable runtime-context snapshot message*
committed to the session still matches the *current* rendered snapshot, and produces a fresh
`UserMessage` to append only when it differs. It does not itself commit anything — "Tracks the last
retained runtime-context snapshot without owning its commit" (doc, line 24).

### State

```ts
private retained: { seq: number; text: string | undefined } | null | undefined
```
(`runtime-context.ts:27`) — three-way: `undefined` = "no snapshot message has ever existed in this
session", `null` = "one existed once but is no longer retained (e.g. compacted away)", `{ seq, text
}` = "this exact durable event is the currently-visible snapshot."

### Construction — replay

`runtime-context.ts:34-56 → constructor(ctx, session)`:
1. Builds `surface = new Set(session.surface.nodes)` — the currently-visible (non-superseded) event
   sequence numbers.
2. Walks `session.events` **backwards**, looking for the newest `user/message` event whose data is
   "owned" by this mechanism: `isOwned(message)` (`line 15-17`) checks
   `message.source.kind === 'plugin' && message.source.plugin === '@deepseek-ai/dsh-system-prompt'`
   (`SOURCE`, line 12). The **first** such event found (scanning backwards) sets `this.retained`:
   if it's still on the visible `surface`, `retained = { seq, text: textOf(event.data) }`
   and the scan stops (`break`, line 43); if the newest owned message is *not* on the surface
   (superseded/compacted), `retained` is left at `null` (set once via `this.retained ??= null` at
   line 39, then the loop continues scanning further back but no `break`, so it can never find an
   older one either since the loop only sets `retained` when unset — actually re-reading: `??=`
   only assigns if currently `undefined`, so once one owned-but-invisible message is seen,
   `retained` becomes `null` and stays `null` unless a later (i.e., scanned-earlier, since we go
   backwards) owned+visible message is found, which would then overwrite it to the `{seq,text}`
   branch and `break`).
3. Registers a live `session/event` listener (`line 46-55`) that keeps `retained` current
   thereafter: a new owned `user/message` event updates `retained` to that event; a
   **replacement/surface event** (`isReplacementSurfaceEvent`, from `dsh-session`) whose
   `sourceEventSeqs` includes the currently retained `seq` clears `retained` back to `null` (i.e.,
   compaction/replacement invalidates the tracked snapshot).

### `project(current, sections)` — when it returns `undefined` vs a message

`runtime-context.ts:64-75`:

```ts
project(current: string, sections: readonly ContextSnapshotSection[]): UserMessage | undefined {
  if (this.retained === undefined && current.length === 0) return
  const snapshot = current.length === 0 ? CLEARED : current
  if (this.retained?.text === snapshot) return
  return createUserMessage({
    content: [{ type: 'text', text: snapshot }],
    source: sections.length === 0
      ? { kind: 'plugin', plugin: SOURCE }
      : { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections },
  })
}
```

Exact rules:
- **No-op case 1**: nothing has ever been injected (`retained === undefined`) *and* the current
  rendered context is empty (`current === ''`) — there's nothing to say and nothing to retract, so
  return `undefined`. This is why an ordinary session with no sandbox/approval/subagent context
  producers active never gets a synthetic runtime-context message at all.
- Otherwise, the candidate text is either `current` (non-empty) or the fixed sentinel `CLEARED =
  'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'`
  (`runtime-context.ts:13`), used to explicitly retract a previously-visible snapshot when the live
  context has gone empty.
- **No-op case 2**: if the retained text already equals the computed `snapshot` (including both
  being the `CLEARED` sentinel), nothing changed — return `undefined`. This is the primary
  dedup mechanism: it prevents appending an identical runtime-context message every single step.
- Otherwise, build and return a brand-new `UserMessage` carrying the snapshot text, tagged as
  `source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections }`
  (or the bare 2-field source when `sections` is empty, i.e. when retracting via `CLEARED` — "The
  cleared marker has no contributions left to attribute", line 70-71).

Confirmed by test `packages/core/agent-loop/tests/runtime-context.spec.ts:16-45`: a retained,
still-visible snapshot ("retained") makes `project('retained', [])` return `undefined`; a changed
value ("next") returns a message whose `.source` carries the given `sections`; a message committed
to a *different* session never affects this projection's view of the first.

### When and why this becomes an injected `UserMessage` in the step

Call site: `packages/core/agent-loop/src/agent.ts:239-249 → preStep()`:

```ts
const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
signal.throwIfAborted()
const sections = renderContextSections(assembly)
const context = this.runtimeContext.project(joinContextSections(sections), sections)
const decision = await this.dispatch.waterfall(
  'agent/pre-step', { messages: claimed, ...position, signal },
  (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
    kind: 'enter',
    messages: context === undefined ? claimed : [...claimed, context],
  }),
)
```

So: **every** `preStep()` call (i.e. every proposed step, whether it opens a new turn or continues
one) re-assembles the full `PromptAssembly`, re-renders the current context-snapshot text, and asks
`RuntimeContextProjection.project()` whether that text differs from what's already durable and
visible in the session log. If it does, the resulting synthetic `UserMessage` is appended to the
default `'enter'` decision's `messages` **as the innermost default of the `agent/pre-step`
waterfall** — i.e., before any `agent/pre-step` listener runs, since it's baked into the `next()`
this waterfall wraps around. A listener that calls `next()` inherits this message; a listener that
returns a hand-built decision without calling `next()` can omit it entirely (this is exactly how a
`'reject'` decision or a plugin building its own `messages` array can suppress runtime context for
that step). Because `project()` only returns a message when the text actually changed since the
last committed one, most steps in a stable session (no sandbox-mode change, no approval-policy
flip, not a subagent) never see a runtime-context message at all — the mechanism is
change-triggered, not once-per-step.

Once `decision.messages` (now including any injected context message) is finalized, `turn()`
durably appends each of them: `packages/core/agent-loop/src/agent.ts:291-293`:
```ts
for (const message of decision.messages) {
  this.session.append('user/message', message, { surfaceOp: 'append' })
}
```
This is the point where the synthetic context message becomes part of the durable, model-visible
session log — indistinguishable in storage from any other `user/message`, just tagged by its
`source.plugin` field.

---

## 5. `Inbox` (`packages/core/agent/src/inbox.ts`)

### Shape

`Inbox` (`inbox.ts:25-220`) is a replay-once projection over one durable event type,
`agent/inbox/spliced` (declared in `packages/core/agent/src/types.ts:57-65`), maintaining two
ordered `UserMessage[]` lists keyed by `InboxTarget = 'next-turn' | 'next-step'`
(`types.ts:29`, `InboxState`, `inbox.ts:12`).

- `nextTurn` (`inbox.ts:43-45`) / `nextStep` (`inbox.ts:47-49`) are read-only views.
- `hasPending` (`inbox.ts:52-55`) = either list non-empty.

### Construction / replay

`inbox.ts:28-40`: replays every `agent/inbox/spliced` event in `session.events` starting at
`session.header.seedLength ?? 0` (skipping seeded/forked prefix events, which a fork's own log
already encodes structurally), applying each via the private `apply()` (`inbox.ts:196-200`), which
does no notification — pure state reconstruction. A malformed persisted splice throws
(`inbox.ts:34-39`).

### `splice(target, start, deleteCount, inserted)`

`inbox.ts:139-146` delegates to `mutate(target, start, deleteCount, inserted, discardRemoved=true)`
(`inbox.ts:157-193`). This is a **durable-first** mutation:
1. Normalizes `start`/`deleteCount` exactly like `Array.prototype.splice` (clamping to bounds,
   truncating non-integers) — `inbox.ts:166-176`.
2. Builds a normalized splice record (`target, start, removedCount?, inserted, outcome?`) and calls
   `this.validate(splice)` (`inbox.ts:202-219`), which re-derives the resulting list via
   `Array.prototype.toSpliced` and asserts no duplicate message `id` appears across *both* lists
   combined (a message can be pending in at most one target at a time) — throws `"message ... is
   already pending"` otherwise.
3. **Commits the durable session event first**: `this.session.append('agent/inbox/spliced',
   splice)` (`inbox.ts:186`) — "so synchronous `session/event` observers see the pre-splice lists"
   (doc, line 130-132). Only *after* that does it mutate the in-memory `state[target]` array
   (`inbox.ts:187`).
4. Publishes live notifications via the injected `InboxNotifications` callbacks
   (`discarded`/`inserted`, `inbox.ts:188-191`) — for `splice()`, `discardRemoved = true`, so
   removed messages get `discarded()` calls.
5. Returns the removed messages.

`append`/`prepend`/`replace`/`remove` (`inbox.ts:86-126`) are all thin convenience wrappers around
`splice()`.

### `claim(target, turn)`

`inbox.ts:63-78`, marked `@internal - The agent loop's step-boundary operation, not a plugin
extension point`:

```ts
claim(target: InboxTarget, turn: number): UserMessage[] {
  const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
  if (target === 'next-turn') {
    claimed.push(...this.mutate('next-turn', 0, 1, [], false))
  }
  for (const message of claimed) this.notifications.claimed(message, turn)
  return claimed
}
```

It always drains the **entire** `next-step` list, and *additionally* pops **one** item off the
front of `next-turn` only when `target === 'next-turn'` (i.e. this proposed step is also allowed to
open/continue a queued ordinary turn). The 5th argument to `mutate` (`discardRemoved`) is `false`
here, so claimed messages are **not** reported as `discarded` — instead each is reported via
`notifications.claimed(message, turn)` (distinct from both `inserted` and `discarded`). This is the
loop's sole mechanism for pulling pending inbox content into an active step
(`preStep()`, `agent.ts:238 → const claimed = this.inbox.claim(target, position.turn)`).

### `clear()`

`inbox.ts:58-61`:
```ts
clear(): void {
  this.splice('next-step', 0, this.nextStep.length, [])
  this.splice('next-turn', 0, this.nextTurn.length, [])
}
```
Durably discards **everything** pending in both lists, `next-step` first. Called from
`ReactLoopAgent.cancel()` (`agent-loop/src/agent.ts:143-149`) unless `options.keepInbox` is set.

### `hasPending` / `nextStep`

Already covered above; `nextStep` specifically backs the loop's turn-continuation check
(`agent.ts:304,308 → if (turnEnds && this.inbox.nextStep.length === 0) ...`): a turn only closes
once `nextStep` is drained.

### `'next-turn'` vs `'next-step'` — what actually differs

Both are just named lists inside the same `Inbox`; the distinction is entirely in how `claim()`
consumes them (§ above) and in how the driver schedules a wake:
- `next-step` content is claimed **every** `preStep()` call regardless of `target`, and is claimed
  in full (all pending entries at once).
- `next-turn` content is claimed **only** when `target === 'next-turn'` (i.e. the *first* step of a
  fresh turn, or explicitly re-armed — see `agent.ts:270 → let target: InboxTarget = 'next-turn'`
  at the top of each `turn()`, switching to `'next-step'` after the first step,
  `agent.ts:309 → target = 'next-step'`), and only **one** entry is popped per turn (`deleteCount =
  1`, `inbox.ts:74`) — so `next-turn` behaves like a strict FIFO of "one whole turn's worth of
  prompt" while `next-step` is "everything pending, drained together, every step."

### `followup()` / `steer()` / `inject()` — real differences

All three route through the single private `send()` method
(`packages/core/agent-loop/src/agent.ts:122-129`):

```ts
send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
  const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
  const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
  this.inbox.splice(resolvedTarget, Infinity, 0, [message])
  if (wakeup) this.wakeDriver(wakingAfterAbort)
}

followup(input: UserMessage): void { this.send(input, 'next-turn', true) }
steer(input: UserMessage): void    { this.send(input, 'next-step', true) }
inject(input: UserMessage): void   { this.send(input, 'next-step', false) }
```

So the three differ on exactly two independent axes — **which list** (`target`) and **whether
delivery may wake an idle driver** (`wakeup`):

| method     | target      | wakeup | effect |
|------------|-------------|--------|--------|
| `followup` | `next-turn` | true   | queues one ordinary prompt turn and wakes the driver if idle |
| `steer`    | `next-step` | true   | queues step-level content and wakes the driver if idle |
| `inject`   | `next-step` | false  | queues step-level content, never wakes the driver by itself |

Documented semantics (`packages/core/agent/src/runtime-types.ts:125-149`):
- `followup(message)` — "Queue an ordinary follow-up turn and wake the driver. The item becomes
  the sole ordinary message of its own turn." Because it targets `next-turn` and `claim()` only
  pops one `next-turn` entry per turn opening, each `followup()` call becomes exactly one turn's
  worth of prompt content (assuming default 1-message calls; nothing stops appending multiple
  messages structurally but the documented contract treats it as "one item = one turn").
- `steer(message)` — "Submit steering for the nearest step. An idle driver starts a turn; a running
  driver consumes it at its next step boundary. A rejected step leaves steering parked in the
  inbox." Because it targets `next-step`, a *running* driver picks it up at the very next
  `preStep()` (every step drains all of `next-step`), not waiting for the current turn to end.
- `inject(message)` — "Queue model-facing context for the next pre-step without waking the driver.
  A running driver claims it at the nearest later step boundary; idle drivers leave it pending
  until follow-up or steering wakes them." So `inject()` alone on an idle agent produces **no**
  activity at all — confirmed by test
  `packages/core/agent-loop/tests/agent.spec.ts:31-42 ("idle inject() durably stages context
  without opening a turn")`: after `agent.inject(...)`, `agent.session.events` contains only the
  `agent/inbox/spliced` event, `agent.status` stays `'idle'`, and the mock adapter records zero
  requests.

The `wakingAfterAbort` branch (`agent.ts:124-126`) additionally guarantees that if a `steer()` (or
any wake-capable `send`) races an already-aborting driver, its message is re-routed to `next-turn`
so it can't be silently dropped mid-abort convergence — captured *before* the splice so a reentrant
listener-triggered cancel during the splice cannot reclassify it (comment, `agent.ts:124-125`).

---

## 6. `AgentEventDispatch` and `emit` / `waterfall` / `serial`

### `AgentEventDispatch`

Defined in `packages/core/agent/src/dispatch.ts:54-82`. It is a **fused, agent-scoped wrapper**
around three raw Cordis dispatch primitives, built once per agent
(`agent-loop/src/agent.ts:94 → this.dispatch = agentEvents(loopCtx, this)` in the constructor, kept
for the agent's lifetime so hot-path dispatches allocate nothing extra — doc, `dispatch.ts:79`).
`agentEvents(ctx, agent, carrier?)` (`dispatch.ts:107-149`) returns an object whose three methods
(`emit`, `serial`, `waterfall`) all:
1. inject the `agent` field into the payload the caller passes (`PayloadRest<K>` — the declared
   payload type minus `agent`, so a caller literally cannot spoof a different subject —
   `dispatch.ts:47,113-118`), and
2. dispatch using `scopeTarget(agent, agent)` as the Cordis `thisArg` (the "carrier",
   `agentCarrier()`, `dispatch.ts:94-96`), which restricts delivery to listeners whose declared
   scope is this agent or an ancestor scope (`scopeTarget`, `packages/core/scope/src/index.ts:170-185`).

This coupling is deliberate ("the agent's scope carrier so the scope key and the payload's `agent`
cannot diverge", module doc `dispatch.ts:2-6`): every `agent/*` event whose type ends in
`(this: Scoped<Agent>, payload: { agent: Agent; ... })` is dispatched exclusively through this
fused surface (`AgentSubjectEvent`, `dispatch.ts:28-34`, a mapped-type filter over the global
`Events` interface).

### Underlying Cordis primitives (`vendor/cordis/src/events.ts`)

- **`emit`** (`vendor/cordis/src/events.ts:194-196`):
  ```ts
  emit(...args: any[]) {
    this.dispatch('emit', args).map(cb => cb(...args))
  }
  ```
  Calls every matching listener synchronously, ignoring return values and not awaiting promises.
  The agent-scoped `AgentEventDispatch.emit` (`dispatch.ts:120-137`) wraps this further: it
  resolves the callback list itself (not via the raw `ctx.emit`) so it can independently `try/catch`
  each synchronous throw and `.catch()` each returned-promise rejection, logging a warning per
  failure (`ctx.logger.warn(...)`) rather than letting one listener's failure prevent others from
  running or leak an unhandled rejection — "Fire-and-forget notification... a notification cannot
  veto lifecycle progress or starve a later observer" (doc, `dispatch.ts:56-59`).
- **`serial`** (`vendor/cordis/src/events.ts:204-209`):
  ```ts
  async serial(...args: any[]) {
    for (const cb of this.dispatch('serial', args)) {
      const result = await cb(...args)
      if (isBailed(result)) return result
    }
  }
  ```
  Awaits listeners **in registration order**, stopping at the first "bailed" result (anything other
  than `null`/`false`/`undefined`, `isBailed`, `events.ts:13-15`). `AgentEventDispatch.serial`
  (`dispatch.ts:138-142`) just forwards to `ctx.serial(carrier, name, fused(payload))`. Used for
  `agent/turn-stopping` (return type `Promise<void> | void` — every listener effectively "votes" by
  side effect, e.g. calling `agent.steer(...)`, not by a bail value; see §7).
- **`waterfall`** (`vendor/cordis/src/events.ts:234-243`):
  ```ts
  waterfall(...args: any[]) {
    const cbs = this.dispatch('waterfall', args)
    const inner = args.pop()             // the caller-supplied `next` / default value
    const next = () => {
      const cb = cbs.shift() ?? inner
      return cb(...args)
    }
    args.push(next)
    return next()
  }
  ```
  This is the "cooperative middleware chain": listeners are ordered **outermost-first** (in
  registration order, with `prepend: true` listeners at the front); the caller's own default value
  factory is the *innermost* link. Each listener receives the same payload plus a `next` callback
  that — when called — invokes the **next** listener in the chain (or, once the list is exhausted,
  the original default). A listener that returns without calling `next()` **short-circuits** the
  rest of the chain, including the built-in default behavior ("a listener that does not call
  `next()` vetoes the rest of the chain, including the built-in behavior", doc
  `events.ts:79-81`). This exact rule is restated as a repo-wide convention in
  `AGENTS.md:55`: "**Waterfall listeners MUST call `next()`** to delegate; returning without it
  short-circuits the chain."
  `AgentEventDispatch.waterfall` (`dispatch.ts:143-147`) forwards to `ctx.waterfall(carrier, name,
  fused(payload), ...rest)` where `rest` is exactly the event's declared trailing arguments (the
  `next` parameter type, extracted via `Tail<K>`, `dispatch.ts:40`).

### Net semantic differences

- `emit`: no return value, no ordering guarantee relevant to callers, failures contained
  independently per listener — pure notification.
- `serial`: awaited, in-order, short-circuits on the first non-`null/false/undefined` return
  ("bail") — used where at most one listener needs to answer/act and later listeners are
  irrelevant once one has.
- `waterfall`: awaited, in-order, **compositional** — every listener can inspect/transform the
  value the chain is converging on and decide whether to delegate further; the final "authoritative"
  value is whatever the outermost listener returns, which may be `next()`'s result unmodified, a
  transformation of it, or a value that never touched `next()` at all (a veto).

---

## 7. Every `agent/*` extension point

All declared in `packages/core/agent/src/runtime-types.ts` under `declare module
'@deepseek-ai/cordis' { interface Events { ... } }` (lines 153-299), each documented `@mode` and
each carrying `this: Scoped<Agent>` (scope-filtered dispatch) and `payload.agent: Agent`. Grepped
`ctx.on('agent/...'` across `packages/**/src/**/*.ts` for real listeners (excluding tests).

| Event | Mode | Payload | What a listener can do | Registered listeners found (non-test) |
|---|---|---|---|---|
| `agent/created` | emit | `{ agent }` | Observe a newly published agent (setup already ran); a **synchronous throw here vetoes publication** and rolls the agent back (`AgentRegistry.announce`, `packages/core/agent/src/index.ts:551-567`); a returned-promise rejection is only logged. | `file-reference-local/src/index.ts:90`, `experimental/tool-agent-team/src/index.ts:409`, `goal/goal-round-driver/src/index.ts:251`, `schedule/schedule/src/index.ts:52`, `preset/agent-presets/src/index.ts:215`, `subagent/tool-subagent/src/index.ts:689` |
| `agent/disposed` | emit | `{ agent }` | Observe removal, after driver quiescence/scope unwind, before session detachment; failures logged, not vetoing. | `file-reference-local/src/index.ts:91`, `experimental/tool-agent-team/src/index.ts:410`, `goal/goal-round-driver/src/index.ts:252`, `subagent/subagent/src/continuation.ts:386`, `subagent/tool-subagent/src/index.ts:692` |
| `agent/status` | emit | `{ agent; status: 'idle'\|'running' }` | Observe lifecycle transitions (`ReactLoopAgent.setPhase`, `agent-loop/src/agent.ts:112-120`, only emitted when status actually flips). | `compaction-basic/src/index.ts:168`, `api/session-controller/src/index.ts:142`, `experimental/agent-team/src/index.ts:112`, `core/agent/src/invariant.ts:17` (its own invariant), `schedule/schedule/src/index.ts:57`, `goal/goal-round-driver/src/index.ts:259` |
| `agent/inbox/inserted` | emit | `{ agent; message }` | Observe one message entering a pending list (`Inbox` notification, `inbox.ts:17,191`). | `goal/goal-round-driver/src/index.ts:284` |
| `agent/inbox/claimed` | emit | `{ agent; message; turn }` | Observe one message leaving the inbox into an open turn. If the step is later rejected, the message ends here — never re-emitted as a `user/message` (doc, `runtime-types.ts:196-197`). | `jobs/tool-jobs/src/index.ts:224`, `goal/goal-round-driver/src/index.ts:292`, `subagent/subagent/src/continuation.ts:1179` |
| `agent/inbox/discarded` | emit | `{ agent; message }` | Observe a pending message removed without being claimed. | `goal/goal-round-driver/src/index.ts:299`, `subagent/subagent/src/continuation.ts:1184` |
| `agent/session-start` | emit | `{ agent; source: SessionStartSource }` | "Use `agent.inject()` to seed model-facing context" (doc, `runtime-types.ts:216-217`); a notification, not a veto. | `hooks-codex/src/index.ts:189`, `hooks-claude-code/src/index.ts:207`, `experimental/agent-team/src/index.ts:111`, `goal/goal-round-driver/src/index.ts:253`, `goal/goal/src/index.ts:251` |
| `agent/pre-step` | waterfall | `{ agent; messages; turn; step; signal }`, `next(): Promise<PreStepDecision>` | Reject the step (`{ kind: 'reject' }`) or replace `messages`; calling `next()` preserves the current (upstream) messages/decision. **By far the busiest extension point** — this is where every context-injecting plugin (time-context, tmux-context, session-reference, agent-instructions, plan-mode, skill, checkpoint-policy, repeat-tool-reminder, tool-cordis, subagent invariant) hooks in. | `tool-cordis/src/index.ts:384`, `tmux-context/src/index.ts:236`, `time-context/src/index.ts:178`, `session-reference/src/index.ts:111`, `agent-instructions/src/index.ts:313`, `compaction-basic/src/index.ts:148`, `hooks-codex/src/index.ts:200`, `hooks-claude-code/src/index.ts:220`, `guard/repeat-tool-reminder/src/index.ts:229`, `session-checkpoint-policy/src/index.ts:79`, `goal-round-driver/src/index.ts:349`, `plan-mode/src/index.ts:191`, `skill/tool-skill/src/index.ts:177,213`, `subagent/tool-subagent/src/invariant.ts:20` |
| `agent/request` | waterfall | `{ agent; turn; step; signal }`, `next(): Promise<LlmCallConfig>` | Replace the frozen call config (provider/model/etc.) before the request is built; cannot mutate messages (doc: "Model-visible content must use logged channels; this waterfall cannot mutate messages", `runtime-types.ts:242-243`). | `webhook/webhook/src/session.ts:93` (only non-test listener found) |
| `agent/request-error` | waterfall | `{ agent; turn; step; provider; failure; retryPolicy; signal }`, `next(): Promise<RequestErrorAction>` | Return `{ kind: 'retry' }` to own recovery (bypassing `next()`), or call `next()` to delegate; unhandled default is `undefined` (terminal failure). | `compaction-basic/src/index.ts:180`, `llm/llm-retry/src/index.ts:243` |
| `agent/turn-stopping` | serial | `{ agent; turn; signal }` | Awaited before a turn boundary commits when the model owes no further response; a listener that "objects" calls `agent.steer(...)` as a side effect (data-driven, not veto-by-return — doc: "Data decides, so listener order cannot change the outcome", `runtime-types.ts:275-278`). | `hooks-codex/src/index.ts:261`, `hooks-claude-code/src/index.ts:271` |
| `agent/error` | emit | `{ agent; turn; step; error }` | Observe a step/turn failure, including ones with no in-turn position for a durable record. | `api/session-controller/src/index.ts:145`, `session-telemetry/src/coordinator.ts:103`, `goal-round-driver/src/index.ts:246` |

**Dead/near-dead extension point**: `agent/request` has exactly one non-test listener in the
entire repository (`packages/webhook/webhook/src/session.ts:93`). It is not unused, but it is
sparsely adopted compared to `agent/pre-step`, which is the dominant integration surface for
context/prompt-shaping plugins. This is a genuine architectural observation, not dead code: the
type exists, is exercised by tests (`packages/core/agent-loop/tests/request-*.spec.ts`,
`packages/llm/llm-retry/tests/retry.spec.ts`), and has one production consumer.

No `agent/*` event in `runtime-types.ts` was found with **zero** listeners anywhere (including
tests) in this pass.

---

## 8. `assembleContextFor(agent, signal)`

`packages/core/agent/src/dispatch.ts:174-176`:

```ts
export function assembleContextFor(agent: Agent, signal?: AbortSignal): AssembleContext {
  return { agent, scope: agent, ...signal === undefined ? {} : { signal } }
}
```

A one-line helper that builds the `AssembleContext` (`packages/core/system-prompt/src/index.ts:42-50`:
`{ scope?, signal? }`, extended by the `agent` package via declaration merging,
`dispatch.ts:17-22`, to add `agent?: Agent`) for exactly one call pattern: **scope = the agent
itself**. Its own doc explains why it's a named helper rather than an inline object literal: "Build
the prompt assembly context with agent and scope set together, so agent-scoped prompt and tool
contributions cannot be silently omitted" (`dispatch.ts:168-171`) — i.e. it structurally prevents a
caller from passing an `agent` without also setting `scope: agent` (or vice versa), which would
silently exclude that agent's own scoped `PromptLayer` from the assembly. Sole production call site:
`packages/core/agent-loop/src/agent.ts:239 → this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))`
inside `preStep()`.

---

## Appendix: additional grounded facts used above

- `packages/core/scope/src/store.ts:159-267 → class ScopedLayers` — the shared global+scoped
  layering primitive used identically by `SystemPrompt`'s `layers` field (`system-prompt/src/index.ts:398`).
  `chainLayers` (line 192-199) and `merge` (line 208-217) are the two methods that implement
  "nearest scope wins" shadowing for both prompt registrations and (via the same class, reused
  elsewhere) other scoped registries in the codebase.
- `packages/core/scope/src/index.ts:170-185 → scopeTarget()` — builds the opaque event-dispatch
  filter object used as Cordis `thisArg`; a listener registered under context tag `T` receives
  events dispatched to scope key `K` iff `T` is `K` or one of `K`'s ancestors via
  `scopeParents` (walked at lines 177-179). This is the mechanism behind "Scope-filtered dispatch"
  language throughout the `agent`/`system-prompt` JSDoc.
- `vendor/cordis/src/events.ts:165-175 → EventsService.dispatch()` — resolves the raw listener list
  for one event name and applies exactly this filter: `hook.global || !filter ||
  filter.call(thisArg, hook.ctx)` (line 173).
- Real toolOrder example, `packages/core/system-prompt/tests/tool-order.spec.ts:45-49`: with
  `toolOrder: ['todo_write', TOOL_ORDER_REST, 'bash']` and registered tools
  `['bash','echo_b','todo_write','echo_a']`, the assembled order is
  `['todo_write', 'echo_a', 'echo_b', 'bash']` — listed names go to their exact position, everything
  else is inserted lexicographically at the `TOOL_ORDER_REST` marker.
- Real scoped-persona example, `packages/core/system-prompt/tests/scoped.spec.ts:33-44`: a scope
  registering `deployment:persona` with different text makes `assemble({ scope })` render only the
  scoped text and `assemble()` (no scope) render only the global text — confirms shadowing is exact
  replacement-by-name, not merged text.

## UNKNOWN / not confirmed in this pass

- Whether `PromptSection.complete` has any live producer anywhere in the deployment configs (only
  grepped `packages/**/src`; did not check `cordis.yml`/`apps/**` config literals or docs for a
  deployment that sets a persona section with `complete: true`). Would need a full grep of
  `complete:\s*true` and `complete: true` across `apps/`, `*.yml`, and any dynamically constructed
  section objects, plus reading `packages/preset/**` in full.
- The exact registration sites of the `provider`/`model`/`cwd` prompt variables mentioned in the
  task brief — not located in this pass (would need to read
  `packages/core/agent-loop/src/index.ts` in full, which was outside this note's file list beyond
  `agent.ts`/`runtime-context.ts`).
- Full behavior of `packages/core/agent/src/model-selection.ts`, `consumed-work.ts`, and
  `projection.ts` — read only enough of `packages/core/agent/src/index.ts` and `runtime-types.ts`
  to answer the assigned questions; these three files were not opened and may contain additional
  agent-adjacent extension points or types relevant to a fuller treatment of the `agent` package.
