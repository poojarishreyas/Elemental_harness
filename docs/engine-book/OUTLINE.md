# How the Engine Works — outline

**Status: awaiting approval. No chapters written yet.**

Subject: the agent engine of Lynx Harness (`packages/core/agent-loop` and the mechanisms it depends on), as it actually runs in the shipped `web` profile.

## Evidence stance for the whole book

`node_modules` is absent and the user chose not to install it, so **every claim carries ✅ Verified (code) at best**; the 🧪 Verified (run) level appears nowhere. The README will say this plainly. 🔶 Inferred and ❓ Unknown claims are marked inline. The riskiest sections — termination conditions and control decisions — get a dedicated re-read in Phase 5 in place of empirical confirmation.

Structure follows the teaching order in `_notes/mechanism-map.md` §3. Composition/Cordis is deliberately **late**: Chapter 2 gives only enough to orient, because it is the least interesting part to a reader who wants to know how the engine works, and it only becomes meaningful once you know what is being composed.

---

## Part I — Orientation

**Ch 1 · The core idea in one page.**
Every LLM request this engine sends is a pure function of an append-only event log. Not a convention — machine-checked (Ch 10). What that buys: resume, fork, compaction, and replay all become operations on one data structure. Plain language, no code.

**Ch 2 · Just enough architecture.**
One application entry (`apps/server`), one fixed profile (`web`), an all-plugin composition. The ~90 mounted rows in one diagram, the mechanism map from `_notes/mechanism-map.md` §2, and a one-page Cordis primer (context / service / fiber / effect) — only the ~10% of Cordis needed to read the rest. Full composition deferred to Ch 31.

**Ch 3 · The core data structures.**
The book's vocabulary chapter, all with real definitions and real examples from `snapshots/session/text-turn/`:
`SessionEvent` envelope (`type`, `seq`, `time`, `data`, optional `surfaceOp`/`sourceEventSeqs`/`ignorable`) · `SessionEventMap` and how declaration merging extends it · `SurfaceOp` (`'append'` vs `{op:'replace',start,end}`) · `Message` / `ContentBlock` (text, reasoning, image, tool-call, tool-result) · `StreamChunk`'s seven kinds · `EpochHeader` and `LlmCallConfig` · `ToolDefinition` / `ToolExecutionResult` · `TurnEndReason`'s six variants.

---

## Part II — Build the mental model

**Ch 4 · The engine in 100 lines.**
A minimal driver in the project's own TypeScript: claim input → derive messages from the log → build a request → stream → append the assistant message → run tool calls → repeat until no tool calls. Every line explained. Then an honest list of everything the real implementation adds — cancellation, retry, the surface, scheduling, approval, compaction, presets — each linking to its chapter. This is the spine the rest of the book hangs on.

---

## Part III — The mechanisms

Each chapter uses the ten-part template: problem → mental model → lifecycle diagram → walkthrough → data at each stage → control decisions → edge cases → config knobs → interactions → build it yourself.

### The log

**Ch 5 · The append-only log.** `append()`'s ten ordered steps; `seq = log.length` contiguity enforced at four boundaries; lossless-JSON snapshotting; the reentrancy refusal; why the header is deliberately *not* in the log; `ignorable` and the generated known-event-type gate; `SESSION_FORMAT_VERSION = 0` and why adding an event type does not bump it.

**Ch 6 · The surface.** The indirection that lets history be rewritten without deleting anything. Only three event types are surface-eligible. `replace` splices shadowed nodes out of the node list and bumps `replaceGeneration`. Provenance rules: `sourceEventSeqs` must cite strictly earlier events and must cover every shadowed node. The extra `tool/result` rewrite constraint (content only, exactly one shadowed node).

**Ch 7 · From log to request: `deriveMessages()`.** The per-node projection (`user/message` verbatim, `assistant/message` unless empty-content, `tool/result`, everything else `null`) and the incremental cache invalidated by `replaceGeneration`. Why the projection is deliberately non-exhaustive and why framing is caller-owned.

**Ch 8 · Projections.** `ProjectionDefinition`'s pure fold, `stateVersion` cache invalidation, reference-equality double-debounce, checkpoint/restore/hydrate. Worked example: the loop's own `turnBoundary` projection.

### The loop

**Ch 9 · The turn and step loops.** The three nested loops. Every branch point from `_notes/control-flow.md` §4–5: the reject path, the two empty-message paths, sticky `max-tokens`, the `turn-stopping` last-chance re-test, and the single condition under which a turn continues to another step. State diagram.

