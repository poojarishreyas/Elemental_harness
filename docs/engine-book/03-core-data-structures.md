# Chapter 3 · The core data structures

**What you'll learn:** every type that flows through the engine, with its real definition and a real example. This chapter is the vocabulary for the rest of the book.

**Prerequisites:** [Chapter 2](02-just-enough-architecture.md).

---

Examples in this chapter come from `snapshots/session/text-turn/session.jsonl`, a recorded session held in the repository as a replay fixture. **It is normalized**: session ids, paths, message ids, and the two largest payloads appear as placeholders (`{{session:1}}`, `{{cwd}}`, `{{system}}`, `{{tools}}`). Everything else — event order, chunk shapes, token counts — is as captured.

---

## 1. The event envelope

Everything durable is a `SessionEvent`:

```ts
seq: number    // monotonic sequence number within the session
time: number   // epoch ms
type: T        // key of SessionEventMap
data: SessionEventMap[T]
```
— `packages/core/session/src/types.ts:391-398`

Two optional fields appear on surface-eligible events only (§3), and one more on any event:

- `ignorable?: true` — "marks an event a reader may safely skip when it does not recognize `type`" (`types.ts:399-409`). Absent means required; an unrecognized required event makes a reader refuse the whole log rather than misinterpret it.

**`seq` is always the event's zero-based index in the log.** It is assigned at exactly one place — `seq: this.log.length` (`packages/core/session/src/index.ts:627`) — and contiguity is enforced at four independent boundaries (Chapter 5).

## 2. The event vocabulary

The core map:

```ts
export interface SessionEventMap {
  'turn/start':        { turn: number }
  'turn/end':          { turn: number; reason: TurnEndReason }
  'step/start':        { turn: number; step: number }
  'step/end':          { turn: number; step: number }
  'user/message':      UserMessage
  'assistant/chunk':   { turn: number; step: number; chunk: StreamChunk }
  'assistant/message': { turn: number; step: number; message: AssistantMessage
                         usage?: TokenUsage; interrupted?: true }
  'tool/call':         { turn: number; step: number; callId: ToolCallId
                         name: string; arguments: string }
  'tool/result':       { turn: number; step: number; message: ToolResultMessage
                         error?: { name: string; code: string }; meta?: JsonValue }
  'request/header':    { header: EpochHeader; reason: RequestHeaderReason; startsSeries?: true }
  'request/context':   RequestContext
  'session/end-seed':  Record<string, never>
}
```
— `packages/core/session/src/types.ts:216-320`

Note `'user/message': UserMessage` — the event's `data` **is** the message, passed through verbatim when derived. There is no wrapper.

**This map is open.** Other packages extend it by TypeScript declaration merging, and the build generates the complete vocabulary — currently ~50 types including `compaction/start`, `approval/asked`, `todo/write`, `llm/retry`, `agent/inbox/spliced` (`packages/core/session/src/known-event-types.ts:22-74`). That generated set is a read-side gate: a stored log containing a type outside it is **refused** unless the event is marked `ignorable` (`session-persistence/src/coordinator.ts:1143-1148`).

This is why adding an event type does not require a format-version bump. `SESSION_FORMAT_VERSION = 0` (`types.ts:51`) moves only for structural change — the envelope, the header shape, core event semantics, or the surface mechanism.

### `TurnEndReason`

Six variants (`types.ts:150-169`), merge-extensible:

| Kind | Meaning |
|---|---|
| `completed` | The model finished without asking for more work |
| `max-tokens` | A step hit the output ceiling; **sticky** once set (Chapter 9) |
| `blocked` | A pre-step decision rejected the step |
| `aborted` | Carries the `AgentCancelCause` |
| `error` | Carries an `LlmFailure` |
| `interrupted` | **The loop never writes this.** A persistence backend closed a crash-orphaned turn on reload (Chapter 30) |

## 3. The surface

The model does not see the log. It sees an ordered view over it called the **surface**, and only three event types may join:

```ts
type SurfaceEventType = 'user/message' | 'assistant/message' | 'tool/result'
```
— `types.ts:330-334`

Those three **must** carry a surface intent; every other type must not (enforced by a conditional parameter type on `append()`, Chapter 5). The intent is:

```ts
type SurfaceOp = 'append' | { op: 'replace'; start: number; end: number }
```
— `types.ts:359-361`

plus optional `sourceEventSeqs: number[]` — "seq numbers of earlier events that this event cites as sources" (`types.ts:410-422`). For an assistant message, those are the chunk events it was assembled from. For a compaction replacement, they must cover every node being superseded.

The surface itself exposes just two things:

```ts
interface SessionSurface {
  readonly nodes: readonly number[]      // ordered seqs currently visible
  readonly replaceGeneration: number     // bumped once per committed replace
}
```
— `packages/core/session/src/surface.ts:137-142`

`replaceGeneration` is small but load-bearing: it is how the message cache knows to rebuild (Chapter 7) and how the engine knows to start a new request series (Chapter 10).

## 4. Messages and content

```ts
interface Message {
  readonly id: MessageId
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: ContentBlock[]
  readonly source: MessageSource
}
```
— `packages/llm/llm/src/message.ts:131-140`

`source` records provenance, keyed by `kind`: `user`, `plugin` (carries the plugin name), `model` (carries provider/model), `tool` (carries the call id) — `message.ts:102-107`. Messages are built only through frozen factories (`createMessage`, `createAssistantMessage`, `createToolResultMessage`); there is no mutable constructor.

