# Appendix C · Configuration reference

Every value whose effect on a mechanism this book traced, with the default **actually in force in the shipped `web` profile**.

---

## How to read a default

A value reaches a running session through up to three layers, last write winning **per row id**:

1. `packages/bundle/base/cordis.patch.yml` — the shared core
2. `packages/bundle/web-app/cordis.patch.yml` — the web surface; `disabled: true` on most agent-plane rows
3. `packages/preset/agent-presets/presets/standard/agent.cordis.yml` — re-mounts the agent plane per agent

A patch **replaces a row's whole `config`** rather than merging (`vendor/include/src/index.ts:121-124`). So for any per-agent tool, **the preset's value is the live one** and the base's never reaches a web session.

Two rows where they genuinely differ:

| Row | base | standard preset | **Live** |
|---|---|---|---|
| `tool-web` | `fetch: false` | `fetch: true` | `fetch: true` |
| `tool-subagent-fork` | `backgroundMode: one-shot` | `backgroundMode: continuable` | `continuable` |

→ [Ch 34](34-composition-in-full.md)

---

## Engine core

| Setting | Default | Where | Effect |
|---|---|---|---|
| `maxParallelToolCalls` | `10` | `agent-loop/src/constants.ts:6` | Max in-flight parallel-safe calls per group. Integer ≥ 1 or throw. Read through a getter, destructured once per group. Deployment-wide. → [Ch 17](17-scheduling-tool-calls.md) |
| `agents` | `[]` | base:486-489 | Agents created at startup. Deliberately not user-settable. → [Ch 14](14-agent-lifecycle.md) |

## Model routing

| Setting | Default | Where | Effect |
|---|---|---|---|
| default route | `deepseek-official` / `deepseek-v4-flash` | base:73-79 | What new agents start from |
| `llm-deepseek` | **`disabled: true`** | web-app:41-42 | The native adapter never registers in web |
| `llm-pi-ai` `providers` | `{}` | `llm-pi-ai/src/config.ts:340-342` | Dormant — **zero routes** until settings supply profiles → [Ch 32](32-when-things-go-wrong.md) |
| `defaultContextWindow` | `1_000_000` | `llm-deepseek/src/adapter.ts:140` | Capacity fact; feeds the compaction threshold |
| `DEFAULT_MAX_TOKENS` | `256_000` | `llm-deepseek/src/adapter.ts:142` | Fills `maxTokens` when omitted → stamps `adapterDefaults` |
| `reasoningEffort` | `high` (`off` only when `thinking: 'disabled'`) | `llm-deepseek/src/adapter.ts:187-193` | |

## Retry

| Setting | Default | Effect |
|---|---|---|
| `mode` | `normal` | `always` removes both the code gate and the retry cap |
| `maxRetries` | `5` | `normal` only |
| `initialDelayMs` / `maxDelayMs` | `500` / `10_000` | Exponential backoff bounds |
| `jitterRatio` | `0.1` | Symmetric jitter |
| `retryableCodes` | `EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT` | `normal` only |

— `packages/llm/llm/src/retry-policy.ts:14-24`; plugin mounted at base:84-85. Captured **at adapter registration**, not per request. → [Ch 25](25-failures-and-retry.md)

## Context-window management

| Setting | Default | Where | Effect |
|---|---|---|---|
| `auto` | `true` | `compaction-basic/src/config.ts:95` | Enables both triggers |
| `thresholdRatio` | `0.8` | `config.ts:20` | Compact at 80% of the context window |
| `retainRatio` | `0.16` | `config.ts:23` | Verbatim recent history preserved |
| `maxOverflowRetries` | `1` | `config.ts:93` | Compact-and-retry attempts per failure |
| `modelPolicies` | none configured | `config.ts:105-125` | Per-`provider/model` overrides |
| pruner `thresholdChars` | `8192` | base:404-409, preset:150-155 | Truncate results above this |
| pruner `headChars` / `tailChars` | `4096` / `1024` | same | What survives truncation |
| `maxInlineBytes` (spill) | `50000` | base:393-396 | Host-plane; **not** touched by web-app |
| `cleanupPeriodDays` (spill) | `30` | `spill-local/src/index.ts:68` | Startup sweep of old spill files |
| token estimate | `CHARS_PER_TOKEN=4`, `BLOCK_OVERHEAD=4`, `ROLE_OVERHEAD=4` | `token-meter/src/estimate.ts:13-19` | **Not a tokenizer** → [Ch 26](26-measuring-and-spilling.md) |

