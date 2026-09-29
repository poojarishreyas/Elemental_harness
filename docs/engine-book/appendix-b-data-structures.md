# Appendix B · Data-structure reference

Every core type, its fields, and where it is defined. Paths are repo-relative.

---

## Session layer — `packages/core/session/src/`

### `SessionEvent<T>` · `types.ts:391-398`

| Field | Type | Notes |
|---|---|---|
| `seq` | `number` | Zero-based log index; assigned only at `index.ts:627` |
| `time` | `number` | Epoch ms |
| `type` | `T` | Key of `SessionEventMap` |
| `data` | `SessionEventMap[T]` | Deep-snapshotted, frozen |
| `ignorable?` | `true` | Reader may skip if the type is unrecognized (`types.ts:399-409`) |
| `surfaceOp?` | `SurfaceOp` | Surface-eligible types only |
| `sourceEventSeqs?` | `number[]` | Surface-eligible types only (`types.ts:410-422`) |

### `SessionEventMap` (core entries) · `types.ts:216-320`

| Type | Payload |
|---|---|
| `turn/start` | `{ turn }` |
| `turn/end` | `{ turn, reason: TurnEndReason }` |
| `step/start` / `step/end` | `{ turn, step }` |
| `user/message` | `UserMessage` — the data **is** the message |
| `assistant/chunk` | `{ turn, step, chunk: StreamChunk }` |
| `assistant/message` | `{ turn, step, message, usage?, interrupted? }` |
| `tool/call` | `{ turn, step, callId, name, arguments }` |
| `tool/result` | `{ turn, step, message, error?, meta? }` |
| `request/header` | `{ header: EpochHeader, reason, startsSeries? }` |
| `request/context` | `RequestContext` |
| `session/end-seed` | `Record<string, never>` |

Merge-extensible; the complete build-wide set is generated into `known-event-types.ts:22-74` (~50 types).

### `SessionHeader` · `types.ts:56-94`

`version` · `id` · `createdAt` · `cwd?` · `parentSession?` · `seedLength?` · `origin?` · `delegationDepth?` · `agentPreset?`

Kept **out** of the event log. Deep-frozen at construction.

### `TurnEndReason` · `types.ts:150-169`

`completed` · `max-tokens` · `blocked` · `aborted{reason}` · `error{error: LlmFailure}` · `interrupted` (written only by crash repair)

### `SurfaceOp` · `types.ts:359-361`

```ts
'append' | { op: 'replace'; start: number; end: number }
```

`start`/`end` name **surface nodes by seq**, not log positions.

### `SessionSurface` · `surface.ts:137-142`

`nodes: readonly number[]` · `replaceGeneration: number`

### `EpochHeader` · `types.ts:179-188`

`config: LlmCallConfig` · `adapterDefaults?` · `system?` · `tools?: ToolSchema[]`

### `ChunkRow` · `chunk-rows.ts:66-69`

```ts
{ type: 'text-chunks' | 'reasoning-chunks' | 'tool-call-chunks'
  seq0: number; time0: number; data: { turn, step, index, dt: number[], texts|args: string[], id?, name? } }
```

**Not a session event.** A storage encoding, expanded before anything above persistence sees it.

### Constants

| Name | Value | Where |
|---|---|---|
| `SESSION_FORMAT_VERSION` | `0` | `types.ts:51` |
| `MIN_RUN` | `3` | `chunk-rows.ts:99` |
| `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` | — | `repair.ts:14,17` |

---

## LLM layer — `packages/llm/llm/src/`

### `Message` · `message.ts:131-140`

`id: MessageId` · `role: 'system'|'user'|'assistant'` · `content: ContentBlock[]` · `source: MessageSource`

Specializations: `UserMessage`, `AssistantMessage` (`source: ModelMessageSource`), `ToolResultMessage` (`role: 'user'`, one `ToolResultBlock`).

### `MessageSource` · `message.ts:102-107`

`{kind:'user'}` · `{kind:'plugin', plugin} & ContextFormed` · `{kind:'model', provider, model, replayState?}` · `{kind:'tool', callId}`

### `ContentBlock` · `types.ts:54-110`

| Type | Shape |
|---|---|
| `text` | `{ type, text }` |
| `reasoning` | `{ type, text }` |
| `image` | `{ type, attachment }` |
| `tool-call` | `{ type, id, name, arguments }` — arguments are a **raw JSON string** |
| `tool-result` | `{ type, toolCallId, content, isError? }` |

### `StreamChunk` · `types.ts:364-376`

`block-start{index, blockType}` · `text-delta{index, text}` · `reasoning-delta{index, text}` · `tool-call-delta{index, id, name?, argumentsDelta}` · `block-end{index, block}` · `usage{usage}` · `finish{reason, replayState?}`

### `FinishReason` · `types.ts:116-125`