Content blocks (`packages/llm/llm/src/types.ts:54-110`), also merge-extensible:

| Block | Shape |
|---|---|
| `text` | `{ type, text }` |
| `reasoning` | `{ type, text }` — the model's chain of thought, distinct from visible text |
| `image` | `{ type, attachment }` — in practice user messages only |
| `tool-call` | `{ type, id, name, arguments }` — `arguments` is the **raw JSON string** the model produced, unparsed |
| `tool-result` | `{ type, toolCallId, content, isError? }` |

### A real message

From `session.jsonl:23`, the assistant's reply to "Reply with exactly the word: PONG":

```json
{"role":"assistant",
 "content":[{"type":"reasoning","text":"The user wants me to reply with exactly the word \"PONG\" and not use any tools."},
            {"type":"text","text":"PONG"}],
 "source":{"kind":"model","provider":"deepseek-official","model":"deepseek-v4-flash"},
 "id":"{{message:3}}"}
```

Two blocks: the reasoning, then the answer.

## 5. Streaming chunks

What arrives from a provider, provider-neutral:

```ts
type StreamChunk =
  | { type: 'block-start';      index: number; blockType: ContentBlockType }
  | { type: 'text-delta';       index: number; text: string }
  | { type: 'reasoning-delta';  index: number; text: string }
  | { type: 'tool-call-delta';  index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end';        index: number; block: ContentBlock }
  | { type: 'usage';            usage: TokenUsage }
  | { type: 'finish';           reason: FinishReason; replayState?: ReplayEnvelope }
```
— `packages/llm/llm/src/types.ts:364-376`

Contract: usage arrives before the terminal finish; nothing follows finish; tool arguments stay raw strings.

`FinishReason` (`types.ts:116-125`): `stop`, `tool-calls`, `max-tokens`, `aborted{failure}`, `error{failure}`.

Real usage from the same turn (`session.jsonl:21`):

```json
{"inputTokens":3091,"outputTokens":23,"cacheReadTokens":0,"reasoningTokens":20}
```

3,091 input tokens for a one-line prompt — almost all of it system prompt and tool schemas.

## 6. The request header

What pins a request's identity:

```ts
interface EpochHeader {
  config: LlmCallConfig          // provider, model, reasoningEffort?, temperature?, maxTokens?, stop?
  adapterDefaults?: LlmCallConfigAdapterDefaults
  system?: string
  tools?: ToolSchema[]
}
```
— `packages/core/session/src/types.ts:179-188`, `packages/llm/llm/src/call-config.ts:23-30`

`adapterDefaults` is `{ reasoningEffort?: true; maxTokens?: true }` — a record of which fields the *caller* omitted and the *adapter* filled in. It exists so the next request can strip them and re-resolve rather than freezing one model's defaults onto another (Chapter 10).

A header event carries a `reason`: `initial`, `resume`, `change`, or `series` (`types.ts:200-208`). From `session.jsonl:12`:

```json
{"header":{"config":{"provider":"deepseek-official","model":"deepseek-v4-flash"},
           "system":"{{system}}","tools":"{{tools}}"},
 "reason":"initial"}
```

## 7. Tools

```ts
interface ToolDefinition extends ToolSchema {   // name, description, parameters (JSON Schema)
  output: { schema, render(args, value), presentationMeta?(args, value) }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  finalizeContent?(exec, result): ContentBlock[] | undefined
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  presentCall?(args) / presentResult?(args, result)
}
```
— `packages/core/tools/src/index.ts:214-280`

`execute` returns a **canonical value**, not model-facing content; `output.render` projects that value into content blocks. The separation matters for replay.

The result:

```ts
type ToolExecutionResult =
  | { isError: false; value: JsonValue; content: ContentBlock[]
      meta?: JsonValue; additionalContexts?: UserMessage[]; concludesTurn?: true }
  | { isError: true;  error: ToolFailure; content: ContentBlock[]
      meta?: JsonValue; additionalContexts?: UserMessage[] }
```
— `packages/core/tools/src/index.ts:549-573`

Three fields deserve flagging now:
- **`value` never reaches the durable log.** The `tool/result` event records only the message, `error.info`, and `meta` (`tool-calls.ts:269-289`).
- **`additionalContexts`** are user messages staged for the *next* step, not part of the result the model reads.
- **`concludesTurn`** lets a single tool result end the turn — and is typed `never` on failures, so a failed call can never stop a turn.

---

## Key takeaways

- `seq` is the log index, assigned at one place; contiguity is a hard invariant.
- The event vocabulary is open and generated; `SESSION_FORMAT_VERSION` moves only for structural change.
- Only three event types touch the surface, and they must declare `append` or `replace`.
- `replaceGeneration` is the signal that history was rewritten — it drives both cache invalidation and request-series boundaries.
- Tool results separate the canonical `value` (never logged) from rendered `content` (logged and shown to the model).

## Exercises

1. `'user/message': UserMessage` means the event data is the message itself. What would break if a producer wrapped its text in `<context>` tags at derive time instead of at append time? (`surface.ts:90-94` answers it.)
2. Given the surface may only contain three event types, explain why `turn/start` and `tool/call` still have to be in the log at all.
3. The recorded turn reports 3,091 input tokens to send the word "PONG". Where did they go, and which chapter would you look in to reduce them?

**Next:** [Chapter 4 · The engine in 100 lines](04-the-engine-in-100-lines.md)
