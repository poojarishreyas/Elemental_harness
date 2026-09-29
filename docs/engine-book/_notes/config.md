# Configuration that changes engine behavior

Only values whose effect on a mechanism was traced in code. Each row gives the **default actually in force in the shipped `web` profile**, which is often *not* the base bundle's value — see §1 on why.

All ✅ Verified (code/config). Nothing here was run-verified (see `open-questions.md` Q1).

---

## 1. Why "the default" needs three layers

A config value reaches a running web session through up to three composition layers, last write winning **per row id**:

1. `packages/bundle/base/cordis.patch.yml` — the shared core.
2. `packages/bundle/web-app/cordis.patch.yml` — the web surface; sets `disabled: true` on most agent-plane rows.
3. `packages/preset/agent-presets/presets/standard/agent.cordis.yml` — re-mounts the agent plane per agent.

A patch **replaces a targeted row's whole `config`** rather than merging into it — verified in `vendor/include/src/index.ts:121-124 → applyEntryPatches()`, which copies override keys wholesale (`target[key] = value`), so a later layer restating `config:` discards every key the earlier layer set.

Consequence: for any per-agent tool, **the preset's value is the live one**, and the base's value never reaches a web session at all. Two rows where they genuinely differ:

| Row | base | standard preset | Live in web |
|---|---|---|---|
| `tool-web` | `fetch: false` | `fetch: true` | **`fetch: true`** |
| `tool-subagent-fork` | `backgroundMode: one-shot` | `backgroundMode: continuable` | **`continuable`** |

---

## 2. Engine core

| Setting | Default | Where | Effect |
|---|---|---|---|
| `maxParallelToolCalls` | `10` | `agent-loop/src/constants.ts:6`; schema `index.ts:306-308` | Max in-flight parallel-safe calls per step. Validated by `resolveMaxParallelToolCalls` (`index.ts:189-195`): integer ≥ 1 or throw. Exposed as a **read-through getter** (`index.ts:389-391`) destructured once per tool group (`tool-calls.ts:132`), so a change caps the *next* group, never one in flight. User-owned via the `agent-loop` settings namespace. |
| `agents` | `[]` | `bundle/base/cordis.patch.yml:486-489` | Agents created at plugin startup. Empty in web — the browser creates sessions on request. Deliberately **not** user-settable: it is consumed once at boot, so a stored change "could only look like it had an effect" (`index.ts:296-303`). |

## 3. Model routing

| Setting | Default | Where | Effect |
|---|---|---|---|
| default provider / model | `deepseek-official` / `deepseek-v4-flash` | `bundle/base/cordis.patch.yml:73-79` | The route new agents start from. |
| `llm-deepseek` | **`disabled: true`** | `bundle/web-app/cordis.patch.yml:41-42` | The native adapter never registers in web; providers come from the Models settings document instead. |
| `llm-pi-ai` `providers` | `{}` | `llm-pi-ai/src/config.ts:340-342` | Mounts dormant — registers **zero routes** until a settings section supplies profiles. |
| `defaultContextWindow` (DeepSeek) | `1_000_000` | `llm-deepseek/src/adapter.ts:140` | Capacity fact flowed into `request/context`; not a token counter. |
| `DEFAULT_MAX_TOKENS` (DeepSeek) | `256_000` | `llm-deepseek/src/adapter.ts:142` | Fills `maxTokens` when the caller omits it, which is what stamps `adapterDefaults.maxTokens = true`. |
| `reasoningEffort` (DeepSeek) | `high` | `llm-deepseek/src/adapter.ts:187-193` | Unless `thinking: 'disabled'`, which offers only `off`. |

## 4. Retry

| Setting | Default | Where | Effect |
|---|---|---|---|
| `maxRetries` | `5` | `llm/src/retry-policy.ts:14-24` | `normal` mode only; `always` mode retries indefinitely. |
| `initialDelayMs` / `maxDelayMs` | `500` / `10_000` | same | Bounded exponential backoff. |
| `jitterRatio` | `0.1` | same | Symmetric jitter. |
| `retryableCodes` | `EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT` | same | `normal` mode gate. |
| — | — | — | **Captured at adapter-registration time**, not per request (`llm/src/index.ts:429-430`). A request with no `preparedCall` carries `retryPolicy: undefined` and is never retried. |

## 5. Context-window management