Mount status: `compaction-basic`, `command-compact`, and `tool-result-pruner` are base-mounted, web-app-disabled, and **re-mounted by the standard preset** inside an `isolate: {compaction, toolResultPruner}` group. Live per agent. → [Ch 27](27-pruning-and-compaction.md)

## Permissions and sandbox

| Setting | Default | Where |
|---|---|---|
| sandbox `mode` | `workspace-write` | base:217, from `DSH_PERMISSION_MODE` |
| `workspaceRoot` | `process.cwd()` | base:218 |
| approval `policy` | `ask` | base:233 — a `!!js` expression; becomes `never` iff `DSH_PERMISSION_MODE === 'danger-full-access'` |
| presets | `read-only` / `workspace-write` / `danger-full-access` | base:238-247 |

`policy: 'never'` is enforced **inline**, before any answerer runs — not waterfall-overridable. → [Ch 18](18-approval-and-escalation.md)

## Persistence

| Setting | Default | Where |
|---|---|---|
| `root` | `dshHomePath('sessions')` | base:110-113 |
| compression | `zstd` | jsonl backend |
| `packChunks` | `true` | jsonl backend → [Ch 30](30-crash-repair-and-chunk-packing.md) |
| `session-query-sqlite` | `path: ':memory:'`, `openAt: never` | base:129-133, web-app:26-29 — **SQLite is never opened** |
| projection cache | `writeEveryEvents: 200`, `writeIntervalMs: 5000` | base:162-166 |

## Prompt and tools

| Setting | Default | Where |
|---|---|---|
| `persona` | `''` base; set in web-app and again in the preset (which shadows) | base:481-482, web-app:16-19, preset:24-28 |
| `tools.mode` | `native` (from `DSH_TOOLS_MODE`) | web-app:31-37 — documented as a **temporary** seam |
| `agent-instructions.maxBytes` | `65536` | base:274-277, preset:30-33 |
| `tool-todo.allowParallelInProgress` | `true` | base:411-414, preset:224-227 |
| `tool-ralph.maxRounds` | `64` | base:422-427, preset:213-217 |
| `repeat-tool-reminder` | `thresholds: [3,5,8]`, `argumentsPreviewChars: 500` | base:434-438 |
| `tool-web.searchTimeoutMs` | `60000` | base:464-468, preset:231-235 |
| `agent-presets.default` | `standard` | web-app:451-456 |
| webserver | `127.0.0.1:3080`, gzip level 1 above 1024 bytes | web-app:121-129 |

## Environment variables

| Var | Effect |
|---|---|
| `DSH_PERMISSION_MODE` | Sets sandbox mode **and** derives the approval policy |
| `DSH_TOOLS_MODE` | `native` \| `ptc` \| `both`; unset = `native` |
| `DSH_TELEMETRY_MODE` | `FEEDBACK_ONLY` (default) \| `FULL` \| `DISABLED` |
| `DSH_TELEMETRY_DISABLED` | Any non-empty value — **including `'0'`/`'false'`** — opts out |
| `DSH_TELEMETRY_OTLP_URL` | Overrides the exporter endpoint |
| `DEEPSEEK_API_KEY` | Credential for chat and DeepSeek web search |
| `DSH_HOME` | Root for sessions, storages, credentials, settings, user presets |

## Platform-conditional rows

Evaluated lazily per row via `Entry.disabledOf()` (`vendor/loader/src/config/entry.ts:100-108`):

| Row | Disabled when |
|---|---|
| `tool-bash`, `bash-sandbox` | `process.platform === 'win32'` |
| `tool-pwsh`, `pwsh-sandbox` | `process.platform !== 'win32'` |

## Mounted but inert

Worth knowing when reading a composition — a row can be present and do nothing:

| Row | Why inert |
|---|---|
| `session-query-sqlite` | `openAt: never` — SQLite never opened; search fails `SESSION_QUERY_SEARCH_DISABLED` |
| `llm-pi-ai` | empty `providers` dict — registers zero routes |
| `hmr` | `disabled: true` in base |
| `skill-badge` | `disabled: true` in base |
| `ui-schedule` | `disabled: true` in web-app |
| `dsh-invariants` | mounted **nowhere** → [Ch 11](11-the-reconstruction-invariant.md) |
