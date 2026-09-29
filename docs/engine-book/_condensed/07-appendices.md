# Appendices

## A · Glossary

**adapter** — knows how to talk to one or more providers; only `stream()` is required. Retry policy captured at registration. §23
**`adapterDefaults`** — record of which config fields the *adapter* supplied, so the next request strips and re-resolves them. §10, §23
**agent plane** — what *one agent* contributes: tools, prompt sections, delegation backends. Mounted per preset. §34
**barrier** — an exclusive tool call that runs alone. §17
**canonical result** — already validated and rendered through its tool's output contract; re-normalizing is a no-op. §16
**compaction transaction** — `compaction/start` … `compaction/end`; the start event *is* the lock, so it survives a crash. §27
**Cordis** — the vendored plugin/DI framework. Context · Service · Fiber · Effect. §2, §34
**context sections** — prompt contributions that become a runtime-context *message* rather than system-prompt text, because they change mid-session. Three producers exist. §19, §21
**durable-first** — commit to the log *before* mutating memory, so observers see the pre-change state and it survives a crash. §12
**effect** — `ctx.effect(fn, label)`; every registration in the codebase is one. §2, §36
**fiber** — one plugin instance; `PENDING` until every `inject` resolves; unloads when one disappears. §2
**host plane** — mounted once, visible everywhere: registries, sandbox/approval, persistence, model routes. §34
**inbox** — two queues (`next-turn`, `next-step`) reconstructed by replaying `agent/inbox/spliced`. §12
**invariant companion** — a package-shipped runtime check of a relationship it owns; ~30 exist, the registry runs nowhere. §11
**isolate realm** — remaps which symbol a service name resolves to for one subtree. Visibility is the default; a realm narrows. §34
**maintenance** — a phase where the agent holds still but reports `idle`. §13
**`markAgentLoopRequest`** — process-local `WeakSet` tag marking a request loop-built vs one-shot; never serialized. §10
**phase** — `idle` · `maintenance` · `running`, collapsing to two external statuses. §13
**prepared call** — frozen, single-use, config-checked, pinned to the adapter generation. §23
**preset** — a named agent-plane composition, mounted once per (id, file generation), joined by one `WeakMap` entry. §34
**profile** — not a file: an empty root config plus an ordered patch stack. §2, §34
**projection** — a registered, versioned, pure fold over the log. §8
**`PromptAssembly`** — resolved but uninterpolated sections/contexts/tools/variables. §19
**prompt variable** — `(context) => string | undefined`, evaluated once per assembly, substituted at render. The engine registers `provider`, `model`, `cwd`. §20
**PTC / `run_code`** — a tool-presentation mode where the model writes a program that calls tools. Behind `DSH_TOOLS_MODE`; default `native`. §15, §16
**request header** — the non-message half of a request; logged only on change, four reasons. §10
**`replaceGeneration`** — bumped once per committed replace; the system's "history was rewritten" signal, read by four mechanisms. §6
**`seq`** — an event's index in the log. Assigned in one place, verified in four. §5
**`SessionPreparation`** — `Disposable` wrapper around one *unpublished* session. §29
**snapshot message** — the synthetic runtime-context `user/message`, injected only when its text changed. §21
**spill** — writing an oversized plain-text tool result out of line at execution time. §26
**step** — one model request within a turn. §9
**surface** — the ordered list of log positions the model currently sees. §6
**`surfaceOp`** — mandatory on surface-eligible events: `'append'` or `{op:'replace', start, end}`. §6
**subagent** — a genuine nested `Agent` from the same factory; `spawn` empty, `fork` seeded. §28
**token meter** — real provider usage preferred, else 4-chars-per-token heuristic. Not a tokenizer. §26
**turn** — one unit of conversation. **turn ending** — `completed` · `max-tokens` · `blocked` · `aborted` · `error` · `interrupted`. §9
**waterfall** — nested continuations; a listener returning without calling `next()` vetoes everything after it *including the default*. §22
**wake latch** — a deferred wake replayed at convergence, never during disposal. §13

## B · Data-structure reference