**Ch 10 · Building the request.** The seed config and what `requestProposal` strips; the persisted-`reasoningEffort` restoration rule; the `NO_ADAPTER`-only fallback; the three-way `request/header` logging decision (`initial`/`resume`/`change`/`series`) and how a surface replace starts a new series.

**Ch 11 · The invariant that proves the thesis.** `src/invariant.ts`: a prepended global `llm/stream` listener asserting frozen request, live session id, and `JSON.stringify(messages) === JSON.stringify(deriveMessages())` — "log-reconstruction desync". Includes the honest caveat that its mount status in the running profile is ❓ Unknown (Q2).

**Ch 12 · The inbox.** Durable-first splice (event before memory), the duplicate-id guard, `claim()`'s asymmetry (drain all of `next-step`, pop **one** from `next-turn`), and the real difference between `followup` / `steer` / `inject` — two axes, target and wake.

**Ch 13 · Phases, cancellation, and quiescence.** The three-state machine, the per-phase abort controller replaced between turns, wake latching and why disposal never latches, `whenIdle()`'s double-check loop, `runMaintenance`.

**Ch 14 · Agent lifecycle.** `prepare` → `publish` → memoized reverse teardown; three fused cancellation owners (caller, owner fiber, factory); why the teardown is registered *before* any resource exists; the resume load barrier.

### Tools

**Ch 15 · The tool registry.** Registration as an effect, `ToolDefinition`'s shape, what `defineTool` wraps (hard validation for `execute`, soft for presenters and the concurrency classifier), the reserved `run_code` name.

**Ch 16 · The execution pipeline.** `executionMode` → `prepare` → `dispatch` → `finish`/`finalize`. The exact rule deciding `needsPost`, and why guard/approval denials still run post-execute while PTC collapses do not. `ToolExecutionInput` vs `ToolRunContext` vs `ToolExecutionResult`, and why `value` never reaches the durable log.

**Ch 17 · Scheduling a step's tool calls.** Fail-closed concurrency classification; exclusive barriers vs the bounded rolling pool; live reclassification mid-group; contiguous model-order commit; abort recording synthetic results so replay stays valid; `concludesTurn`; and what `parseArguments` does with malformed JSON.

**Ch 18 · Approval and sandbox escalation.** The two *independent* gating paths: the generic `tools/pre-execute` → `ask` → `ApprovalService` seam, and what shipped tools actually do — in-body `approveEscalation` with the model supplying `sandbox_permissions` + `justification`. Why `policy: 'never'` is deliberately not waterfall-overridable.

### Prompt and context

**Ch 19 · Prompt assembly.** Sections / contexts / tools / variables; scope-chain shadowing by name (nearest wins); tool providers concatenate rather than shadow; deterministic ordering; the `system-prompt/assemble` waterfall and its validating invariant. Real output: `snapshots/session/text-turn/system-prompt.expected.md`.

**Ch 20 · Variable interpolation.** The hand-rolled scanner, why substituted values are never re-scanned, and the precise difference between a lone `{{` (literal prose) and a malformed reference (hard error).

**Ch 21 · Runtime context injection.** `RuntimeContextProjection`'s three-way retained state; the change-triggered rule; the `CLEARED` retraction sentinel; why the synthetic message enters as the *innermost default* of `agent/pre-step` and becomes an ordinary logged `user/message`. Real example: `session.jsonl:10`.

**Ch 22 · Extension points.** `emit` vs `serial` vs `waterfall` from the vendored implementation; what `next()` actually is and why not calling it vetoes the chain; scope-filtered delivery; the agent fused into every payload. Full census of who listens to what — **including that `agent/turn-stopping` has zero live listeners in the shipped profile.**

### Model I/O

**Ch 23 · Adapters and `prepareCall`.** Route lookup, exact-model resolution, what `adapterDefaults` records and why the loop strips those fields next turn, the one-shot frozen `PreparedLlmCall`, and per-generation binding so a settings change cannot mix generations.

**Ch 24 · Streaming and the block assembler.** Seven chunk kinds → content blocks; `block-end` as authoritative; the `max-tokens` rule that drops tool calls; `interruptedBlocks()` on cancellation and why tool calls are omitted; `finish` defaulting to `stop`.

**Ch 25 · Failures and retry.** `LlmFailure`, the code taxonomy, and `normalizeLlmFailure`'s defenses against hostile error objects. Then the key architectural point: **the loop never retries on its own** — `llm-retry` answers the `agent/request-error` waterfall, counts retries *durably* in the session log, and honors `providerRetryAfterMs`.

### Context-window management

**Ch 26 · Measuring and spilling.** The token meter's real-usage-preferred, heuristic-fallback design (and that it is not a tokenizer). Spill as the earliest defense: oversized plain-text tool results written out of line at execution time, with the `read`-tool exclusion that prevents a loop.

