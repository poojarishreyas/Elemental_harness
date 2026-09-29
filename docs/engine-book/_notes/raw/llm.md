# The LLM capability (`packages/llm/**`) — raw research notes

Scope: `packages/llm/llm` (the abstract service/vocabulary package,
`@deepseek-ai/dsh-llm`), `packages/llm/llm-deepseek` (the concrete DeepSeek
adapter, `@deepseek-ai/dsh-llm-deepseek`), `packages/llm/llm-pi-ai` (a generic
multi-provider adapter built on the `pi-ai` library), `packages/llm/llm-retry`
(the request-retry policy executor), `packages/llm/token-meter` (token
accounting), `packages/llm/deepseek-llm-api-extensions` (a request-field
extension registry). Every claim below is grounded in code actually read;
paths are relative to the repo root
`C:\Users\shrey\desktop\Elemental_harness`.

Ground rule applied throughout: comments/docstrings are treated as claims to
verify, not evidence. Where a comment's claim is confirmed by code executed
elsewhere (e.g. bundle wiring), that second source is cited too.

---

## 1. The `llm` service — definition and `prepareCall()`

**Definition.** `LlmRuntime` is a Cordis service class that is both an
adapter registry (provider-route → adapter mapping) and the streaming
dispatch entry point, interceptable through one waterfall event.

- Class: `packages/llm/llm/src/index.ts:326` → `export class LlmRuntime extends TypertRemoteService`.
- Registered onto `Context` via declaration merging: `packages/llm/llm/src/index.ts:49-52` → `interface Context { llm: LlmRuntime }`.
- Constructor calls `super(ctx, 'llm')` (`packages/llm/llm/src/index.ts:335`), so the service is exposed at `ctx.llm`.
- Internal state: `private adapters = new Map<string, AdapterRegistration>()`, `private directory = new Map<string, LlmConfigurableProvider>()`, `private discoveries = new Map(...)` (`packages/llm/llm/src/index.ts:327-332`). `AdapterRegistration` is `{ adapter, provider, retryPolicy }` (`packages/llm/llm/src/index.ts:1079-1083`).
- Default export: `packages/llm/llm/src/index.ts:1092` → `export default LlmRuntime`.
- It is mounted into the app as a plugin row `id: llm, name: '@deepseek-ai/dsh-llm'` in the base bundle: `packages/bundle/base/cordis.patch.yml:26-27`.

**`prepareCall()` — step by step.**
`packages/llm/llm/src/index.ts:890-935` → `async prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>`:

1. `const registration = this.registration(config.provider)` (line 891) — look up the adapter registered for `config.provider` in the `adapters` map; throws `LlmError('no adapter registered for provider "..."', 'NO_ADAPTER')` if absent (`packages/llm/llm/src/index.ts:937-941`, `packages/llm/llm/src/index.ts:939`).
2. `const adapterCall = await registration.adapter.prepareCall(config.provider, config.model, signal)` (line 892) — calls the adapter's own `prepareCall`, which by default (base class `LlmAdapter.prepareCall`, `packages/llm/llm/src/index.ts:262-267`) just resolves model metadata and returns a `stream` closure bound to `this.stream(options)`; concrete adapters may override this to bind everything to one "generation" of dynamic settings (see §2).
3. `const modelInfo = this.normalizeModelInfo(registration, config.model, adapterCall.model)` (line 893) — validates/detaches the adapter-returned `LlmResolvedModelInfo` (checks provider/id match, non-empty name, positive integer `contextWindow`, safe-integer `defaultMaxTokens`, well-formed `reasoning.efforts`, etc.; throws various `INVALID_MODEL_*` codes) — `packages/llm/llm/src/index.ts:730-820`.
4. `const resolved = this.resolveCallWithInfo(config, modelInfo)` (line 894) — materializes `maxTokens` from `info.defaultMaxTokens` when the caller omitted it, and resolves `reasoningEffort` against the model's declared reasoning capability, rejecting an explicit unsupported effort with `UNSUPPORTED_REASONING_EFFORT`, or filling in `info.reasoning.defaultEffort` when the caller specified none (`packages/llm/llm/src/index.ts:846-880`).
5. Detaches and deep-freezes the resolved config and (if present) context: `deepFreeze(structuredClone(resolved.config))` and same for `resolved.context` (lines 895-898).
6. Computes `adapterDefaults: LlmCallConfigAdapterDefaults` — a frozen object with `reasoningEffort: true` and/or `maxTokens: true` set exactly when the *caller's* `config` omitted that field but the *resolved* config has a value (i.e., the adapter supplied it) (lines 899-906).
7. Returns a frozen `PreparedLlmCall` object (`Object.freeze({...})`, lines 908-934) exposing `config`, `retryPolicy` (`registration.retryPolicy`, captured at adapter-registration time — see §2/§6), `adapterDefaults`, optional `context` and `inputModalities`, and a one-shot `stream(options)` method.
8. The returned `stream` closure enforces single-use (`dispatched` flag, throws `INVALID_PREPARED_CALL` on reuse, line 917-919) and requires `options` to be field-wise equal (`callConfigEquals`) to the `resolvedConfig` captured at prepare time, else throws `INVALID_PREPARED_CALL` (lines 920-925). On success it calls `this.streamWithRegistration(options, { registration, config: resolvedConfig, modelInfo, dispatch: options => adapterCall.stream(options) })` (lines 927-932), i.e. it pins the *same* adapter registration and adapter-returned model/dispatch snapshot that was resolved in step 2-3, so a settings/HMR change between `prepareCall` and the actual `stream()` call cannot mix generations.