| Setting | Default | Where | Effect |
|---|---|---|---|
| `auto` | `true` | `compaction-basic/src/config.ts:95` | Enables both the pressure and overflow triggers. |
| `thresholdRatio` | `0.8` | `compaction-basic/src/config.ts:20` | Compact when measured tokens ≥ 80% of the model's context window. |
| `retainRatio` | `0.16` | `compaction-basic/src/config.ts:23` | Keep ~16% of the window as verbatim recent history. |
| `maxOverflowRetries` | `1` | `compaction-basic/src/config.ts:93` | Cap on compact-and-retry after `CONTEXT_WINDOW_EXCEEDED`. |
| pruner `thresholdChars` / `headChars` / `tailChars` | `8192` / `4096` / `1024` | base:404-409 **and** preset:150-155 (identical) | Model-free truncation of oversized tool results, tried before any LLM summarization. |
| `maxInlineBytes` (spill) | `50000` | `bundle/base/cordis.patch.yml:393-396` | Host-plane; **not** touched by web-app, so the base value stands. Plain-text tool results above this are written out of line. |
| `cleanupPeriodDays` (spill-local) | `30` | `spill-local/src/index.ts:68` | Startup sweep of old spill files. |
| Token estimate | `CHARS_PER_TOKEN=4`, `BLOCK_OVERHEAD=4`, `ROLE_OVERHEAD=4` | `token-meter/src/estimate.ts:13-19` | **Not a tokenizer.** Heuristic used until real provider `usage` is known. |

## 6. Permissions and sandbox

| Setting | Default | Where | Effect |
|---|---|---|---|
| sandbox `mode` | `workspace-write` | `bundle/base/cordis.patch.yml:217` via `DSH_PERMISSION_MODE` | File-effect boundary. |
| `workspaceRoot` | `process.cwd()` | `bundle/base/cordis.patch.yml:218` | |
| approval `policy` | `ask` | `bundle/base/cordis.patch.yml:233` | `!!js` expression: becomes `never` iff `DSH_PERMISSION_MODE === 'danger-full-access'`. A `never` policy resolves to `rejected` **before any answerer runs** and is deliberately not waterfall-overridable (`user-approval/src/index.ts:277`). |
| presets | `read-only` / `workspace-write` / `danger-full-access` | `bundle/base/cordis.patch.yml:238-247` | Named sandbox+approval pairs. |

## 7. Environment variables that change behavior

| Var | Effect | Where |
|---|---|---|
| `DSH_PERMISSION_MODE` | Sets sandbox mode **and** derives the approval policy | base:217, 233 |
| `DSH_TOOLS_MODE` | `native` \| `ptc` \| `both`; unset = `native`. Documented in-file as a **temporary** seam pending per-session selection | web-app:31-37 |
| `DSH_TELEMETRY_MODE` | `FEEDBACK_ONLY` (default) \| `FULL` \| `DISABLED` | base:193 |
| `DSH_TELEMETRY_DISABLED` | Any non-empty value (**including `'0'`/`'false'`**) opts the process out | base:179-181 |
| `DSH_TELEMETRY_OTLP_URL` | Overrides the exporter endpoint | base:196 |
| `DEEPSEEK_API_KEY` | Credential for chat and DeepSeek web search | base:459 |
| `DSH_HOME` | Root for sessions, storages, credentials, settings, user presets | `dshHomePath(...)` |

## 8. Platform-conditional rows

Evaluated lazily per row via `Entry.disabledOf()` (`vendor/loader/src/config/entry.ts:100-108`), which interpolates a `!!js` expression:

| Row | Disabled when |
|---|---|
| `tool-bash`, `bash-sandbox` | `process.platform === 'win32'` |
| `tool-pwsh`, `pwsh-sandbox` | `process.platform !== 'win32'` |

On this Windows checkout the live shell tool is therefore `pwsh`, not `bash`.

## 9. Other mounted-row values worth knowing

| Row | Value | Where |
|---|---|---|
| `session-persistence-jsonl` `root` | `dshHomePath('sessions')` | base:110-113 |
| `session-query-sqlite` | `path: ':memory:'`, `openAt: never` | base:129-133, restated web-app:26-29 |
| `session-projection-cache` | `writeEveryEvents: 200`, `writeIntervalMs: 5000` | base:162-166 |
| `agent-instructions` `maxBytes` | `65536` | base:274-277, preset:30-33 |
| `tool-ralph` `maxRounds` | `64` | base:422-427, preset:213-217 |
| `repeat-tool-reminder` | `thresholds: [3,5,8]`, `argumentsPreviewChars: 500` | base:434-438 |
| `tool-web` `searchTimeoutMs` | `60000` (vs a 30s provider-neutral default) | base:464-468, preset:231-235 |
| webserver | `127.0.0.1:3080`, gzip level 1 above 1024 bytes | web-app:121-129 |
| `agent-presets` `default` | `standard` | web-app:451-456 |