`stop` · `tool-calls` · `max-tokens` · `aborted{failure}` · `error{failure}`

### `GenerateOptions` · `types.ts:393-429`

`provider` · `model` · `reasoningEffort?` · `messages` · `system?` · `tools?` · `temperature?` · `maxTokens?` · `stop?` · `signal?` · `sessionId?` · `purpose?`

### `LlmCallConfig` · `call-config.ts:23-30`

`provider` · `model` · `reasoningEffort?` · `temperature?` · `maxTokens?` · `stop?`

> Carries a file-level `TODO(call-config-shape)` — the shape is explicitly unsettled ([Ch 35](35-limits-and-fragile-areas.md)).

### `LlmCallConfigAdapterDefaults` · `call-config.ts:36-39`

`reasoningEffort?: true` · `maxTokens?: true`

### `LlmFailure` · `types.ts:40-51`

`message` · `code` · `status?` · `providerRetryAfterMs?` · `requestId?`

### `PreparedLlmCall` · `index.ts:157-177`

`config` · `retryPolicy` · `context?: {contextWindow}` · `inputModalities?` · `adapterDefaults` · `stream(options)`

Frozen; `stream` is single-use and config-checked.

### `ToolSchema` · `types.ts:385-390`

`name` · `description` · `parameters` (JSON Schema)

---

## Tools layer — `packages/core/tools/src/`

### `ToolDefinition` · `index.ts:214-280`

Extends `ToolSchema`, plus: `output` · `execute` · `finalizeContent?` · `timeoutMs?` · `isConcurrencySafe?` · `presentCall?` · `presentResult?`

### `ToolOutputDefinition` · `index.ts:204-211`

`schema` · `render(args, value)` · `presentationMeta?(args, value)`

### `ToolExecutionInput` · `index.ts:307-331`

`callId` · `rootCallId?` · `name` · `arguments` · `agent?` · `parent?` · `signal`

### `ToolRunContext` · `index.ts:397-414`

Extends `ToolExecution` (which adds `rootCallId` and an opaque `token`), plus `deferContext(message)` and `concludeTurn()`.

### `ToolExecutionResult` · `index.ts:549-573`

```ts
{ isError: false; value: JsonValue; content; meta?; additionalContexts?; concludesTurn? }
{ isError: true;  error: ToolFailure; content; meta?; additionalContexts? }
```

**`value` is never persisted.** `concludesTurn` is typed `never` on failures.

### `PreToolDecision` / `ScheduledToolPreparation` · `index.ts:576-584`, `:428-437`

`{kind:'allow'} | {kind:'deny', reason} | {kind:'ask', reason?}`
`{kind:'dispatch', exec} | {kind:'post-result', result} | {kind:'final-result', result}`

### Constants

`TOOL_ABORTED = 'ABORTED'` (`:462`) · `TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'` (`:465`) · `TOOL_RUNTIME_SCHEDULER` (`:459`) · `DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10` (`agent-loop/src/constants.ts:6`)

---

## Prompt layer — `packages/core/system-prompt/src/`

### `PromptAssembly` · `index.ts:114-119`

`sections: AssembledSection[]` · `contexts: AssembledContext[]` · `tools: ToolSchema[]` · `variables: Record<string, string|undefined>`

Text is **uninterpolated** at this stage.

### `PromptSection` / `PromptContext` · `index.ts:53-74`, `:77-84`

`{ name, order, text, complete? }` / `{ name, order, text }`

### Order constants · `index.ts:121-161`

`SECTION_ORDERS` — `HARNESS_IDENTITY: -1000` … `STRUCTURED_OUTPUT: 9900`
`CONTEXT_ORDERS` — `SANDBOX_POLICY: 110`, `APPROVAL_POLICY: 115`, `SUBAGENT_DELEGATION: 120`

---

## Agent layer — `packages/core/agent/src/` and `agent-loop/src/`

### `Phase` · `agent-loop/src/agent.ts:39-47`

```ts
{ kind: 'idle'; lastTurn }
{ kind: 'maintenance'; abort; lastTurn; wakeRequested }
{ kind: 'running'; abort; turn; step; wakeRequested }
```

### `InboxTarget` · `agent/src/types.ts:29`

`'next-turn' | 'next-step'`

### `PreStepDecision` / `RequestErrorAction` · `runtime-types.ts`

`{kind:'reject'} | {kind:'enter', messages, startsRequestSeries?}` · `{kind:'retry'} | undefined`

### `ProjectionDefinition` · `session-projection/src/index.ts:42-86`

`key` · `stateSchema` · `init(header)` · `apply(state, event)` · `wire?` · `stateVersion`

### `TurnBoundaryProjection` · `agent-loop/src/index.ts:55-93`

`openTurnStartSeq` · `lastStepStartSeq` · `lastStepBoundary` · `lastTurn` — `stateVersion: 2`
