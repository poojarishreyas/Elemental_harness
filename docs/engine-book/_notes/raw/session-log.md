# The durable session event log — raw research notes

Scope: `packages/core/session/**` (the `Session` class, event map, surface,
request-header fold) and `packages/session/**` (persistence backends,
projections, checkpoint policy). Every claim below is grounded in code that
was actually read; line numbers are from the files as they exist in this
checkout. Anything not directly confirmed is marked UNKNOWN or INFERRED.

---

## 1. What is a `Session`? Where is it defined?

`Session` is a plain class (explicitly **not** a Cordis `Service`) defined in
`packages/core/session/src/index.ts:423-756`. Doc comment at
`packages/core/session/src/index.ts:415-423`:

> "An event-sourced session: an append-only log of `SessionEvent`s. Plain
> class (not a Service) — create live instances via `ctx.sessions.create()`
> and detached instances via `create`."

Internally it holds:

- `private log: SessionEvent[] = []` — the actual array of events
  (`packages/core/session/src/index.ts:424`).
- `private readonly surfaceManager = new SurfaceManager(this.log)` — the
  incremental ordered-surface fold over that same array
  (`index.ts:426`).
- `readonly header: SessionHeader` — immutable creation metadata, kept
  **out of** the event log (`index.ts:441`, comment: "Kept out of the event
  log — it is a storage concern, not replayable conversation state.").
- `readonly firstLiveSeq: number` — length of the constructor seed
  (`index.ts:470`), used to distinguish resumed/forked history from events
  produced by this process.

It is constructed only through two static factories, both routing to a
`private constructor`:
- `Session.create(id, seed?, header?)` (`index.ts:480-482`) — for a fresh or
  replayed/forked session, validating the seed to the same invariants
  `append` enforces.
- `Session.fromRestore(id, seed, header)` (`index.ts:493-495`) — the
  exclusive-ownership path used by persistence backends, which freezes the
  restored graphs in place rather than re-validating/copying them
  (`mode: 'restore'`).

`SessionStore` (`index.ts:790-1153`) is the Cordis `Service` registered as
`ctx.sessions`. It is an **in-memory** store only:

> "Persistence is intentionally not implemented here — persistence plugins
> subscribe to `session/event` and flush on `session/flush` / dispose."
> (`index.ts:786-789`)

`SessionStore.create()` / `.prepare()` / `.enter()` / `.announce()` manage the
publish lifecycle (`session/created`, `session/disposed` events on `ctx`,
declared at `index.ts:52-62`), and `SessionStore.fork()`
(`index.ts:1079-1093`) creates a child session from a prefix of a parent's
log, rejecting a boundary that ends inside an open turn
(`index.ts:1126-1133`, `SessionForkError` code `OPEN_TURN`).

### `append()`

`Session.append<T>(type, data, ...opts)` — `index.ts:602-653`.

Signature (`index.ts:602-606`):
```ts
append<T extends SessionEventType>(
  type: T,
  data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
): SessionEvent<T>
```
The TypeScript conditional type is load-bearing: for the three
`SurfaceEventType`s (`user/message`, `assistant/message`, `tool/result`) the
`SurfaceIntent` third argument is **required** by the compiler; for every
other event type it is **forbidden** (empty tuple). `SurfaceIntent` is
`{ surfaceOp: SurfaceOp; sourceEventSeqs?: number[] }` (`types.ts:367-376`).

What it does, in order:
1. Builds `surfaceMetadata` from `opts[0]` (only `sourceEventSeqs`/`surfaceOp`
   present when supplied) — `index.ts:607-611`.
2. `snapshotJsonValue(data)` — deep, lossless-JSON snapshot; throws if the
   value is not exactly reproducible as JSON (rejects BigInt, functions,
   symbols, `undefined`, negative zero, non-finite numbers, circular refs,
   sparse arrays, Map/Set/Date/class instances — per the JSDoc at
   `index.ts:588-591`) — `index.ts:612-615`.
3. `assertSupportedRequestHeader` rejects the retired `request/header-delta`
   legacy shape (`index.ts:616`, helper at `index.ts:361-370`).
4. Snapshots the surface metadata the same way (`index.ts:617-620`).
5. Refuses reentrant append: `if (entry?.appending) throw ...` — an append
   cannot be triggered from inside another append's synchronous
   `session/event` dispatch (`index.ts:621-624`).
6. Freezes the final event object: `{ type, seq: this.log.length, time:
   Date.now(), data: dataSnapshot, ...surfaceMetadataSnapshot }` —
   `index.ts:625-631`. **`seq` is always `this.log.length` at call time** —
   this is the sole seq-assignment site.
7. `this.surfaceManager.validateNext(event)` — validates the candidate
   against the live surface fold **before** it is pushed into `log`
   (`index.ts:632`), so a bad surface marker throws before any state
   mutates.
8. Dispatches `session/event` synchronously to already-collected listeners
   (`collectSessionCallbacks`, `index.ts:636-639`), *then* pushes onto
   `this.log` (`index.ts:641`) — the listener snapshot is taken before the
   push but callbacks run after it (per the `session/event` JSDoc at
   `index.ts:63-65`: "The listener snapshot resolves before the log push,
   but callbacks run after it").
9. Invalidates the cached `events` snapshot (`this.eventsSnapshot =
   undefined`, `index.ts:642`).
10. Observer failures are caught and logged per-listener
    (`invokeContainedSessionObservers`, `index.ts:379-397`) so one listener
    throwing cannot un-commit the append or block later listeners.

Return value: the logged, frozen `SessionEvent<T>` — "its assigned `seq`/
`time` plus the SNAPSHOT of `data` that entered the log" (`index.ts:585-587`).

### `deriveMessages()`

`index.ts:724-745`. Reproduced verbatim:

```ts
deriveMessages(): Message[] {
  const surface = this.surface
  const nodes = surface.nodes
  const generation = surface.replaceGeneration
  if (generation !== this.derivedGeneration) {
    this.derived = []
    this.derivedNodes = 0
    this.derivedGeneration = generation
  }
  for (const seq of nodes.slice(this.derivedNodes)) {
    const msg = this.deriveEventMessage(this.log[seq]!)
    if (msg) this.derived.push(msg)
  }
  this.derivedNodes = nodes.length
  return [...this.derived]
}
```

It walks `this.surface.nodes` (an ordered array of `seq` numbers into
`this.log` — see §4/§5), incrementally: only the *new* surface nodes since
the last call are projected (`derivedNodes` is a cursor), and the whole cache
is invalidated and rebuilt from scratch whenever `replaceGeneration` changes
(a compaction/replace happened). This means a `deriveMessages()` call costs
O(new nodes) amortized, not O(log length), except immediately after a
replace. See §5 for the per-node projection rule.

### `requestHeader()` and `requestContext()`

`requestHeader()` — `index.ts:668-678` — folds `request/header` events
into the latest `EpochHeader` (config/adapterDefaults/system/tools),
incrementally cached via `headerFoldSeq`. It calls the pure
`foldRequestHeader` from `request-header.ts` over only the unfolded tail
(`this.log.slice(this.headerFoldSeq)`), passing the previous fold as the
seed (`index.ts:674`). Returns `undefined` before the first `request/header`
event.

`requestContext()` — `index.ts:689-697` — folds `request/context` events the
same incremental way, keeping only the **latest** one (route metadata:
provider/model/contextWindow), used for presentation/telemetry, not request
reconstruction (`request/context` payload type: `types.ts:191-198`).

### `surface` and `surface.replaceGeneration`

`get surface(): SessionSurface { return this.surfaceManager }` —
`index.ts:429-431`. `SessionSurface` is the read-only interface exposed by
`SurfaceManager` (`surface.ts:137-142`):
```ts
export interface SessionSurface {
  readonly nodes: readonly number[]
  readonly replaceGeneration: number
}
```
`nodes` is the ordered list of `seq` values that currently sit on the
model-visible surface. `replaceGeneration` is a monotonically increasing
counter, incremented exactly once per committed positional **replace**
operation (`surface.ts:370-371`, inside `applySurfacePlan`). It is the
generation guard `deriveMessages()` uses to know its append-only incremental
cache is stale and must be rebuilt (see above). See §4 for full mechanics.

### `header`

`readonly header: SessionHeader` (`index.ts:441`) — the object shape is
`packages/core/session/src/types.ts:56-94`:
```ts
export interface SessionHeader {
  readonly version: number
  readonly id: SessionId
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: SessionId
  readonly seedLength?: number
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
}
```
It is validated and deep-frozen at construction time
(`validateSessionHeader`, `index.ts:94-134`; `validateRestoredSessionHeader`,
`index.ts:137-145`) and is explicitly **not** part of the append-only log —
it is storage metadata, supplied once by the store/backend.

---

## 2. The complete `SessionEventMap` and how it is extended

### Core map (`packages/core/session/src/types.ts:216-320`)

```ts
export interface SessionEventMap {
  'turn/start': { turn: number }
  'turn/end': { turn: number; reason: TurnEndReason }
  'step/start': { turn: number; step: number }
  'step/end': { turn: number; step: number }
  'user/message': UserMessage
  'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
  'assistant/message': {
    turn: number; step: number; message: AssistantMessage
    usage?: TokenUsage; interrupted?: true
  }
  'tool/call': { turn: number; step: number; callId: ToolCallId; name: string; arguments: string }
  'tool/result': {
    turn: number; step: number; message: ToolResultMessage
    error?: { name: string; code: string }; meta?: JsonValue
  }
  'request/header': {
    header: EpochHeader; reason: RequestHeaderReason; startsSeries?: true
  }
  'request/context': RequestContext
  'session/end-seed': Record<string, never>
}
```

`EpochHeader` (`types.ts:179-188`):
```ts
export interface EpochHeader {
  config: LlmCallConfig
  adapterDefaults?: LlmCallConfigAdapterDefaults
  system?: string
  tools?: ToolSchema[]
}
```
`RequestContext` (`types.ts:191-198`): `{ provider: string; model: string;
contextWindow?: number }`.

`RequestHeaderReason` (`types.ts:200-208`) is `'initial' | 'resume' |
'change' | 'series'`, with precise semantics documented at the same lines
(initial = log's first header; resume = a new loop instance's first request
over a log that already has headers; change = a later request used a
different header; series = an unchanged header explicitly began a new
message series or followed a surface replace).

`TurnEndReasonMap` (`types.ts:150-169`, merge-extensible) has variants
`completed`, `aborted` (carries an `AgentCancelCause`), `blocked`, `error`
(carries an `LlmFailure`), `max-tokens`, and `interrupted` — the last one is
explicitly a crash-recovery marker: "A persistence backend closed a
crash-orphaned turn on reload. The loop never emits this marker" (comment at
`types.ts:165-168`; confirmed in `repair.ts`, see §7).

### Declaration merging

`SessionEventMap`, `SessionProjectionStateMap`/`SessionProjectionMap`,
`TurnEndReasonMap` are all declared as plain (non-`declare module`)
interfaces exported from their home package, and other packages extend them
via **module augmentation** — TypeScript interface merging across an
`import`-visible module. Example from `packages/core/session/src/types.ts`
itself, merging into `@deepseek-ai/dsh-typert-protocol`:
```ts
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'session/not-found': { readonly sessionId: SessionId }
  }
}
```
(`types.ts:425-430`). The `SessionEventMap` interface itself is merged the
same way by every domain package that adds an event type — e.g. compaction
adds `compaction/start` / `compaction/end` / `compaction/summary` /
`compaction/prune` (present in the generated allow-list below), and
`dsh-todo` presumably adds `todo/write`, etc. I did not open every domain
package's `declare module '@deepseek-ai/dsh-session' { interface
SessionEventMap { ... } }` site individually — this is INFERRED from (a) the
merge-extensible language in every doc comment on `SessionEventMap`,
`SessionEventType`, and `TurnEndReasonMap`, and (b) the fact that
`packages/core/session/src/known-event-types.ts` (generated) lists ~40 event
types that do not appear in `types.ts`'s own map, meaning they must be
declared elsewhere via merging.

### The generated known-event-type registry

`packages/core/session/src/known-event-types.ts` carries a header:
> "GENERATED by `scripts/gen-persistence-catalog.ts` — do not edit by hand"

`KNOWN_SESSION_EVENT_TYPES` (`known-event-types.ts:22-74`) is the **complete
build-wide vocabulary** across every loaded plugin, currently 40 entries:
```
agent-preset/selected, agent/inbox/spliced, approval/asked, approval/decided,
approval/policy, assistant/chunk, assistant/message, command/done,
command/run, compaction/end, compaction/prune, compaction/start,
compaction/summary, feedback/record, goal/change, hook/invoked, hook/result,
llm/retry, llm/retry-started, model/selection, permission/preset, plan/mode,
request/context, request/header, sandbox/mode, schedule/change,
session-log-deepseek/delivery-accepted, session/end-seed, session/title,
session/title-llm-request, step/end, step/start, subagent/descriptor,
subagent/model-selection-policy, team/member, team/message/delivered,
team/message/queued, team/task, todo/write, tool-workflow/agent-end,
tool-workflow/agent-start, tool-workflow/run-end, tool-workflow/run-start,
tool/call, tool/code-dispatch, tool/code-dispatch-start, tool/result,
turn/end, turn/start, user/message, web/deepseek-search-llm-request
```
(Count note: the list literal has slightly more than 40 lines; I did not
recount precisely — treat "~40" as approximate, the literal itself is the
source of truth.)

This set is the **read-side compatibility gate**: `PersistenceCoordinator`
(`packages/session/session-persistence/src/coordinator.ts:1143-1148`,
`assertEventsSupported`) refuses to interpret a stored log containing any
event type outside this set unless the event carries
`SessionEvent.ignorable === true`:
```ts
private assertEventsSupported(meta: SessionHeader, events: readonly SessionEvent[]): void {
  for (const event of events) {
    if (KNOWN_SESSION_EVENT_TYPES.has(event.type) || event.ignorable === true) continue
    throw this.unsupported(meta, `session "${meta.id}" contains event type "${event.type}" ...`)
  }
}
```
This is the mechanism referenced by `AGENTS.md`'s rule: "only structural
format changes bump `SESSION_FORMAT_VERSION`" — new *vocabulary* is safe
without a version bump because unknown-but-`ignorable` events degrade
gracefully, while unknown *required* events cause a loud refusal rather than
silent misinterpretation.

### `ignorable` marker

`SessionEvent.ignorable?: true` (`types.ts:399-409`): "Marks an event a
reader may safely skip when it does not recognize `type`. Absent means
required... A writer sets `true` only on purely informational records whose
loss cannot affect reconstruction."

---

## 3. `seq`, event ordering, and `SESSION_FORMAT_VERSION`

### `seq`

- Defined as part of the `SessionEvent<T>` envelope (`types.ts:391-398`):
  `seq: number` — "Monotonic sequence number within the session."
- `Session.append` assigns `seq: this.log.length` at the moment of
  acceptance (`index.ts:627`) — i.e. **seq is always the zero-based index of
  the event in the log array**. There is no gap-tolerant or externally
  supplied seq at append time.
- `get seq(): number { return this.log.length }` (`index.ts:562-565`) — "The
  next event's sequence number — always the log length (the `seq =
  log.length` contiguity contract)."
- Contiguity is enforced at multiple boundaries:
  - Constructor seed validation: `if (snapshot.seq !== index) throw ...`
    (`index.ts:523-525`) — a seed must number events `0..N-1` with no gaps.
  - `SurfaceManager`'s fold (`surface.ts:328-330`,
    `planSurfaceEvent`): `if (event.seq !== expectedSeq) throw ...`.
  - Persistence append: `PersistenceCoordinator.appendCore`
    (`coordinator.ts:722-726`) checks `event.seq !== state.cursor + i` for
    every event in a batch before writing.
- `sourceEventSeqs` (surface-eligible events only) references *earlier*
  `seq` values; enforced by `assertProvenance` in `surface.ts:210-243`
  (rejects references `>= event.seq`, duplicates, and — for a replace op —
  requires the array to be a superset of every shadowed surface node's seq).

### `SESSION_FORMAT_VERSION`

`packages/core/session/src/types.ts:51`: `export const
SESSION_FORMAT_VERSION = 0`.

Extensive doc comment above it (`types.ts:28-50`) states the governing rule
precisely:
> "The version is a single monotonic integer with no major/minor split.
> Whether a bump is needed is decided by what the WRITER emits ... bump
> exactly when an older runtime could no longer handle a new log with full
> semantic correctness... Only structural changes reach that bar: the header
> shape, the `SessionEvent` envelope, core event semantics, or the surface
> mechanism (the `SurfaceEventType` set and `SurfaceOp` variants). Adding an
> ordinary event type does not bump — the per-event `ignorable` guard covers
> vocabulary growth instead."

It cites a design note at
`.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.md`
for the full upgrade-chain mechanism (not opened — out of scope for code
verification, flagged as a **doc reference, not verified code**).

Enforcement: every stored header's `version` field must equal
`SESSION_FORMAT_VERSION` or the session is validated (`index.ts:99-101`),
and `PersistenceCoordinator.assertVersion`
(`coordinator.ts:1128-1131`) throws `SessionFormatUnsupportedError` via
`sessionFormatVersionRefusal` (`coordinator.ts:78-82`) — the message text
differs by direction ("written by a newer harness — upgrade the harness" vs.
"older... no upgrade path"). Since the constant is pinned at `0` while
unreleased, **no migration path exists yet** — this is stated directly in
the doc comment ("no compatibility is implied, incompatible logs are
rejected, and no migration is provided").

---

## 4. The surface: `surfaceOp: 'append'`, `replace`, `sourceEventSeqs`

All of this lives in `packages/core/session/src/surface.ts` (explicitly
browser-safe — no `node:` imports, per its module doc at lines 1-9, "web
clients consume this subpath export").

### Eligibility

Only three event types can ever carry surface metadata
(`SurfaceEventType`, `types.ts:330-334`): `user/message`,
`assistant/message`, `tool/result`. This is a closed, non-extensible union
(unlike `SessionEventMap`) — it is checked at runtime by
`SURFACE_EVENT_TYPES` (`surface.ts:15-19`) and enforced by
`surfaceOpOf` (`surface.ts:185-208`), which throws if a non-eligible event
carries `surfaceOp`/`sourceEventSeqs`, or if an eligible event is **missing**
`surfaceOp`.

### `SurfaceOp` (`types.ts:359-361`)

```ts
export type SurfaceOp =
  | 'append'
  | { op: 'replace'; start: number; end: number }