**What `PreparedLlmCall` is** (interface, `packages/llm/llm/src/index.ts:157-177`):
```ts
export interface PreparedLlmCall {
  readonly config: LlmCallConfig
  readonly retryPolicy: ResolvedRetryPolicy
  readonly context?: LlmModelContext
  readonly inputModalities?: readonly ModelModality[]
  readonly adapterDefaults: LlmCallConfigAdapterDefaults
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
```
This exactly matches how the agent loop uses it (see §7's cross-reference and the agent-loop excerpt below).

**Consumer (agent loop).** `packages/core/agent-loop/src/agent.ts:489` → `preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)`, wrapped in a `try`/`catch` that falls back to the *unresolved* `proposedConfig` only when the failure is specifically `LlmError` with `code === 'NO_ADAPTER'` (`packages/core/agent-loop/src/agent.ts:491-495`) — i.e. the loop tolerates "middleware may serve an unregistered route" (comment at line 492) but any other `prepareCall` failure (e.g. `UNSUPPORTED_REASONING_EFFORT`, `INVALID_MODEL_*`) propagates. Later: `const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)` (`packages/core/agent-loop/src/agent.ts:364`) — this is the literal fallback the task description named, confirmed verbatim in the source.

---

## 2. Adapters — registration, selection, `adapterDefaults`

**What an adapter is.** `LlmAdapter` is an abstract class (`packages/llm/llm/src/index.ts:193-275`) that adapters (DeepSeek, pi-ai) extend. Only `stream(options): AsyncIterable<StreamChunk>` is abstract/required (line 274); everything else has a default:
- `providerInfo(provider)` → `{ id: provider, name: provider }` (line 199-201).
- `providerRetryPolicy(_provider)` → `undefined` (falls back to normal defaults) (line 208-210).
- `imageRequestPricing(_provider, _model)` → `undefined` (line 221-223).
- `listModels(_provider)` → `Promise.resolve([])` (line 232-234).
- `resolveModel(provider, model, _signal)` → `Promise.resolve({ provider, id: model, name: model })` (line 245-251).
- `prepareCall(provider, model, signal)` → default binds `resolveModel` + `stream` into one `PreparedAdapterCall` (lines 262-267); a "dynamic" adapter (see below) overrides this to snapshot per-generation connection facts.

**Registration.** `ctx.llm.registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle` (`packages/llm/llm/src/index.ts:380-409`):
- Runs inside `this.ctx.effect(...)` so registration is disposed automatically with the owning plugin fiber (line 387, `'llm.registerAdapter()'`).
- Validates via `prepareRoutes` (lines 416-438): each provider name must be non-empty; a name already held by *another* registration throws `DUPLICATE_ADAPTER`; adapter-declared `providerInfo(provider).id` must equal `provider` and have a non-empty `name`, else `INVALID_ADAPTER`. Validation is all-or-nothing (no partial registration).
- `providerRetryPolicy(provider)` is captured **at registration time** into `ResolvedRetryPolicy` via `resolveRetryPolicy(undefined, ...)` fallback (line 429-430) — this is the "policy captured with this route" that `PreparedLlmCall.retryPolicy` and `LlmRuntime.providerRetryPolicy()` both read back later; it does not re-resolve per request.
- `commitRoutes` (lines 447-455) swaps the Map entries in one synchronous block, then emits `llm/adapters-updated` (non-vetoing broadcast, `emitAdaptersUpdated`, lines 339-364 — contains listener throws unless coded `INVARIANT`).
- Returns a callable disposer plus `.replace(providers: string[])` (`AdapterRegistrationHandle`, interface at lines 281-299) that atomically swaps the *same* adapter instance's route set (used when e.g. registration-captured retry policy changes — see the DeepSeek/pi-ai plugin `ensureRegistrationFacts` pattern below).

**Selection by provider/model.** Selection is a flat string-keyed lookup: `GenerateOptions.provider` selects the `AdapterRegistration` from the `adapters` Map (`private registration(provider): AdapterRegistration`, `packages/llm/llm/src/index.ts:937-941`); `GenerateOptions.model` is then just a string handed to that adapter's `resolveModel`/`stream` — the harness itself does not validate the model id against any catalog before dispatch (`listModels`/catalog membership is explicitly "advisory": `packages/llm/llm/src/types.ts:284` comment, and enforced in code — `resolveModelInfoFor` calls the adapter, and adapters like DeepSeek fall back to treating an unrecognized model as text-only rather than rejecting it, `packages/llm/llm-deepseek/src/adapter.ts:398-407`).

**`adapterDefaults`.** Type: `packages/llm/llm/src/call-config.ts:36-39`:
```ts
export interface LlmCallConfigAdapterDefaults {
  reasoningEffort?: true
  maxTokens?: true
}
```
It records which of the two fields were *not* supplied by the caller but were filled in from the resolved exact-model metadata. Computed in `prepareCall` (`packages/llm/llm/src/index.ts:899-906`) by comparing the caller's original `config.reasoningEffort`/`config.maxTokens` (undefined) against the resolved config's values (present). Confirmed by test: `packages/llm/llm/tests/service.spec.ts:684-689` — a bare `{ provider: 'route', model: 'model' }` call yields `adapterDefaults: { maxTokens: true }`, while an explicit `maxTokens` yields `{}`; and lines 851-854 show `{ reasoningEffort: true }` plus `Object.isFrozen(prepared.adapterDefaults) === true`.

**Exact-model defaults resolution.** `resolveCallWithInfo` (`packages/llm/llm/src/index.ts:846-880`):
- `maxTokens`: `config.maxTokens === undefined && info.defaultMaxTokens !== undefined ? {...config, maxTokens: info.defaultMaxTokens} : config`.
- `reasoningEffort`: if the model declares no `reasoning` capability but the caller requested an effort, throws `UNSUPPORTED_REASONING_EFFORT`. If the model declares `reasoning`, the effective effort is `requested ?? reasoning.defaultEffort`; if that effective effort isn't in `reasoning.efforts`, throws `UNSUPPORTED_REASONING_EFFORT`; otherwise it's materialized onto the config if different from what was requested.
- Concretely, for DeepSeek: `modelInfoFor` (`packages/llm/llm-deepseek/src/adapter.ts:393-430`) sets `defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens` (deployment config, default `256_000` — `DEFAULT_MAX_TOKENS`, line 142) and a `reasoning.defaultEffort` derived from the plugin's configured `reasoningEffort` (off/low/high/max, default `high` per `Config.reasoningEffort` doc comment) unless `thinking === 'disabled'`, in which case only `off` is offered (`OFF_ONLY_REASONING_EFFORTS`, lines 187-193, 410-417).

**Dynamic per-generation binding.** Both concrete adapters override `prepareCall` to snapshot *connection facts* (endpoint, credential ref, model catalog, retry policy) once per call rather than re-reading live settings mid-stream:
- DeepSeek: `packages/llm/llm-deepseek/src/adapter.ts:432-438` → `prepareCall` calls `this.config.options()` once and returns `{ model: this.modelInfoFor(connection, provider, model), stream: options => this.streamWithConnection(options, connection) }`.
- The registering plugin re-resolves `options()` from the live settings snapshot per operation (`packages/llm/llm-deepseek/src/index.ts:409-427`, memoized by raw-config identity) and, when only the registration-captured `retryPolicy` changes, calls `registration.replace([PROVIDER])` to re-register in place (`packages/llm/llm-deepseek/src/index.ts:478-488`).

---

## 3. Message / content / config types (exact definitions)

**`Message`** — `packages/llm/llm/src/message.ts:131-140`:
```ts
export interface Message {
  readonly id: MessageId
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: ContentBlock[]
  readonly source: MessageSource
}
```
Specializations: `UserMessage` (`role: 'user'`, line 143-145), `AssistantMessage` (`role: 'assistant'`, `source: ModelMessageSource`, line 148-151), `ToolResultMessage` (`role: 'user'`, `content: [ToolResultBlock]`, `source: ToolMessageSource`, line 154-158).

`MessageSource` is a merge-extensible union keyed by `kind` (`MessageSourceMap`, `packages/llm/llm/src/message.ts:102-107`): `user: {kind:'user'}`, `plugin: {kind:'plugin', plugin: string} & ContextFormed`, `model: ModelMessageSource` (`{kind:'model'} & AssistantProvenance`, i.e. `{provider, model, replayState?}`, lines 9-26), `tool: ToolMessageSource` (`{kind:'tool', callId: ToolCallId}`, lines 29-32).

Construction is exclusively through frozen factories — there is no public mutable constructor:
- `createMessage` (lines 180-187) stamps a fresh `MessageId` via `randomUUID()` and calls `freezeMessage` = `deepFreeze(structuredClone(message))` (line 171-173).
- `createAssistantMessage(input)` (lines 208-219) — exactly the function the task description named — fixes `role: 'assistant'` and `source: {kind: 'model', ...input.source}`; `input.source` must supply `provider`/`model`/optional `replayState` (`NewAssistantMessage`, lines 162-164).
- `createToolResultMessage` (lines 233-243) wraps a single `ToolResultBlock`.

**`GenerateOptions`** — `packages/llm/llm/src/types.ts:393-429`:
```ts
export interface GenerateOptions {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  messages: Message[]
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: Branded<'SessionId'>
  purpose?: 'compaction' | 'session-title'
}
```
`ToolSchema` (lines 385-390): `{ name: string; description: string; parameters: Record<string, unknown> }` (JSON Schema).

**`LlmCallConfig`** — `packages/llm/llm/src/call-config.ts:23-30`:
```ts
export interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  temperature?: number
  maxTokens?: number
  stop?: string[]
}
```
A file-level `TODO(call-config-shape)` comment (line 15-16) flags this shape as unsettled: "Revisit which fields are epoch-level for cache reuse and where provider-specific request options belong" — an acknowledged open design question, not resolved in this codebase snapshot.

**Content blocks** — `packages/llm/llm/src/types.ts`:
- `TextBlock` (54-57): `{type:'text', text: string}`.
- `ReasoningBlock` (60-63): `{type:'reasoning', text: string}` — "distinct from visible text."
- `ImageBlock` (71-75): `{type:'image', attachment: ImageAttachmentRef}` — comment states it's role-neutral but "current production adapters declare text-only output, so only user messages may carry images" (line 69-70) — DeepSeek's adapter enforces this: `assertSupportedImageRoles` throws `UNSUPPORTED_CONTENT` for any non-user message carrying an image (`packages/llm/llm-deepseek/src/serialize.ts:117-126`).
- `ToolCallBlock` (78-85): `{type:'tool-call', id: ToolCallId, name: string, arguments: string}` — `arguments` is "Raw JSON string as produced by the model," not parsed.
- `ToolResultBlock` (88-93): `{type:'tool-result', toolCallId: ToolCallId, content: ContentBlock[], isError?: boolean}`.
- Merge-extensible via `ContentBlockMap` (99-105) keyed by `type`; `ContentBlock = ContentBlockMap[ContentBlockType]` (107-110).

There is no separate "thinking" type distinct from `ReasoningBlock` — DeepSeek's wire `reasoning_content` (thinking-mode CoT) maps directly onto `ReasoningBlock`/`reasoning-delta` (`packages/llm/llm-deepseek/src/translate.ts:142-150`).

---

## 4. Streaming chunk type and `BlockAssembler`

**`StreamChunk`** — `packages/llm/llm/src/types.ts:364-376`:
```ts
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope }
```
Kinds enumerated: `block-start`, `text-delta`, `reasoning-delta`, `tool-call-delta`, `block-end`, `usage`, `finish`. Documented contract (line 356-363): usage arrives before the terminal finish, nothing after finish, tool arguments stay raw JSON strings.

**`FinishReason`** (merge-extensible, `packages/llm/llm/src/types.ts:116-125`): `stop`, `tool-calls`, `max-tokens`, `aborted: {failure: LlmFailure}`, `error: {failure: LlmFailure}` — exactly the kinds named in the task ('error', 'aborted', 'max-tokens', plus 'stop'/'tool-calls').

**`BlockAssembler`** — `packages/llm/llm/src/assembler.ts` (full file read):
- Internal state: `partials: Map<number, PartialBlock>`, `order: number[]` (first-seen index order), `_usage`, `_finish`, `_replayState` (lines 39-43). `PartialBlock` (16-24): `{blockType, text, toolCallId?, toolCallName?, toolCallArguments, block?}` — `block` is set only by `block-end` and "freezes" the partial (later deltas for that index are ignored, lines 65-66/71-72, "closed by block-end; ignore stragglers").
- `push(chunk)` (49-96): a `switch` on `chunk.type`; `block-start` lazily creates a partial if absent; `text-delta`/`reasoning-delta` append to `.text` (ignored once `.block` is set); `tool-call-delta` sets `toolCallId`/`toolCallName` (once known) and appends `argumentsDelta` to `.toolCallArguments`; `block-end` sets `.block` only on **first** close (idempotent against duplicate close chunks); `usage` overwrites `_usage`; `finish` sets `_finish` and `_replayState`. Falls through to `assertNever(chunk, 'BlockAssembler.push')` for exhaustiveness (line 94) — but this is generic-typed against the *known* `StreamChunk` union, so a plugin-added chunk `type` would be a compile error upstream, not a runtime path.
- `assemble(partial, index)` (108-121): if `.block` was set by `block-end`, return it verbatim (authoritative); otherwise synthesize from accumulated deltas — `text`→`{type:'text', text}`, `reasoning`→`{type:'reasoning', text}`, `tool-call`→`{type:'tool-call', id: toolCallId ?? 'call-<index>', name: toolCallName ?? '', arguments: toolCallArguments}`; any other still-open `blockType` (e.g. an unclosed plugin block) **throws** `cannot assemble incomplete block of type "..."` (line 119) — confirmed by test `packages/llm/llm/tests/assembler.spec.ts` (`'video'` block-start with no block-end throws exactly this message).
- **`assembled()`** (134-150) — the single shared keep/drop decision: if `this.finish.kind === 'max-tokens'`, every `tool-call` block is dropped from the emitted set ("max-token truncation drops tool calls that cannot be executed safely," lines 130-134/137-139) — content blocks (text/reasoning) survive. This also prunes the parallel `replayState.blocks` array to the same positions (or discards the whole `replayState` if its `blocks.length` doesn't match the raw block count, lines 142-143).
- **`blocks()`** (158-160) → `this.assembled().blocks`.
- **`interruptedBlocks()`** (169-179) — used specifically on cancellation: returns only `text`/`reasoning` blocks (open or closed) with non-whitespace `.trim()` content, in stream order; tool-call blocks and any other open unknown-type block are omitted outright ("interruption precedes dispatch; retaining one would require a fabricated result," lines 165-167). This is exactly what `agent.ts` calls in its abort-handling `catch` (`packages/core/agent-loop/src/agent.ts:373-386`).
- **`usage`** getter (182-184): raw `TokenUsage | undefined` from the last `usage` chunk seen.
- **`finish`** getter (187-189): `this._finish ?? {kind: 'stop'}` — a stream that ends without ever sending a `finish` chunk defaults to a clean `stop`.
- **`replayState`** getter (191-198): `this.assembled().replay` — the pruned/possibly-discarded `ReplayEnvelope`.
- **`message(source)`** (204-207): wraps `blocks()` into a frozen assistant-role `Message` via `createMessage`; defaults `source` to `{kind: 'plugin', plugin: 'dsh-llm/assembler'}` when the caller doesn't supply one — but `agent.ts` always supplies its own `{provider, model, replayState?}` via `createAssistantMessage` instead of calling `assembler.message()` directly (`packages/core/agent-loop/src/agent.ts:410-417`), so this default path is effectively unused by the main loop (candidate dead/rarely-exercised default — **UNKNOWN** whether any other consumer calls `assembler.message()` without a source; not checked beyond `packages/core/agent-loop`).

**`ReplayEnvelope`** — `packages/llm/llm/src/types.ts:342-354`: `{response: unknown, blocks?: readonly unknown[]}` — adapter-private lossless-JSON state to replay a successful response; both halves stay opaque to the harness. `LlmRuntime.forAdapter()` (`packages/llm/llm/src/index.ts:944-957`) strips `replayState` from historical assistant messages whenever the *current* target provider's adapter instance differs from the one that produced them, converting the source back to a plain `{kind:'model', provider, model}` — i.e. replay data is only trusted across a request to the same live adapter instance.

---

## 5. `LlmError`, `failure`, error codes

**`LlmError`** — `packages/llm/llm/src/index.ts:86-120`, extends `HarnessError` (`packages/llm/llm/src/error.ts:13-22`, which just carries a stable `code: string` alongside `message`/`cause`). Constructor validates: non-empty `message`, non-empty `code`, optional `status` (integer 100-599), optional `providerRetryAfterMs` (positive finite), optional `requestId` (non-empty string) — throws plain `Error` (not `LlmError`) on malformed construction arguments themselves (lines 96-109). It stores a frozen `readonly failure: LlmFailure` snapshot (lines 112-118) built from the same validated fields.

**`LlmFailure`** — `packages/llm/llm/src/types.ts:40-51`:
```ts
export interface LlmFailure {
  readonly message: string
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number
  readonly requestId?: ProviderRequestId
}
```
This is the serializable, "policy decides whether retryable" (line 39 comment) shape carried on `FinishReason`'s `error`/`aborted` variants and on `agent/request-error`'s `failure` payload field.

**Error-code taxonomy actually observed in code** (not exhaustive — codes are free-form strings, "provider-neutral machine code," `packages/llm/llm/src/index.ts:84`):
- Registry/service: `NO_ADAPTER` (`index.ts:939`), `DUPLICATE_ADAPTER` (`index.ts:422`), `INVALID_ADAPTER` (`index.ts:388,420,426`), `REGISTRATION_DISPOSED` (`index.ts:404,522`), `INVALID_DIRECTORY` (`index.ts:489,492,508`), `DUPLICATE_DIRECTORY` (`index.ts:496`), `INVALID_DISCOVERY`/`DUPLICATE_DISCOVERY`/`NO_DISCOVERY` (`index.ts:557,560,587`), `INVALID_CATALOG` (`index.ts:689`), `INVALID_MODEL_INFO`/`INVALID_MODEL_CONTEXT`/`INVALID_MODEL_MAX_TOKENS`/`INVALID_MODEL_REASONING` (`index.ts:747,754,764,781/796/808`), `UNSUPPORTED_REASONING_EFFORT` (`index.ts:859,868`), `INVALID_PREPARED_CALL` (`index.ts:918,921,988`).
- Credential: `INVALID_CREDENTIAL` (`error.ts:48`, constant `INVALID_CREDENTIAL_CODE`, used in `assertUsableApiKey`, `index.ts:153`), `MISSING_CREDENTIAL` (thrown by both adapters' plugins, e.g. `packages/llm/llm-deepseek/src/index.ts:449`).
- Transport/provider (canonical, cross-provider): `AUTH`, `INVALID_REQUEST`, `RATE_LIMIT`, `SERVER`, `HTTP_<status>`, `QUOTA` (`QUOTA_EXCEEDED_CODE`, `error.ts:28`), `CONTEXT_WINDOW_EXCEEDED` (`CONTEXT_WINDOW_EXCEEDED_CODE`, `error.ts:25`) — all produced by DeepSeek's `httpErrorCode()` (`packages/llm/llm-deepseek/src/adapter.ts:332-344`), which pattern-matches provider error text via `isContextWindowExceededError`/`isQuotaExceededError` (`error.ts:80-100`, regex-based text sniffing of provider `code`/`type`/`message`).
- `EMPTY_RESPONSE` (`EMPTY_RESPONSE_CODE`, `error.ts:39`) — DeepSeek's `translate()` emits this as an `error` finish when a `stop` completion produced zero blocks (`packages/llm/llm-deepseek/src/translate.ts:117-126`); explicitly noted as "safe to repeat" for retry purposes (comment, `error.ts:37`) and is in the default `retryableCodes` set (`retry-policy.ts:18-24`).
- Adapter transport-local: `TRANSPORT`, `ABORTED`, `TIMEOUT` (`STREAM_IDLE_TIMEOUT_CODE`), `MALFORMED_RESPONSE`, `STREAM_CLOSED`, `UNSUPPORTED_CONTENT`, `INVALID_REQUEST`, `REQUEST_EXTENSION` (all in `packages/llm/llm-deepseek/src/adapter.ts` / `translate.ts` / `serialize.ts`).
- Generic fallback: `UNKNOWN` — assigned by `normalizeLlmFailure` (`packages/llm/llm/src/adapter-failure.ts:16-28`) when a thrown value is not an `Error` at all, or when it's a foreign `Error` whose own `code`/`failure` data can't be trusted (`harnessErrorCode`, lines 101-104: "Trust only Harness-owned codes; third-party SDK codes are not our taxonomy").

**Failure normalization at the adapter boundary.** `normalizeLlmFailure` (`packages/llm/llm/src/adapter-failure.ts`) is the single point that converts *any* thrown value from `LlmAdapter.prepareCall`/`stream`/iteration into a serializable `LlmFailure`, called from `adapterFailureChunk` (`packages/llm/llm/src/index.ts:1069-1077`), which is itself the only place a caught adapter exception becomes a terminal `StreamChunk` (`type:'finish', reason:{kind: signal-aborted-or-ABORTED-code ? 'aborted':'error', failure}`). It defends against hostile/cross-realm error objects: reads `error.code`/`error.failure` only via `Object.getOwnPropertyDescriptor` (never invoking a getter that could throw or lie), and only trusts a carried `failure` snapshot when its `code` field agrees with the error's own `code` (`ownFailureSnapshot`/`failureSnapshot`, lines 40-88).

---

## 6. `retryPolicy` — who actually retries?

**Type** — `packages/llm/llm/src/retry-policy.ts`:
```ts
export interface NormalRetryPolicyConfig { mode: 'normal'; maxRetries?: number; retryableCodes?: string[]; backoff?: BackoffConfig }
export interface AlwaysRetryPolicyConfig { mode: 'always'; backoff?: BackoffConfig }
export type RetryPolicyConfig = NormalRetryPolicyConfig | AlwaysRetryPolicyConfig
export type ResolvedRetryPolicy = ResolvedNormalRetryPolicy | ResolvedAlwaysRetryPolicy // both extend {initialDelayMs, maxDelayMs, jitterRatio}
```
Defaults: `maxRetries = 5`, `initialDelayMs = 500`, `maxDelayMs = 10_000`, `jitterRatio = 0.1`, `retryableCodes = [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]` (lines 14-24). `resolveRetryPolicy(config, path)` validates and fully defaults a provider's configured (or absent) policy into an immutable `ResolvedRetryPolicy`, captured once at adapter-registration time (§2).

**The policy itself performs no I/O and schedules nothing** — it's pure configuration data. The mechanism that *reads* it and actually retries is entirely outside `packages/llm/llm`:

1. `packages/core/agent-loop/src/agent.ts:390-407` — on `finish.kind === 'error' | 'aborted'`, the loop dispatches a **waterfall**: `this.dispatch.waterfall('agent/request-error', { turn, step, provider: request.provider, failure: finish.failure, retryPolicy: preparedCall?.retryPolicy, signal }, () => Promise.resolve<RequestErrorAction>(undefined))`. If the resolved `action?.kind !== 'retry'`, it throws `new LlmError(finish.failure.message, finish.failure.code, finish.failure)` and the step ends in failure. If `action.kind === 'retry'`, it `continue`s the `while(true)` loop and rebuilds/re-sends the request. **The loop itself contains no retry/backoff logic** — it only defines the terminal fallback (`undefined` ⇒ no retry) and the retry mechanics live entirely behind whatever answers the waterfall.
2. The event and its default are declared in `packages/core/agent/src/runtime-types.ts:267` → `'agent/request-error'(this: Scoped<Agent>, payload: {agent, turn, step, provider, failure: LlmFailure, retryPolicy: ResolvedRetryPolicy | undefined, signal}, next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction>` — doc comment confirms "The default `undefined` leaves the failure terminal" (line 255-256). `RequestErrorAction = { kind: 'retry' } | undefined` (`runtime-types.ts:66`).
3. **Who registers a listener:** `packages/llm/llm-retry/src/index.ts:243-252` → `const disposeListener = ctx.on('agent/request-error', (payload, next) => { if (lifetime.signal.aborted) return Promise.resolve(undefined); return track(recover(payload, next)) })`. This *is* the (only, as far as this investigation found) listener that can turn a request failure into `{kind: 'retry'}`.
   - `recover()` (lines 194-241): if `policy === undefined`, delegates immediately (`next()`) — i.e. a request whose `preparedCall` was `undefined` (e.g. `NO_ADAPTER` fallback path in `buildRequest`) gets **no retry policy at all** and this plugin does nothing.
   - `mode: 'always'`: awaits `next()` first (so other/later-registered listeners on the same waterfall run first — "delegate before retrying"), and only converts to `{kind:'retry'}` if `next()` didn't already resolve to a retry and the failure wasn't already handled downstream — actually re-reading: it awaits downstream via `settleDownstream(next)` and returns `downstream.decision` only if it's a `retry`; otherwise unbounded-retries by falling through to `backoff(...)` unconditionally below (re-check: for `always` mode, once downstream doesn't retry, execution reaches `const policyKey = ...` below the `if/else if` block and proceeds into the same shared retry-count/backoff logic as `normal` mode, since `always` has no `retryableCodes` gate).
   - `mode: 'normal'`: gates on `policy.retryableCodes.includes(failure.code)`, else `next()` (delegate without retrying).
   - Retry counting is **session-durable**, not in-memory: `ctx.sessionProjections.stateOf(agent.session, 'llmRetry')` (line 220) reads a projection folded from `llm/retry` session events (registered at lines 125-138 — `stateVersion: 1`, keyed by `[provider, policyKey]`, cleared on `step/start`/`turn/end`). Each retry appends `agent.session.append('llm/retry', eventData)` **before** the (cancellable) delay, then `agent.session.append('llm/retry-started', ...)` once the delay actually elapses and returns `{kind:'retry'}` (`backoff()`, lines 149-192) — comment: "Each scheduled retry is durable before its cancellable wait" (line 3).
   - Delay: `providerRetryAfterMs` honored when present and `<= policy.maxDelayMs` (else falls back to local exponential backoff for `normal` mode, or still uses local backoff for `always` mode) — `localDelay()` (lines 59-64) is bounded exponential (`initialDelayMs * 2^min(retry-1,1024)`, capped at `maxDelayMs`) with symmetric jitter.
   - `maxRetries` is enforced only for `mode: 'normal'` (`if (policy.mode === 'normal' && previousRetry >= policy.maxRetries) return next()`, line 223); `always` mode retries indefinitely until abort/disposal.
   - Plugin lifetime: `ctx.effect` disposer aborts an internal `AbortController` and awaits all in-flight `recover()` promises to settle before finishing disposal (lines 254-258) — so an unmount does not leave a dangling retry).

**Is `llm-retry` actually wired into the shipped app?** Yes: `packages/bundle/base/cordis.patch.yml:84-85` →
```yaml
- id: llm-retry
  name: '@deepseek-ai/dsh-llm-retry'
```
in the `dsh-base` bundle, which (per `packages/bundle/README.md`) the server applies to every profile, and `apps/server` is the sole application (per `AGENTS.md` — "There is exactly one application entry, `apps/server`, and it boots the fixed `web` profile"). So in the actual product, **something does register the `agent/request-error` waterfall listener** — it is not orphaned. But (see §7) whether the retry policy this listener reads is ever non-`undefined` depends entirely on whether an adapter route was actually registered (`preparedCall !== undefined`), which in the shipped Web app is not automatic — see next section.

---

## 7. Concrete providers, default provider, wire format, token counting

**Providers that exist in this codebase:**
1. **DeepSeek (native, direct-fetch)** — `packages/llm/llm-deepseek` (`@deepseek-ai/dsh-llm-deepseek`), `class deepseekAdapter extends LlmAdapter` (`packages/llm/llm-deepseek/src/adapter.ts:353`). Registers the single fixed provider route id `deepseek-official` (`const PROVIDER = 'deepseek-official'`, `packages/llm/llm-deepseek/src/index.ts:90`), display name `'Lynx'` (`adapter.ts:361-363`). Wire protocol: hand-rolled `fetch` + SSE against an OpenAI-compatible `POST {baseURL}/chat/completions` (`packages/llm/llm-deepseek/src/adapter.ts:643-648`).
2. **pi-ai (generic multi-provider)** — `packages/llm/llm-pi-ai` (`@deepseek-ai/dsh-llm-pi-ai`), `class PiAiAdapter` (referenced, not fully read in this pass) wrapping the `@earendil-works/pi-ai` library. Config is a `providers` dict keyed by arbitrary route names (`packages/llm/llm-pi-ai/src/config.ts:216-223`); it can shadow an installed pi-ai catalog provider (openai/anthropic/etc.) or declare a route pi-ai ships nothing about at all. Mounts **dormant** — zero registered routes — until a settings section supplies at least one profile (`ensureRegistrationFacts`, `packages/llm/llm-pi-ai/src/index.ts:271-294`: `if (routes.length === 0) { registeredFacts = facts; return }` — no `ctx.llm.registerAdapter` call at all while the profile dict is empty).

**Which one "runs by default" — this is more nuanced than a single name, and is load-bearing enough to spell out precisely:**
- The agent default route is `provider: 'deepseek-official', model: 'deepseek-v4-flash'`, set by the `agent-default-model` plugin row in the base bundle: `packages/bundle/base/cordis.patch.yml:73-79`.
- The base bundle *does* mount `llm-deepseek` (as `id: llm-deepseek`, `packages/bundle/base/cordis.patch.yml:500-501`), which would normally register that exact route.
- **However**, the web-app bundle patch — which `apps/server` (the only application) applies on top of the base bundle — explicitly disables that same row: `packages/bundle/web-app/cordis.patch.yml:41-42`:
  ```yaml
  - id: llm-deepseek
    disabled: true
  ```
  with the accompanying comment "The Web surface exposes only providers declared through the Models settings document. Other profiles can still compose the bundled native adapter." A `disabled: true` Cordis entry's `apply()` never runs (confirmed by `docs/cordis-primer.md:37`: Loader evaluates `disabled` "at every mount decision," and a disabled entry is excluded from mounting — I did not re-derive Cordis's loader internals beyond this primer statement, so treat the *mechanism* as **INFERRED from the primer doc**, but the *literal YAML fact* that this row is disabled in the web-app patch is directly read code/config).