**`SessionEvent<T>`** `types.ts:391-398` — `seq` · `time` · `type` · `data` · `ignorable?` · `surfaceOp?` · `sourceEventSeqs?`
**`SessionHeader`** `:56-94` — `version` · `id` · `createdAt` · `cwd?` · `parentSession?` · `seedLength?` · `origin?` · `delegationDepth?` · `agentPreset?` — kept **out** of the log
**`SurfaceOp`** `:359-361` — `'append' | {op:'replace', start, end}` (start/end name **surface nodes by seq**)
**`SessionSurface`** `surface.ts:137-142` — `nodes: readonly number[]` · `replaceGeneration: number`
**`EpochHeader`** `:179-188` — `config: LlmCallConfig` · `adapterDefaults?` · `system?` · `tools?`
**`ChunkRow`** `chunk-rows.ts:66-69` — `{type: text|reasoning|tool-call -chunks, seq0, time0, data{turn,step,index,dt[],texts|args[],id?,name?}}` — **not an event**

**`Message`** `message.ts:131-140` — `id` · `role` · `content: ContentBlock[]` · `source`
**`MessageSource`** `:102-107` — `user` · `plugin{plugin}` · `model{provider,model,replayState?}` · `tool{callId}`
**`ContentBlock`** `types.ts:54-110` — `text` · `reasoning` · `image` · `tool-call{id,name,arguments}` (raw JSON string) · `tool-result{toolCallId,content,isError?}`
**`StreamChunk`** `:364-376` — `block-start` · `text-delta` · `reasoning-delta` · `tool-call-delta` · `block-end` · `usage` · `finish`
**`FinishReason`** `:116-125` — `stop` · `tool-calls` · `max-tokens` · `aborted{failure}` · `error{failure}`
**`GenerateOptions`** `:393-429` — `provider` · `model` · `reasoningEffort?` · `messages` · `system?` · `tools?` · `temperature?` · `maxTokens?` · `stop?` · `signal?` · `sessionId?` · `purpose?`
**`LlmCallConfig`** `call-config.ts:23-30` — `provider` · `model` · `reasoningEffort?` · `temperature?` · `maxTokens?` · `stop?` · ⚠️ carries `TODO(call-config-shape)`
**`LlmFailure`** `:40-51` — `message` · `code` · `status?` · `providerRetryAfterMs?` · `requestId?`
**`PreparedLlmCall`** `llm/index.ts:157-177` — `config` · `retryPolicy` · `context?{contextWindow}` · `inputModalities?` · `adapterDefaults` · `stream()` (single-use)

**`ToolDefinition`** `tools/index.ts:214-280` — `ToolSchema` + `output` · `execute` · `finalizeContent?` · `timeoutMs?` · `isConcurrencySafe?` · `presentCall?` · `presentResult?`
**`ToolExecutionInput`** `:307-331` — `callId` · `rootCallId?` · `name` · `arguments` · `agent?` · `parent?` · `signal`
**`ToolRunContext`** `:397-414` — adds `deferContext(msg)` · `concludeTurn()`
**`ToolExecutionResult`** `:549-573` — success `{isError:false, value, content, meta?, additionalContexts?, concludesTurn?}` / failure `{isError:true, error, content, meta?, additionalContexts?}`. **`value` never persisted**; `concludesTurn` typed `never` on failures
**`PreToolDecision`** `:576-584` — `allow | deny{reason} | ask{reason?}`
**`ScheduledToolPreparation`** `:428-437` — `dispatch{exec} | post-result{result} | final-result{result}`
**Constants** — `TOOL_ABORTED='ABORTED'` · `TOOL_ABORTED_BEFORE_DISPATCH='ABORTED_BEFORE_DISPATCH'` · `TOOL_RUNTIME_SCHEDULER` · `DEFAULT_MAX_PARALLEL_TOOL_CALLS=10` · `SESSION_FORMAT_VERSION=0` · `MIN_RUN=3`

**`PromptAssembly`** `system-prompt:114-119` — `sections` · `contexts` · `tools` · `variables` (uninterpolated)
**`Phase`** `agent.ts:39-47` · **`InboxTarget`** `'next-turn'|'next-step'` · **`PreStepDecision`** `reject | enter{messages, startsRequestSeries?}` · **`RequestErrorAction`** `{kind:'retry'} | undefined`
**`ProjectionDefinition`** `session-projection:42-86` — `key` · `stateSchema` · `init` · `apply` · `wire?` · `stateVersion`

## C · Configuration reference