```

- `'append'`: the event joins the tail of the surface. Simplest, most common
  case — `applySurfacePlan` just does `state.nodes.push(plan.seq)`
  (`surface.ts:366-367`).
- `{ op: 'replace', start, end }`: the event **replaces** an inclusive range
  of *existing surface nodes* — not log positions, but positions currently
  present on the surface — identified by their `seq` values `start`..`end`.
  Both `start` and `end` must currently exist as surface nodes
  (`replacementRange`, `surface.ts:246-266`, `indexOf` lookups that throw
  `"start seq ... not found in surface"` if absent). `start === end`
  replaces exactly one node.

### How replace is applied

`applySurfacePlan` (`surface.ts:362-379`):
```ts
} else if (plan?.kind === 'replace') {
  state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq)
  state.replaceGeneration += 1
}
```
The shadowed range is spliced out of `state.nodes` and replaced with the
**single** new event's `seq`. `replaceGeneration` increments exactly once
per committed replace — this is the counter `Session.deriveMessages()` uses
to detect that its append-only incremental derived-message cache must be
thrown away and rebuilt (§1, §5).

### `sourceEventSeqs`

Declared conditionally on the `SessionEvent<T>` type
(`types.ts:410-422`) — only present on `SurfaceEventType` variants. Purpose,
per the field doc: "Seq numbers of earlier events that this event cites as
sources (e.g. the `assistant/chunk` seqs that built an `assistant/message`,
or the surface nodes shadowed by a compaction replace node)."

Validation (`assertProvenance`, `surface.ts:210-243`):
- Must be an array of non-negative safe integers, each strictly earlier than
  the citing event's own `seq` (`nonEarlierSource` check,
  `surface.ts:230-236`).
- No duplicates (`surface.ts:232-234`).
- Must be non-empty *unless* the event is `assistant/message` — an
  `assistant/message` **may** carry a present-but-empty array "for a known
  empty provider stream" (`surface.ts:221-222`, echoing the same allowance in
  `types.ts:370-375` and `types.ts:412-417`).
- For a `replace` op specifically: `sourceEventSeqs` **must be a superset of
  every shadowed surface node's seq** — `assertProvenance` is called with
  `shadowedSeqs = range.shadowedSeqs` and checks
  `shadowedSeqs.filter(seq => !sources.has(seq))` is empty
  (`surface.ts:239-242`, `planSurfaceEvent` at `surface.ts:337-338`). This is
  what the type doc calls "complete shadowed-node coverage."

### The extra constraint on `tool/result` replacement

`assertToolResultRewrite` (`surface.ts:287-318`) narrows what a
`tool/result` replace may change:
- It must shadow **exactly one** current node (`shadowedSeqs.length !== 1`
  throws — `surface.ts:294-296`).
- The replacement may differ from the original **only in the tool-result
  block's `content`** — every other field of the event (including the rest
  of the message) must be deep-JSON-equal (`isDeepEqualJson`, compared after
  nulling out `content` on both sides, `surface.ts:296-317`). This is a real
  production constraint used by `compaction-tool-result-pruner` (see below)
  to shrink a tool result's content while leaving everything else (call id,
  turn/step, error flag) untouched.

### Real production usage (not just tests)

`packages/core/agent-loop/src/agent.ts` is the actual agent driver. Verified
call sites:
- `turn/start`/`turn/end`/`step/start`/`step/end` — non-surface, no options
  (`agent.ts:264, 288, 301, 328`).
- `user/message` appended with `{ surfaceOp: 'append' }`
  (`agent.ts:292`).
- `assistant/chunk` appended per streamed chunk, its `seq` collected into
  `chunkSeqs` (`agent.ts:368`).
- On abort mid-stream, a partial `assistant/message` is appended with
  `{ surfaceOp: 'append', sourceEventSeqs: chunkSeqs }` and `interrupted:
  true` (`agent.ts:376-385`).
- On normal completion, the full `assistant/message` is appended the same
  way: `{ surfaceOp: 'append', sourceEventSeqs: chunkSeqs }`
  (`agent.ts:418-427`) — this is the literal mechanism tying an
  `assistant/message` back to the exact `assistant/chunk` events it was
  assembled from.
- `request/header` appended with `reason: 'initial' | 'resume' | 'change' |
  'series'` depending on whether this is the first header, a resumed loop's
  first request, a changed header, or an unchanged header starting a new
  series (`agent.ts:507-518`).
- `request/context` appended only when provider/model/contextWindow changed
  from the previous fold (`agent.ts:527-531`).

Real production **replace** usage (compaction domain, not a test):
- `packages/compaction/compaction-basic/src/region.ts:472-475` — a
  compaction checkpoint `user/message` replaces a whole prior region:
  ```ts
  session.append('user/message', checkpointMessage, {
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
  })
  ```
- `packages/compaction/compaction-tool-result-pruner/src/index.ts:167-173` —
  a single tool result is pruned (content shrunk) via a single-node replace:
  ```ts
  const replacement = session.append('tool/result', {
    ...event.data, message,
  }, {
    surfaceOp: { op: 'replace', start: seq, end: seq },
    sourceEventSeqs: [seq],
  })
  ```
This confirms the surface-replace mechanism is live, reachable machinery
(the compaction plugins are loaded in real profiles per
`docs`/snapshot configs — I did not individually re-verify every compaction
plugin's presence in `packages/bundle/base/cordis.patch.yml`, so treat
"loaded by default" as **INFERRED** from package naming and the presence of
`snapshots/session/compaction-recovery/cordis.yml` in the repo, which is a
real recorded-session snapshot fixture implying the compaction plugin runs
in at least one snapshot profile).

### `isSurfaceEvent`, `isAppendSurfaceEvent`, `isReplacementSurfaceEvent`

Exported guards (`surface.ts:35-68`) narrow a `SessionEvent` to a
`SurfaceEvent` (type + `surfaceOp` both present), and further split append
vs. replace origin. Their doc explains the human-transcript rationale for
`isAppendSurfaceEvent`: "The model-visible surface deliberately shadows
replaced ranges, so it is the wrong source for a human transcript — a landed
replacement would erase conversation the user already saw. Append-origin
events are that transcript's durable source material; replacement copies
stay model-only." (`surface.ts:44-48`)

### `SurfaceManager` — incremental fold

`surface.ts:398-460`. Holds `_state` (nodes + replaceGeneration),
`_lastProcessedSeq`, and a `_pendingPlan` used to avoid double-validating an
event that was already checked by `validateNext` right before its actual
`append`. `nodes` and `replaceGeneration` getters lazily call
`_processDelta()` to fold any events appended since the last access
(`surface.ts:432-441`). The standalone pure function `foldSurface(events)`
(`surface.ts:387-395`) replays a **complete** log from scratch and is used
for pure/offline reconstruction (e.g. tests, and potentially external
reconstructors per the `deriveEventMessage` doc comment).

---

## 5. How `deriveMessages()` projects events to LLM messages

The per-node projection rule is the exported pure function
`deriveEventMessage` in `surface.ts:83-114`, reproduced:

```ts
export function deriveEventMessage(event: SessionEvent): Message | null {
  switch (event.type) {
    case 'user/message': {
      return event.data
    }
    case 'assistant/message': {
      if (event.data.message.content.length === 0) return null
      return event.data.message
    }
    case 'tool/result': {
      return event.data.message
    }
    default:
      return null
  }
}
```

Key facts:
- It is **intentionally non-exhaustive** (no `assertNever` default) — "only
  message-producing events derive history; turn/step boundaries, chunks,
  usage, and errors are trace/replay data" (`surface.ts:84-86`).
- `user/message`'s `data` field **is** the `UserMessage` itself (the map
  entry `'user/message': UserMessage`, `types.ts:244`) — passed through
  verbatim, with an explicit anti-pattern warning in the comment: "Do NOT
  re-add per-type framing (e.g. `<context>`) here: framing is caller-owned —
  a producer bakes it into `content`... keeping this projection a verbatim
  pass-through." (`surface.ts:90-94`)
- `assistant/message` is skipped (`null`) when its message has **zero**
  content blocks — this is the case where a max-tokens step logged an
  `assistant/message` purely to carry `usage`, with no actual assistant
  turn to inject into the provider transcript (`surface.ts:100-104`, and
  the field doc at `types.ts:257`: "an empty-content assistant/message ...
  derives to null and must not enter the transcript").
- `tool/result`'s message is `event.data.message` (a `ToolResultMessage`).

`Session.deriveMessages()` (already quoted in §1) then:
1. Reads `surface.nodes` (ordered `seq` array) and `surface.replaceGeneration`.
2. If the generation changed since the last call, **discards the entire
   derived cache** and restarts from node 0 — a compaction replace forces a
   full rebuild, because arbitrary earlier positions in `nodes` may have
   changed (a splice, not just an append).
3. Otherwise, only the **new suffix** of `nodes` (`nodes.slice(this.derivedNodes)`)
   is projected through `deriveEventMessage`, appended to the persistent
   `this.derived` cache.
4. Returns `[...this.derived]` — a **fresh array** each call (so callers
   cannot observe later mutation), but the `Message` objects inside are
   shared, already-frozen references reused across calls, deriving their
   immutability from the durable, deep-frozen event data itself (comment at
   `index.ts:718-721`: "Their content reuses the already frozen durable
   event data, so the cache needs no second deep clone").

Real call site: `packages/core/agent-loop/src/agent.ts:355` —
`this.session.deriveMessages()` is passed directly as the `boundaryMessages`
that become the request's `messages` array
(`agent.ts:349-359` builds the request; the message list flows into
`buildRequest`'s `messages: boundaryMessages` at `agent.ts:537`). This is the
literal code path referenced in the task's "WHY THIS MATTERS": the agent
rebuilds every LLM request by re-deriving from the log, not by holding a
separate in-memory transcript.

A subtlety worth flagging: `step()` reads `surfaceGeneration` **before**
building the request (`agent.ts:349`) and re-checks it later
(`this.requestSurfaceGeneration !== surfaceGeneration`, `agent.ts:505-506`)
to decide whether a `request/header` needs `startsSeries: true` — i.e. "did
the surface get rewritten since the last header I logged" is itself tracked
through `replaceGeneration`, tying §2's `RequestHeaderReason: 'series'`
directly to the replace mechanism in §4.

---

## 6. Session projections

Defined in `packages/session/session-projection/src/index.ts` (Service
Definition `ctx.sessionProjections`, class `SessionProjectionRegistry`,
lines 187-669) and `packages/session/session-projection/src/types.ts`
(the two merge-extensible tables, `SessionProjectionMap` for client-visible
wire values and `SessionProjectionStateMap` for host-only fold state,
both empty interfaces meant to be declaration-merged by domain packages —
same mechanism as `SessionEventMap`, §2).

### `ProjectionDefinition` (`index.ts:42-86`)

```ts
export interface ProjectionDefinition<K extends keyof SessionProjectionStateMap, S = ...> {
  key: K
  stateSchema: ZodType<S>
  init(header: SessionHeader): NoInfer<S>
  apply(state: NoInfer<S>, event: SessionEvent): NoInfer<S>
  wire?: { viewSchema: ZodType<SessionProjectionMap[K]>; view(state: NoInfer<S>): SessionProjectionMap[K] }
  stateVersion: number
}
```

- `key` — the projection's slot in the state map (and, if `wire` is
  present, also in the client-visible map).
- `stateSchema` — a Zod schema validating **persisted** state before it
  seeds a fold (used on cold restore from a checkpoint row).
- `init(header)` — the state for an empty log, seeded from the session's
  immutable header.
- `apply(state, event)` — a **pure, synchronous** fold: "A unit uninterested
  in an event MUST return the same state reference — an unchanged reference
  (`Object.is`) produces zero downstream work" (`index.ts:58-59`). All unit
  functions must be synchronous ("an async unit would tear the carriers'
  consistency cut", `index.ts:39`), and `state` must be plain JSON (the
  persisted-cache precondition, `index.ts:40`).
- `wire` (optional) — `viewSchema` + `view(state)`, the read-side projection
  from internal state to the client-visible wire value. Omitted for
  host-only units.
- `stateVersion` — "Persisted-cache invalidation version: bump whenever the
  serialized state fields or the fold semantics change, so persisted
  `(sessionId, key, ver, seq, val)` rows from an older unit are discarded
  instead of being forward-applied into garbage." (`index.ts:80-84`)

### `sessionProjections.register()`

Two overloads (`index.ts:221-240`): one requiring `wire` (client-visible
units, keyed by `keyof SessionProjectionMap`), one for host-only units
(`Exclude<keyof SessionProjectionStateMap, keyof SessionProjectionMap>`).
Both funnel into the implementation at `index.ts:241-281`, which:
- Validates `stateVersion` is a non-negative safe integer.
- Registers via `ctx.effect(...)` (a Cordis effect — "Registrations are
  effects" per `AGENTS.md`), so unloading the registering plugin's fiber
  removes the key — "an unloaded domain plugin's key disappears from
  snapshots and clients read it as capability absence" (`index.ts:179-180`).
- **Shares** one registration across multiple registrants of the same key
  via a `refs` counter (`index.ts:264-278`) — e.g. the same tool package
  mounted in N agent presets registers the same key N times, and the key
  survives until the last one unloads. A **stateVersion mismatch between
  registrants throws** (`index.ts:267-269`).

### Drive mechanism

The registry subscribes to `session/created` (to `init` a fresh cell per
registered unit for a brand-new session, `index.ts:197-207`) and
`session/event` (`index.ts:208-210`, → `private drive()`,
`index.ts:625-661`) exactly once at construction. On every committed event,
`drive()` runs `apply` for every registered unit whose cell hasn't already
seen that seq, using `Object.is` to detect whether the state reference
changed; only on a changed reference (and only when at least one `onChanged`
listener exists) does it compute the wire `view()` and compare *that* by
`Object.is` too, notifying listeners only on an actual view change
(`index.ts:637-657`). This is a real double-debounce: state-reference
equality gates the view computation, and view-reference equality gates the
notification.

### `stateOf`

`index.ts:307-315`:
```ts
stateOf<K extends keyof SessionProjectionStateMap>(session, key): SessionProjectionStateMap[K] | undefined {
  const registration = this.registrations.get(key)
  if (registration === undefined) return undefined
  this.materializeCells(session)
  return this.cellFor(registration, session).state as SessionProjectionStateMap[K]
}
```
It materializes **every** registered unit's cell for the session (lazily
folding the full in-memory log on first touch, `buildCell` at
`index.ts:579-587`) and returns the requested unit's current state — the
live, mutable-by-reference internal state, not the wire view. Returns
`undefined` only if the key itself is unregistered.

### Snapshot / checkpoint / restore

- `snapshot(session, keys?)` (`index.ts:326-340`) — one consistent
  `{ asOfSeq, values }` cut over every registered **client-visible**
  (`wire`-bearing) unit; `asOfSeq = session.seq - 1`.
- `checkpoint(session)` (`index.ts:384-395`) — the durable write side: one
  row per registered key, `{ ver: stateVersion, seq: observedSeq, val:
  structuredClone(state) }` — explicitly detached ("never the live cell
  reference: the watermark cache is this registry's authoritative mutable
  state").
- `restoreFloor(checkpoint)` (`index.ts:413-423`) — computes the seq a cold
  suffix-read should start from: the lowest usable watermark across all
  registered units, minus one (so `restore` can detect the log having
  shrunk below a stale checkpoint's watermark — i.e. crash-repair
  truncation — instead of silently trusting a stale row).
- `restore(checkpoint, events, baseSeq, header)` (`index.ts:482-522`) — cold
  path: seeds each unit from its checkpoint row if usable (`ver` matches,
  `seq` inside `[baseSeq-1, endSeq]`), else `init(header)`, then folds the
  supplied tail forward. A usable-row check failing when `baseSeq > 0`
  **throws**, forcing the caller to re-read from seq 0.
- `hydrate(session, checkpoint, events, baseSeq)` (`index.ts:534-571`) —
  installs the restored (or already-complete) cells directly onto a
  **specific prepared `Session`** object, so a later publication reuses
  them rather than re-folding.

This whole subsystem (`ProjectionCheckpointRow`/`ProjectionCheckpoint`,
`index.ts:113-130`) is clearly the backing for a separate **persisted
projection cache** package (`packages/session/session-projection-cache`,
seen in the directory listing but not opened in this pass — flagged
UNKNOWN: I confirmed the *shape* the cache must persist
(`(sessionId, key, ver, seq, val)` rows) from the projection package's own
comments, but did not read `session-projection-cache/src/index.ts` to
confirm its concrete storage mechanism).

---

## 7. Persistence: backend, `SessionPreparation`, `persistence.prepare()`

### What backend actually runs

**JSONL, not SQLite**, is the durable session-log backend. Confirmed two
ways:
1. `packages/bundle/base/cordis.patch.yml:110-113` — the real base profile
   plugin list includes:
   ```yaml
   - id: session-persistence-jsonl
     name: '@deepseek-ai/dsh-session-persistence-jsonl'
     config:
       root: !!js dshHomePath('sessions')
   ```
   This is the shared-base patch layer (`packages/bundle/base`), which per
   `AGENTS.md`'s package map (`packages/README.md` reference) composes into
   the one real application, `apps/server`. I did not additionally open
   `apps/server`'s own boot code to trace the exact profile-loading call,
   so the link from `cordis.patch.yml` to the running process is
   **INFERRED** from the bundle package's name/role and the presence of
   many `snapshots/session/*/cordis.yml` recorded fixtures that reference
   the same plugin id.
2. `packages/session/session-persistence-jsonl/src/index.ts` implements
   `SessionPersistence` (`class JsonlSessionPersistence extends
   SessionPersistence implements PersistenceBackend<JsonlTornMarker>`,
   line 123) and registers via `static inject = ['sessions']` — a Cordis
   Service Definition plugin, loaded exactly like any other.

A **SQLite** package does exist in the repo
(`packages/session-query/session-query-sqlite`), but it is a **search
index** — "Concrete `ctx.sessionQuery` backend with SQLite FTS5 search" per
its own `package.json` description — built as an optional read-side
consumer of the session log, not the durable event-log store itself. Its
`peerDependenciesMeta` marks `@deepseek-ai/dsh-session-persistence` as
`"optional": true`, consistent with it being a downstream index rather than
the log's source of truth. I did not open its source to fully confirm this
characterization — flagged **INFERRED** from package metadata and naming
only.

### The `PersistenceBackend` contract

`packages/session/session-persistence/src/coordinator.ts:128-219` defines
the minimal primitive set a concrete backend must implement:
`loadStored`, `readStoredRevision`, optional `loadStoredFrom` (seek-capable
suffix read), optional `materializeHeader`, `appendBatch`, `commitRepair`,
`list`, optional `locate`, optional `close`. Everything else — batching,
per-id serialization, crash-repair sequencing, an LRU of unpublished
prepared `Session`s, and dispose-time draining — lives in the shared
`PersistenceCoordinator` class that every first-party backend composes
(`new PersistenceCoordinator(ctx, this, options)`, e.g.
`session-persistence-jsonl/src/index.ts:162-165`).

The JSONL backend itself stores **one append-only file per session**
(header line + event lines), grouped into human-readable project
directories, with an optional Zstandard-compressed physical encoding
(`compression: 'zstd' | 'none'`, default `'zstd'`) and an optional lossless
`assistant/chunk`-run packing format (`packChunks`, default `true`) that
collapses runs of ≥3 consecutive same-block delta chunks into one
`text-chunks`/`reasoning-chunks`/`tool-call-chunks` storage row (see
`packages/core/session/src/chunk-rows.ts:1-20`: "~56× measured on a real
DeepSeek session" size difference for the reason to pack). Materialization
uses `link()`+`unlink()` (not `rename()`) so two processes cannot clobber
each other (`index.ts:560-565` in the JSONL backend, comment explains the
EEXIST race protection), and appends are fsync'd with a rollback-on-failure
path that truncates back to the pre-write size (`appendLines`,
`jsonl/src/index.ts:670-698`).

### `SessionPreparation` / `persistence.prepare()`

`SessionPreparation` (`packages/core/session/src/preparation.ts:20-49`) is a
tiny `Disposable` wrapper:
```ts
export class SessionPreparation implements Disposable {
  readonly session: Session
  static create(session: Session, options?: SessionPreparationOptions): SessionPreparation
  [Symbol.dispose](): void { ...calls options.release?.() once... }
}
```
Its purpose (per module doc): "Ownership of one unpublished Session before
registry publication." It exists so a caller can build a fully validated,
constructed-but-not-yet-`ctx.sessions`-entered `Session` object, decide
whether to actually publish it, and — if not — cleanly release any backend
state that was reserved for it (e.g. an LRU slot in
`PersistenceCoordinator`'s prepared-session cache).

`SessionPersistence.prepare(id, signal?)` (abstract-with-default,
`packages/session/session-persistence/src/index.ts:186-199`) is the
**generic** default implementation any backend inherits unless it overrides:
it calls its own `load(id)`, then `SessionPreparation.create(sessions.prepare(id, {
seed: loaded.events.map(structuredClone), meta: structuredClone(loaded.meta),
seedSource: 'persistence' }))`. The JSONL backend **overrides** `prepare` to
delegate to `PersistenceCoordinator.prepare` instead
(`jsonl/src/index.ts:190-192`), which is the real, optimized path:

`PersistenceCoordinator.prepare` (`coordinator.ts:744-771`) loops until it
can produce a stable, race-free reservation:
1. Waits for any in-flight retirement of the same id.
2. Rejects if the id is already live in `ctx.sessions`.
3. Calls `this.preparations.reserve(id, loadFn, commitFn, signal)` — a
   bounded LRU/sharing structure (`SessionPreparations`, in
   `preparations.ts`) that de-duplicates concurrent cold reads for the same
   id, and exclusively "reserves" a ready source for the caller performing
   `commitFn` (which durably repairs any crash tail via `commitPrepared`,
   `coordinator.ts:1016-1045`, and only returns a state once the durable log
   revision is confirmed unchanged — `isPreparedSourceCurrent`,
   `coordinator.ts:1048-1053`).
4. Wraps the exact unpublished `Session` in a `SessionPreparation` whose
   `release` callback returns the reservation to the reusable pool **only
   if** the caller never mutated it (`reservation.source.session.events.length
   === reservation.source.sessionLength`, `coordinator.ts:764-767`) —
   otherwise it is discarded.

`prepareCore` (`coordinator.ts:974-1013`) is where crash recovery actually
happens for the *cold* read path: it loads the stored prefix, upgrades
legacy shapes (`adoptStoredEvents`), computes
`interruptedTurnClosers(storedEvents)` (from `repair.ts`, §below), appends
those synthetic closers to the balanced seed, and constructs the session via
`ctx.sessions.prepare(id, { seed: balanced, meta, seedSource: 'persistence' })`
— i.e. **`Session.fromRestore`** (§1) is the actual construction path for
every resumed session.

### Crash-recovery repair (`repair.ts`)

`interruptedTurnClosers(events)` (`packages/core/session/src/repair.ts:28-134`)
scans a stored log for an unterminated tail (an open `turn/start` with no
matching `turn/end`) and, if found, synthesizes:
1. One `tool/result` per still-pending tool call (`assistant/message`
   registered a `tool-call` block that never got a matching `tool/result`),
   with an error message distinguishing two states:
   - `TOOL_NOT_STARTED` (`'TOOL_NOT_STARTED'`, `repair.ts:14`) — the model
     requested the call, but no `tool/call` event was ever logged for it:
     "Retry it if it is still needed."
   - `TOOL_OUTCOME_UNKNOWN` (`'TOOL_OUTCOME_UNKNOWN'`, `repair.ts:17`) — a
     `tool/call` **was** logged (so the tool may have run) but no result
     landed: "Decide whether to retry from the tool semantics: retry only
     if the operation is read-only or idempotent... Do not retry blindly."
2. A synthetic `step/end` if a step was still open.
3. A synthetic `turn/end` with `reason: { kind: 'interrupted' }` — the
   **only** writer of the `interrupted` `TurnEndReason` variant (confirmed:
   the loop itself never emits it, per the type doc quoted in §2).

All synthetic events reuse the last real event's `time` ("never invents a
'future' time", `repair.ts:85`) and continue its `seq` sequence. This
function is pure and returns `[]` for an already-balanced log — a *complete*
final turn is left completely untouched; only a *torn* physical tail (e.g.
a half-written JSONL line from a real crash) is separately truncated by the
backend's own `commitRepair`/`tornMarker` mechanism (JSONL:
`packages/session/session-persistence-jsonl/src/index.ts:451-460`).

### Live-session HMR/reload adoption

`PersistenceCoordinator.onCreated` (`coordinator.ts:1318-1375`) handles the
case where a **live** `Session` (already running in-process, e.g. across a
dev-server hot-module-reload) needs to reconcile with whatever the backend
already has on disk — four cases documented at `coordinator.ts:1305-1317`:
already tracked (no-op or ownerless-state claim), a matching on-disk prefix
(adopt + persist the live suffix, `adoptLivePrefix`,
`coordinator.ts:1383-1405` — explicitly does **not** route through cold
`prepareCore`, because that would wrongly crash-repair a turn the live
session is still actively extending), a mismatched artifact (reject as
collision), or genuinely new (register + persist the seed once).

---

## Gaps / things flagged but not fully verified

- **Domain-package `SessionEventMap` merge sites** — I confirmed the
  mechanism and the generated allow-list, but did not open every domain
  package's own `declare module` block (e.g. `packages/compaction/*`,
  `packages/todo/*`) to see the individual payload shapes for events like
  `compaction/start`, `todo/write`, `hook/invoked`, etc. Only
  `compaction`-related replace-op payloads were directly inspected via
  their append call sites, not their full `SessionEventMap` entries.
  UNKNOWN — checked `known-event-types.ts` (the generated name list) and the
  merge mechanism; would need to open each domain package's `types.ts` to
  get authoritative payload shapes for the book.
- **`packages/session/session-projection-cache`** — I read its role only
  indirectly through the projection registry's `ProjectionCheckpoint` shape
  comments; did not open its source. UNKNOWN — would need
  `packages/session/session-projection-cache/src/index.ts` and `spec.ts`.
- **`apps/server` boot chain** — I confirmed the JSONL plugin appears in
  `packages/bundle/base/cordis.patch.yml` and is exercised by many
  `snapshots/session/*/cordis.yml` recorded fixtures, but did not trace
  `apps/server`'s own entry code to see the exact runtime call that loads
  this profile. INFERRED, not directly confirmed, that this is what runs in
  production.
- **`session-query-sqlite`'s exact relationship to the durable log** — read
  only its `package.json`; did not open its `src/` to confirm it merely
  indexes events (e.g. via `readFrom`/projections) rather than storing them.
  INFERRED from naming/metadata only ("Concrete ctx.sessionQuery backend
  with SQLite FTS5 search", `peerDependenciesMeta.dsh-session-persistence:
  optional`).
- **`.agents/notes/.../2026-08-10-session-log-version-mechanism.md`** — cited
  by the `SESSION_FORMAT_VERSION` doc comment for the full upgrade-chain
  design, but this is a design note, not code; not opened/verified as part
  of "read the implementation."
- **Dead-code check**: every mechanism described above (`append` with
  surface options, `deriveMessages`, the JSONL backend, `interruptedTurnClosers`,
  the projection registry's drive loop) was traced to a real call site
  outside its own test suite — `packages/core/agent-loop/src/agent.ts` for
  the event log and surface, `packages/compaction/compaction-basic/src/region.ts`
  and `packages/compaction/compaction-tool-result-pruner/src/index.ts` for
  surface replace, and `packages/bundle/base/cordis.patch.yml` +
  `snapshots/session/*/cordis.yml` for the JSONL backend's real
  configuration. I did not find or verify a non-test call site for
  `sessionProjections.register()` itself (i.e. which concrete domain plugin
  registers a real projection) — UNKNOWN, would need to grep
  `ctx.sessionProjections.register(` or `sessionProjections.register(`
  across `packages/*/src` outside the projection package itself.