- **Net effect (INFERRED, but tightly grounded):** in the actual shipped `apps/server` "web" profile, with no user configuration at all, `llm-deepseek`'s `apply()` (which is what calls `ctx.llm.registerAdapter(['deepseek-official'], adapter)`, `packages/llm/llm-deepseek/src/index.ts:476`) never runs, and `llm-pi-ai` (mounted, not disabled) registers zero routes because its `providers` config defaults to `{}` (`packages/llm/llm-pi-ai/src/config.ts:340-342`, `z.object({ providers: z.dict(profile).default({}) })`). So **no LLM provider route is registered at all** until the user goes through the web "Models" settings UI (out of `packages/llm/**` scope — I did not trace the host/client code that flips this; `packages/host/plugin-inventory/src/index.ts:73` shows a `enabled: !entry.disabled` field surfaced to the UI, and `packages/client/ui-settings-models/src/client/DeepSeekOnboardingDialog.tsx` is a first-run "official DeepSeek" onboarding step, both suggesting the Web GUI can re-enable the disabled row and/or write a `llm-deepseek:`/`llm-pi-ai:` settings section — **UNKNOWN, not verified**: exactly how a disabled Cordis row gets re-enabled by user action at runtime).
- Until a provider is configured, any agent request resolves `preparedCall` to `undefined` via the `NO_ADAPTER` catch in `buildRequest` (`packages/core/agent-loop/src/agent.ts:491-495`), then `this.loopCtx.llm.stream(request)` (fallback path) hits `adapterStream`'s own `this.registration(options.provider)` call (`packages/llm/llm/src/index.ts:970`), which throws `NO_ADAPTER` again, caught by the `adapterFailureChunk` wrapper (line 1005-1008) and turned into a terminal `error` finish chunk — which then reaches `agent/request-error` with `retryPolicy: undefined` (since `preparedCall` was undefined), and `llm-retry`'s `recover()` immediately delegates (`if (policy === undefined) return next()`, line 198) with no other listener registered, so the loop throws `LlmError('no adapter registered...', 'NO_ADAPTER')` and the turn fails. **This means: out of the box, a fresh install of this harness cannot complete a single model call until a user configures a provider through Settings.** This is a genuinely surprising, non-obvious finding worth flagging prominently in the book, not dead code but an intentional "advertise text-only route, but nothing live" bootstrapping posture per the DeepSeek plugin's own comment (`packages/llm/llm-deepseek/src/index.ts:96-108`: "mounted dormant... until a `llm-pi-ai:` settings section supplies provider profiles").