A value reaches a session through up to three layers, last write winning per row id, with `config` **replaced wholesale**: base → web-app patch → standard preset. **For any per-agent tool, the preset's value is the live one.** Two rows where they differ: `tool-web` `fetch: false` → **`true`**; `tool-subagent-fork` `one-shot` → **`continuable`**.

| Setting | Live default | Where |
|---|---|---|
| `maxParallelToolCalls` | `10` — integer ≥1; **deployment-wide** | `constants.ts:6` |
| `agents` | `[]` | base:486-489 |
| default route | `deepseek-official` / `deepseek-v4-flash` | base:73-79 |
| `llm-deepseek` | **`disabled: true`** | web-app:41-42 |
| `llm-pi-ai` `providers` | `{}` — **zero routes** | `config.ts:340-342` |
| `defaultContextWindow` / `DEFAULT_MAX_TOKENS` (DeepSeek) | `1_000_000` / `256_000` | `adapter.ts:140,142` |
| `reasoningEffort` (DeepSeek) | `high`; `off` only when `thinking: disabled` | `adapter.ts:187-193` |
| retry `maxRetries` / delays / jitter | `5` / `500`–`10_000` ms / `0.1` | `retry-policy.ts:14-24` |
| `retryableCodes` | `EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT` | same |
| compaction `auto` / `thresholdRatio` / `retainRatio` | `true` / `0.8` / `0.16` | `config.ts:95,20,23` |
| `maxOverflowRetries` | `1` | `config.ts:93` |
| pruner `thresholdChars` / `headChars` / `tailChars` | `8192` / `4096` / `1024` | base:404-409, preset:150-155 |
| `maxInlineBytes` (spill) | `50000` — host-plane, untouched by web-app | base:393-396 |
| `cleanupPeriodDays` (spill) | `30`; `0` disables | `spill-local:68` |
| token estimate | `CHARS_PER_TOKEN=4`, `BLOCK_OVERHEAD=4`, `ROLE_OVERHEAD=4` | `estimate.ts:13-19` |
| sandbox `mode` / `workspaceRoot` | `workspace-write` / `process.cwd()` | base:217-218 |
| approval `policy` | `ask`; `never` iff `DSH_PERMISSION_MODE === 'danger-full-access'` | base:233 |
| presets | `read-only` / `workspace-write` / `danger-full-access` | base:238-247 |
| persistence `root` / compression / `packChunks` | `dshHomePath('sessions')` / `zstd` / `true` | base:110-113 |
| `session-query-sqlite` | `:memory:`, **`openAt: never`** | base:129-133 |
| projection cache | `writeEveryEvents: 200`, `writeIntervalMs: 5000` | base:162-166 |
| `subagent maxDepth` | `3`, or `'provider-managed'` | `tool-subagent:129` |
| `agent-instructions.maxBytes` | `65536` | base:274-277 |
| `tool-ralph.maxRounds` | `64` | base:422-427 |
| `repeat-tool-reminder` | `thresholds: [3,5,8]`, `argumentsPreviewChars: 500` | base:434-438 |
| `tool-web.searchTimeoutMs` | `60000` | preset:231-235 |
| `agent-presets.default` | `standard` | web-app:451-456 |
| webserver | `127.0.0.1:3080`, gzip lvl 1 above 1024 B | web-app:121-129 |

**Environment:** `DSH_PERMISSION_MODE` (sandbox mode **and** derived approval policy) · `DSH_TOOLS_MODE` (`native`\|`ptc`\|`both`; unset = `native`; **documented temporary**) · `DSH_TELEMETRY_MODE` (`FEEDBACK_ONLY` default) · `DSH_TELEMETRY_DISABLED` (**any** non-empty value, including `'0'`/`'false'`) · `DSH_TELEMETRY_OTLP_URL` · `DEEPSEEK_API_KEY` · `DSH_HOME`.

**Platform-conditional** (lazily evaluated per row, `entry.ts:100-108`): `tool-bash`/`bash-sandbox` disabled on win32; `tool-pwsh`/`pwsh-sandbox` disabled off-win32.

**Mounted but inert:** `session-query-sqlite` (never opened) · `llm-pi-ai` (zero routes) · `hmr`, `skill-badge` (`disabled` in base) · `ui-schedule` (`disabled` in web-app) · `dsh-invariants` (mounted **nowhere**).

## D · Mechanism index

