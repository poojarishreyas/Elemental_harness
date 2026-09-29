# Appendix D · Mechanism index

Mechanism → chapter → key files. Use this to jump from a file you are reading to the chapter that explains it.

---

## By mechanism

| Mechanism | Chapter | Key files |
|---|---|---|
| Append-only log | [5](05-the-append-only-log.md) | `packages/core/session/src/index.ts:602-653` |
| Surface (append / replace) | [6](06-the-surface.md) | `packages/core/session/src/surface.ts` |
| Message derivation | [7](07-from-log-to-request.md) | `surface.ts:83-114`, `index.ts:724-745` |
| Projections | [8](08-projections.md) | `packages/session/session-projection/src/index.ts` |
| Turn loop | [9](09-the-turn-and-step-loops.md) | `packages/core/agent-loop/src/agent.ts:255-339` |
| Step loop | [9](09-the-turn-and-step-loops.md) | `agent-loop/src/agent.ts:341-438` |
| Request construction | [10](10-building-the-request.md) | `agent-loop/src/agent.ts:444-544` |
| Reconstruction invariant | [11](11-the-reconstruction-invariant.md) | `agent-loop/src/invariant.ts` |
| Inbox | [12](12-the-inbox.md) | `packages/core/agent/src/inbox.ts` |
| Phase machine / cancellation | [13](13-phases-cancellation-quiescence.md) | `agent-loop/src/agent.ts:39-232` |
| Agent lifecycle | [14](14-agent-lifecycle.md) | `agent-loop/src/index.ts:522-773` |
| Tool registry | [15](15-the-tool-registry.md) | `packages/core/tools/src/index.ts:1028-1053` |
| Execution pipeline | [16](16-the-execution-pipeline.md) | `core/tools/src/index.ts:1450-1667` |
| Tool-call scheduling | [17](17-scheduling-tool-calls.md) | `agent-loop/src/tool-calls.ts` |
| Approval | [18](18-approval-and-escalation.md) | `packages/interaction/user-approval/src/index.ts:222-309` |
| Sandbox escalation | [18](18-approval-and-escalation.md) | `packages/sandbox/sandbox/src/escalation.ts:157-189` |
| Prompt assembly | [19](19-prompt-assembly.md) | `packages/core/system-prompt/src/index.ts:536-611` |
| Variable interpolation | [20](20-variable-interpolation.md) | `system-prompt/src/index.ts:309-346` |
| Runtime context | [21](21-runtime-context-injection.md) | `agent-loop/src/runtime-context.ts` |
| Extension points | [22](22-extension-points.md) | `packages/core/agent/src/dispatch.ts`, `vendor/cordis/src/events.ts:194-243` |
| Adapters / `prepareCall` | [23](23-adapters-and-preparecall.md) | `packages/llm/llm/src/index.ts:890-935` |
| Block assembly | [24](24-streaming-and-assembly.md) | `packages/llm/llm/src/assembler.ts` |
| Failure normalization | [25](25-failures-and-retry.md) | `packages/llm/llm/src/adapter-failure.ts` |
| Retry | [25](25-failures-and-retry.md) | `packages/llm/llm-retry/src/index.ts:194-258` |
| Token metering | [26](26-measuring-and-spilling.md) | `packages/llm/token-meter/src/{index,estimate}.ts` |
| Spill | [26](26-measuring-and-spilling.md) | `packages/spill/spill-policy/src/index.ts:110-232` |
| Tool-result pruning | [27](27-pruning-and-compaction.md) | `compaction-tool-result-pruner/src/index.ts:136-184` |
| Compaction | [27](27-pruning-and-compaction.md) | `compaction-basic/src/{index,region,summarizer}.ts` |
| Subagents | [28](28-subagents.md) | `subagent/subagent-in-process-driver/src/index.ts:103-234` |
| Persistence | [29](29-persistence.md) | `session-persistence/src/coordinator.ts`, `session-persistence-jsonl/src/index.ts` |
| Crash repair | [30](30-crash-repair-and-chunk-packing.md) | `packages/core/session/src/repair.ts:28-134` |
| Chunk packing | [30](30-crash-repair-and-chunk-packing.md) | `packages/core/session/src/chunk-rows.ts` |
| Boot and profiles | [34](34-composition-in-full.md) | `apps/server/src/`, `packages/boot/app-boot/src/` |
| Patch algebra | [34](34-composition-in-full.md) | `vendor/include/src/index.ts:58-128` |
| Isolate realms | [34](34-composition-in-full.md) | `vendor/loader/src/config/isolate.ts` |
| Scope layering | [34](34-composition-in-full.md) | `packages/core/scope/src/{index,store}.ts` |
| Agent presets | [34](34-composition-in-full.md) | `packages/preset/agent-presets/src/{index,mount}.ts` |

---

## By file (reverse lookup)