**Wire format (DeepSeek).** OpenAI-compatible chat-completions, always streamed (`stream: true, stream_options: {include_usage: true}`, `packages/llm/llm-deepseek/src/serialize.ts:357-361`). Full request type `WireRequest` (`packages/llm/llm-deepseek/src/types.ts:13-30`): `{model, messages, stream: true, stream_options, thinking?: {type:'enabled'|'disabled'}, reasoning_effort?: 'low'|'high'|'max', tools?, temperature?, max_tokens?, stop?}`. Note `thinking` is "top level, NOT inside extra_body" (comment, line 18) — a DeepSeek-specific dialect quirk. Assistant history replays `content: ""` (never `null`) on tool-call-only turns, and `reasoning_content` (CoT passback) is resent "on every reasoning-carrying turn" per an "official rule" comment (`packages/llm/llm-deepseek/src/serialize.ts:217-236`) — **this specific claim ("official rule ... guides/thinking_mode.mdx") is an unverifiable external-doc citation inside a comment; I did not independently verify DeepSeek's actual API contract, only that the code implements exactly this behavior.** SSE response chunks (`WireChunk`, `types.ts:119-176`) follow the standard `chat.completion.chunk` shape (`choices[].delta.{content,reasoning_content,tool_calls[]}`, `choices[].finish_reason`, trailing `usage`), consumed by `parseSse` (not read in this pass) and mapped by `translate()` (§4/§5 above) into the harness's provider-neutral `StreamChunk` protocol. `mapFinishReason` (`translate.ts:32-44`) maps `stop→stop`, `tool_calls→tool-calls`, `length→max-tokens`, anything else (e.g. `content_filter`) → `{kind:'error', failure:{code: reason.toUpperCase()}}`. `mapUsage` (`translate.ts:55-72`) explicitly documents that DeepSeek's `prompt_tokens` **includes** cache hits, so cache reads are subtracted to produce the harness's disjoint `inputTokens` convention.