| Mechanism | § | Key files |
|---|---|---|
| Append-only log | 5 | `core/session/src/index.ts:602-653` |
| Surface | 6 | `core/session/src/surface.ts` |
| Derivation | 7 | `surface.ts:83-114`, `index.ts:724-745` |
| Projections | 8 | `session/session-projection/src/index.ts` |
| Turn / step loops | 9 | `agent-loop/src/agent.ts:255-438` |
| Request construction | 10 | `agent-loop/src/agent.ts:444-544` |
| Reconstruction invariant | 11 | `agent-loop/src/invariant.ts` |
| Inbox | 12 | `core/agent/src/inbox.ts` |
| Phases / cancellation | 13 | `agent-loop/src/agent.ts:39-232` |
| Agent lifecycle | 14 | `agent-loop/src/index.ts:522-773` |
| Tool registry | 15 | `core/tools/src/index.ts:1028-1053` |
| Execution pipeline | 16 | `core/tools/src/index.ts:1450-1667` |
| Tool scheduling | 17 | `agent-loop/src/tool-calls.ts` |
| Approval / escalation | 18 | `interaction/user-approval/src/index.ts:222-309`, `sandbox/src/escalation.ts:157-189` |
| Prompt assembly | 19 | `core/system-prompt/src/index.ts:536-611` |
| Interpolation | 20 | `core/system-prompt/src/index.ts:309-346` |
| Runtime context | 21 | `agent-loop/src/runtime-context.ts` |
| Extension points | 22 | `core/agent/src/dispatch.ts`, `vendor/cordis/src/events.ts:194-243` |
| Adapters / prepareCall | 23 | `llm/llm/src/index.ts:890-935` |
| Block assembly | 24 | `llm/llm/src/assembler.ts` |
| Failures / retry | 25 | `llm/src/adapter-failure.ts`, `llm-retry/src/index.ts:194-258` |
| Metering / spill | 26 | `llm/token-meter/src/`, `spill/spill-policy/src/index.ts:110-232` |
| Pruning / compaction | 27 | `compaction-basic/src/{index,region,summarizer}.ts` |
| Subagents | 28 | `subagent-in-process-driver/src/index.ts:103-234` |
| Persistence | 29 | `session-persistence/src/coordinator.ts`, `…-jsonl/src/index.ts` |
| Crash repair / packing | 30 | `core/session/src/repair.ts:28-134`, `chunk-rows.ts` |
| Boot / patches / realms / presets | 34 | `apps/server/src/`, `vendor/include/src/index.ts:58-128`, `vendor/loader/src/config/isolate.ts`, `preset/agent-presets/src/{index,mount}.ts` |

**Extension points:** `agent/pre-step` (waterfall, **12** live) · `agent/request` (1) · `agent/request-error` (2) · `agent/turn-stopping` (serial, **0**) · `agent/status` (3) · `agent/created`/`disposed` (5/4) · `agent/inbox/*` · `agent/error` (3) · `agent/session-start` (2) · `tools/pre-execute` (**0 producing `ask`**) · `tools/execute` (timeout policy) · `tools/post-execute` (spill) · `tools/result` · `llm/stream` (invariant — not mounted) · `system-prompt/assemble` · `approval/request` · `session/event`.

---

## Evidence

Written entirely from reading the implementation, then checked by building and running the suite.

| | |
|---|---|
| `packages/core/agent-loop` | **342 / 342 pass**, 18 files |
| core + session + llm + compaction + spill | **3,373 / 3,383 pass**, 165 files |
| The 10 failures | one file, all `EPERM … symlink` — Windows blocks symlink *creation*; environmental |
| `test:snapshot` | 67 fail — POSIX fixtures on Windows: expected `"name": "bash"`, received `"name": "pwsh"`, exactly as the documented platform gate requires |
| Vendored changelog | all 19 items audited against `cordiverse/cordis@56b3d4f7` — **no contradictions** |

Nothing was rewritten to fit a test result. **Three claims in the first draft were wrong**, all failing the same way — a plausible pattern mistaken for evidence: a suggestive name (`reasoning-chunks`, actually a lossless storage codec), a grep matching one call shape (`register(defineTool`, missing four tools and two raw registrations), and a search scoped to `src/` while the producer sat in YAML (`complete: true`). None would have been caught by review; each needed someone to open the file.

**The one claim unverifiable in this environment:** the attribution of five vendored modifications to local rather than fork authorship, because `deepseek-harness/cordis` is private.