**Ch 27 · Pruning and compaction.** The layered defenses. Model-free tool-result pruning first; then LLM summarization: durable `compaction/start` lock, region selection that never splits a tool-call/result pair, prefix reuse for KV-cache stability, the refusal to commit a compaction that would not shrink, and the `replace` that shadows the region. Then the feedback edge: on `CONTEXT_WINDOW_EXCEEDED`, compact and return `{kind:'retry'}` so the *same* request is re-issued.

### Delegation

**Ch 28 · Subagents.** A child is a genuine nested `Agent` built through the same factory. Spawn (no inherited context) vs fork (seeded history for cache reuse); depth capping that survives resume; how a child joins the parent's preset; results back via `whenIdle` + final-output extraction, or via the continuation channel for continuable children.

### Durability

**Ch 29 · Persistence.** JSONL one file per session, the coordinator's batching and per-id serialization, `SessionPreparation` and reservation reuse, `link()`/`unlink()` materialization, fsync with truncate-on-failure rollback.

**Ch 30 · Crash repair and chunk packing.** `interruptedTurnClosers` synthesizing results for pending calls — and the careful `TOOL_NOT_STARTED` vs `TOOL_OUTCOME_UNKNOWN` distinction it gives the model. Then the lossless chunk-row codec: runs of ≥3 deltas into one row, exact-shape whitelisting, safe-integer round-trip guards.

---

## Part IV — The engine in motion

**Ch 31 · One real turn, annotated.** A complete walkthrough of `snapshots/session/text-turn/session.jsonl` — 25 real log lines, start to finish, annotating which mechanism is active at each one, with the real token usage and the real assembled prompt beside it.

**Ch 32 · When things go wrong.** Three failure paths traced end to end: (a) context overflow → compaction → same request re-issued; (b) cancellation mid-stream → partial blocks salvaged → synthetic results for undispatched calls so replay stays valid; (c) **no provider configured** — the out-of-the-box path where `NO_ADAPTER` propagates all the way to a failed turn.

---

## Part V — Extending and changing the engine

**Ch 33 · Adding a tool.** Step by step, grounded in how `bash` and `str_replace_editor` are actually built: schema, output contract, concurrency declaration, presenters, and where to register it (host plane vs preset).

**Ch 34 · Composition in full.** The deferred chapter: profiles as patch stacks over an empty root, `applyEntryPatches`' replace-not-merge semantics, lazy `!!js` evaluation, isolate realms vs `dsh-scope` layering (two unrelated mechanisms), and agent presets as a standing mount joined by scope parentage.

**Ch 35 · Limits and fragile areas.** The token estimator is not a tokenizer. `maxParallelToolCalls` is deployment-wide. Sibling top-level effects tear down *concurrently*, not in order. `ctx.emit()` does not isolate listener failures. Live-edited presets fork a generation. `TODO(call-config-shape)` is an acknowledged open design question in the source.

**Ch 36 · Design decisions, as mini-ADRs.** Context → Decision → Alternatives → Tradeoffs, for: the log as the single source of truth; the surface instead of mutation; registrations as effects; the agent plane behind presets; retry as an extension point rather than a loop feature; approval `never` being non-delegatable.

---

## Part VI — Rebuild it

**Ch 37 · A milestone path from an empty folder.** Ten milestones, each adding one mechanism, naming the real files it corresponds to and how to tell it works: (1) event log with contiguous seq; (2) derive messages; (3) the 100-line loop; (4) tool calls; (5) the surface + replace; (6) streaming assembly; (7) cancellation and the phase machine; (8) the inbox and step boundaries; (9) prompt assembly and extension points; (10) compaction.

---

## Appendices

**A · Glossary** — every domain and project term, defined at first use in the text and collected here.
**B · Data-structure reference** — every core type, its fields, and where it is defined.
**C · Configuration reference** — from `_notes/config.md`, including the three-layer resolution rule.
**D · Mechanism index** — mechanism → chapter → key files.

---

## Open questions carried into writing

Tracked in `_notes/open-questions.md`. The ones that affect chapter content:

- **Q2** — is the reconstruction invariant (Ch 11) mounted in the running profile, or dev/test-only? Changes whether it is a runtime guarantee or a testing device.
- **Q9** — how does the Models settings UI make a provider route live when `llm-deepseek` is disabled by config? Affects Ch 32(c).
- **Q5** — `SESSION_FORMAT_VERSION` vs the header's `version: 0`; `delegationDepth` semantics.
- **Q4** — exact snapshot normalization rules, so Ch 31 can state precisely how the fixture differs from a live log.