**Context-window / token-counting mechanism.** Two independent things exist:
1. **Context window (capacity) metadata** — `LlmModelContext { contextWindow: number }` (`packages/llm/llm/src/types.ts:298-302`), resolved per exact model by the adapter (`LlmResolvedModelInfo.context`) and validated by `LlmRuntime.normalizeModelInfo` (must be a positive integer, else `INVALID_MODEL_CONTEXT`). DeepSeek's adapter sources this from the catalog model's configured `contextWindow` or else `connection.defaultContextWindow` (default `1_000_000`, `DEFAULT_CONTEXT_WINDOW`, `packages/llm/llm-deepseek/src/adapter.ts:140`). This value flows to `PreparedLlmCall.context.contextWindow` and thence into a `request/context` session event (`packages/core/agent-loop/src/agent.ts:521-532`) — but it is **not itself a token counter**; it's a capacity fact used elsewhere (context-pressure UI, compaction triggers) for comparison against an *estimated* usage.
2. **Token counting/estimation** — lives in `packages/llm/token-meter` (not `packages/llm/llm` proper, but same package group). `TokenMeter.measure()` (`packages/llm/token-meter/src/index.ts:133-177`) prefers **real provider-reported usage** (`TokenUsage` from the `usage` `StreamChunk`, carried on the `assistant/message` session event) when available and "no lower than" a full heuristic re-price of the same anchor point (`baseline = usage !== undefined && usageTokens(usage) >= estimatedAnchorTokens ? {kind:'usage',...} : {kind:'estimated',...}`, lines 154-156). When no usage is available (e.g. before any successful call, or a provider that doesn't report it), it falls back to a **fixed-density heuristic**: `CHARS_PER_TOKEN = 4`, `BLOCK_OVERHEAD = 4`, `ROLE_OVERHEAD = 4` (`packages/llm/token-meter/src/estimate.ts:13-19`) — i.e. `Math.ceil(text.length / 4) + 4` per text/reasoning block, JSON-stringify-length/4 for structural/image blocks (`estimateStructuralBlock`, lines 28-30). **This is not a real tokenizer** (no BPE/vocabulary lookup anywhere in this package) — it is an approximation used only until/unless exact provider usage is known. This directly answers "is there a context-window/token-counting mechanism": yes, but it is a capacity fact (adapter-declared, static per model) crossed with a **character-count heuristic estimator**, reconciled against real provider `usage` counts when they exist — there is no client-side exact tokenizer for pre-flight sizing.

---

## 8. `markAgentLoopRequest`

`packages/llm/llm/src/call-config.ts:66-78`:
```ts
const AGENT_LOOP_REQUESTS = new WeakSet<GenerateOptions>()

export function markAgentLoopRequest<T extends GenerateOptions>(request: T): T {
  AGENT_LOOP_REQUESTS.add(request)
  return request
}

export function isAgentLoopRequest(request: GenerateOptions): boolean {
  return AGENT_LOOP_REQUESTS.has(request)
}
```
It is a **process-local identity tag** (a `WeakSet`, not a serialized field) that marks the *exact object* a `GenerateOptions` request is, not its content. Purpose per the module doc comment (`call-config.ts:1-7`) and the `llm/stream` waterfall's JSDoc (`packages/llm/llm/src/index.ts:59-64`): a request built by `dsh-agent-loop` is guaranteed to be `deepFreeze`d and "a pure function of the session log" (the "Model-visible ⟺ logged" invariant asserted in `AGENTS.md:56`), so waterfall listeners on `llm/stream` may read such a request but must never attempt to rewrite it — whereas a hand-built one-shot request (e.g. compaction's own auxiliary call, or a plugin issuing an ad hoc completion) carries no such guarantee and the marker lets a listener distinguish the two cases programmatically via `isAgentLoopRequest(request)`. It is applied exactly once, at the end of `buildRequest`: `packages/core/agent-loop/src/agent.ts:535-542` → `const request = markAgentLoopRequest(deepFreeze({...header.config, messages: boundaryMessages, ..., sessionId: this.session.id, signal}))`. **I did not find any `llm/stream` listener in `packages/llm/**` itself that calls `isAgentLoopRequest`** — the predicate is exported (`packages/llm/llm/src/index.ts:46`) for consumers elsewhere in the tree; I did not exhaustively search outside `packages/llm` and `packages/core/agent-loop` for callers, so whether any plugin actually branches on it is **UNKNOWN — checked the exporting/producing sites only, would need a repo-wide grep of `isAgentLoopRequest(` across all `packages/*` to confirm or deny consumers.**