| File | Chapter |
|---|---|
| `packages/core/agent-loop/src/agent.ts` | [9](09-the-turn-and-step-loops.md), [10](10-building-the-request.md), [13](13-phases-cancellation-quiescence.md) |
| `packages/core/agent-loop/src/index.ts` | [14](14-agent-lifecycle.md), [8](08-projections.md) |
| `packages/core/agent-loop/src/tool-calls.ts` | [17](17-scheduling-tool-calls.md) |
| `packages/core/agent-loop/src/runtime-context.ts` | [21](21-runtime-context-injection.md) |
| `packages/core/agent-loop/src/invariant.ts` | [11](11-the-reconstruction-invariant.md) |
| `packages/core/session/src/index.ts` | [5](05-the-append-only-log.md), [7](07-from-log-to-request.md) |
| `packages/core/session/src/surface.ts` | [6](06-the-surface.md), [7](07-from-log-to-request.md) |
| `packages/core/session/src/chunk-rows.ts` | [30](30-crash-repair-and-chunk-packing.md) |
| `packages/core/session/src/repair.ts` | [30](30-crash-repair-and-chunk-packing.md) |
| `packages/core/agent/src/inbox.ts` | [12](12-the-inbox.md) |
| `packages/core/agent/src/dispatch.ts` | [22](22-extension-points.md) |
| `packages/core/tools/src/index.ts` | [15](15-the-tool-registry.md), [16](16-the-execution-pipeline.md) |
| `packages/core/system-prompt/src/index.ts` | [19](19-prompt-assembly.md), [20](20-variable-interpolation.md) |
| `packages/core/scope/src/store.ts` | [19](19-prompt-assembly.md), [34](34-composition-in-full.md) |
| `packages/llm/llm/src/index.ts` | [23](23-adapters-and-preparecall.md) |
| `packages/llm/llm/src/assembler.ts` | [24](24-streaming-and-assembly.md) |
| `packages/llm/llm-retry/src/index.ts` | [25](25-failures-and-retry.md) |
| `packages/llm/token-meter/src/` | [26](26-measuring-and-spilling.md) |
| `packages/compaction/compaction-basic/src/` | [27](27-pruning-and-compaction.md) |
| `packages/spill/spill-policy/src/index.ts` | [26](26-measuring-and-spilling.md) |
| `packages/session/session-persistence/src/coordinator.ts` | [29](29-persistence.md) |
| `packages/session/session-projection/src/index.ts` | [8](08-projections.md) |
| `packages/interaction/user-approval/src/index.ts` | [18](18-approval-and-escalation.md) |
| `packages/sandbox/sandbox/src/escalation.ts` | [18](18-approval-and-escalation.md) |
| `packages/preset/agent-presets/src/mount.ts` | [34](34-composition-in-full.md) |
| `packages/bundle/*/cordis.patch.yml` | [34](34-composition-in-full.md), [App C](appendix-c-configuration.md) |
| `vendor/cordis/src/events.ts` | [22](22-extension-points.md) |
| `vendor/cordis/src/fiber.ts` | [2](02-just-enough-architecture.md), [34](34-composition-in-full.md) |
| `vendor/include/src/index.ts` | [34](34-composition-in-full.md) |
| `vendor/loader/src/config/isolate.ts` | [34](34-composition-in-full.md) |

---

## By extension point

| Point | Mode | Chapter | Live listeners in web |
|---|---|---|---|
| `agent/pre-step` | waterfall | [22](22-extension-points.md) | 12 — the dominant surface |
| `agent/request` | waterfall | [10](10-building-the-request.md), [22](22-extension-points.md) | 1 (model selection) |
| `agent/request-error` | waterfall | [25](25-failures-and-retry.md), [27](27-pruning-and-compaction.md) | 2 (compaction, retry) |
| `agent/turn-stopping` | serial | [22](22-extension-points.md) | **0** |
| `agent/status` | emit | [13](13-phases-cancellation-quiescence.md) | 3 |
| `agent/created` / `agent/disposed` | emit | [14](14-agent-lifecycle.md) | 5 / 4 |
| `agent/inbox/*` | emit | [12](12-the-inbox.md) | 1–3 each |
| `agent/error` | emit | [9](09-the-turn-and-step-loops.md) | 3 |
| `agent/session-start` | emit | [14](14-agent-lifecycle.md) | 2 |
| `tools/pre-execute` | waterfall | [16](16-the-execution-pipeline.md), [18](18-approval-and-escalation.md) | **0 producing `ask`** |
| `tools/execute` | waterfall | [16](16-the-execution-pipeline.md) | timeout policy |
| `tools/post-execute` | waterfall | [16](16-the-execution-pipeline.md), [26](26-measuring-and-spilling.md) | spill policy |
| `tools/result` | emit | [16](16-the-execution-pipeline.md) | UI bridges |
| `llm/stream` | waterfall | [11](11-the-reconstruction-invariant.md) | (invariant — not mounted) |
| `system-prompt/assemble` | waterfall | [19](19-prompt-assembly.md) | (invariant — not mounted) |
| `approval/request` | waterfall | [18](18-approval-and-escalation.md) | UI approval |
| `session/event` | emit | [5](05-the-append-only-log.md) | persistence, projections, telemetry |