---

## Cross-cutting notes / flags

- **`markAgentLoopRequest`'s WeakSet is process-local and non-persistent** — it cannot survive a process restart or cross a worker boundary; this is consistent with it being an in-memory provenance tag rather than a protocol field, but is worth stating plainly since a reader might otherwise assume it's part of the wire/session-log format (it is not — it never appears in `GenerateOptions`'s own type, `packages/llm/llm/src/types.ts:393-429`).
- **`resolveCallConfig()`** (`packages/llm/llm/src/index.ts:832-834`) is a *standalone* variant of the capability-resolution half of `prepareCall` that does **not** bind a later dispatch ("does not bind a later dispatch; use `prepareCall` when logging and streaming must share one adapter registration," doc comment lines 826-828) — I did not find a caller of this method within `packages/llm/**` or `packages/core/agent-loop`; likely used by a settings/UI surface to preview resolved defaults without committing to a stream. **UNKNOWN — not traced further**, out of the requested scope.
- **`deepseek-llm-api-extensions`** (`packages/llm/deepseek-llm-api-extensions`) is a small plugin-extensible registry that lets other plugins contribute additional top-level JSON fields to the DeepSeek wire request via a prepare/accept two-phase transaction (`packages/llm/deepseek-llm-api-extensions/src/index.ts`); the DeepSeek adapter calls `this.config.prepareExtensions(...)` once per request attempt and merges `extensions.fields` onto the serialized body, rejecting on any field-name collision (`packages/llm/llm-deepseek/src/adapter.ts:619-634`). No extension provider was located in this pass — whether anything in the shipped bundle actually registers one is **UNKNOWN — not searched**.
- **`llm-retry`'s "always" mode branch is easy to misread.** On close reading (`packages/llm/llm-retry/src/index.ts:199-213`), `mode: 'always'` first awaits the *downstream* waterfall continuation (`next()`) and only short-circuits into a retry if `next()` itself resolved to `{kind:'retry'}`; otherwise it falls through into the same numbered backoff/session-append logic used by `normal` mode (there is no `return` between the `if (policy.mode === 'always') {...}` block and the shared `const policyKey = ...` section for the case where downstream did *not* retry) — meaning `always` mode still retries indefinitely by itself, it just gives any other listener registered "ahead of" it in the waterfall a chance to claim the retry first. This is subtle enough that I recommend the book quote the exact lines rather than paraphrase.
- **Coverage caveat:** `packages/llm/llm-pi-ai/src/adapter.ts` (the `PiAiAdapter` class implementation, its wire translation, and its replay-state handling) was **not read in this pass** — everything stated about pi-ai above is from `index.ts` (plugin wiring) and `config.ts` (schema/profile resolution) only. A book chapter wanting pi-ai wire-format parity with the DeepSeek section (§7) needs a follow-up pass over `adapter.ts`, `context.ts`, `stream.ts`, `discovery.ts`, `catalog.ts`, `provider.ts` in that package.
- **`llm-retry`'s registration in the base bundle was confirmed by direct file read** (`packages/bundle/base/cordis.patch.yml:84-85`), not inferred from its own package README — satisfying the "who actually retries" question with actual composition evidence rather than trusting the package's self-description.
