# How the Engine Works

The internal mechanisms of the Lynx Harness agent engine — what happens inside, step by step, and why.

This book explains `packages/core/agent-loop` and every mechanism it depends on, as the system actually runs in the shipped `web` profile. By the end you should be able to rebuild the core from an empty folder; [Part VI](37-rebuild-it.md) lays out that path explicitly.

---

## The one-sentence version

Every request this engine sends to a model is recomputed from an append-only event log immediately before dispatch — and that single decision is what makes resume, fork, compaction, and replay variations of one operation.

---

## Evidence standard

Every claim is tied to real code at a real line. Where the code and the documentation disagree, the code wins and the disagreement is recorded.

The book was written entirely from reading the implementation. **It was afterwards checked by building and running the suite**, which raises a large part of Part III from ✅ *Verified (code)* to 🧪 *Verified (run)*:

| Run | Result |
|---|---|
| `packages/core/agent-loop` | **342 / 342 pass**, 18 files — the engine core (Ch 9–14, 17, 19–22) |
| core + session + llm + compaction + spill | **3,373 / 3,383 pass**, 165 files |
| The 10 failures | all in one file, all `EPERM: operation not permitted, symlink` — Windows blocks symlink creation; environmental, not behavioral |
| `pnpm run test:snapshot` | 67 fail on this machine — **fixtures recorded on POSIX, replayed on Windows**. Expected `"name": "bash"`, received `"name": "pwsh"`, exactly as the documented platform gate requires ([Ch 34](34-composition-in-full.md)) |

That last row is worth reading twice: the snapshot suite is unusable as an oracle here, but **the shape of its failure confirms three separate claims** — that platform-conditional rows swap bash↔pwsh at mount, that the tool catalog is part of the request header, and that a catalog change therefore changes the header.

Claims that could not be fully confirmed are marked inline:

| Marker | Meaning |
|---|---|
| 🔶 **Inferred** | A reasonable conclusion from evidence, with the evidence and the gap both stated |
| ❓ **Unknown** | Could not be determined; says what was checked and what would confirm it |
| ⚠️ | A documentation-versus-code contradiction, or an unverified figure quoted from a comment |

After a follow-up resolution pass, the book contains **0 inferred claims and 1 remaining unknown** — the vendored framework's changelog, which needs an upstream checkout to diff against — plus 3 flagged documentation contradictions. Every claim marked uncertain in the first draft was chased down and either verified or corrected; two turned out to be **wrong**, and both corrections are recorded in [`_notes/evidence-report.md`](_notes/evidence-report.md).

---

## Reading paths

### Understand the core in an hour

Five chapters. Enough to read the engine's source with confidence.

1. [Ch 1 · The core idea in one page](01-the-core-idea.md) — no code
2. [Ch 2 · Just enough architecture](02-just-enough-architecture.md) — the ~10% of the plugin framework you need
3. [Ch 3 · The core data structures](03-core-data-structures.md) — the vocabulary
4. [Ch 4 · The engine in 100 lines](04-the-engine-in-100-lines.md) — the whole loop, simplified
5. [Ch 31 · One real turn, annotated](31-one-real-turn.md) — 25 lines of captured log, start to finish

### Full understanding

Read straight through. Part III is ordered so each chapter depends only on earlier ones.

### I want to rebuild it

[Ch 4](04-the-engine-in-100-lines.md) → [Ch 37](37-rebuild-it.md), then the chapters each milestone names. Milestones 1–7 need no plugin framework at all.

### I'm debugging something specific

[Appendix D · Mechanism index](appendix-d-mechanism-index.md) maps mechanisms, files, and extension points to chapters. [Ch 32](32-when-things-go-wrong.md) traces three failure paths end to end. [Ch 35](35-limits-and-fragile-areas.md) lists where the guarantees stop.

---

## Table of contents

### Part I — Orientation
- [1 · The core idea in one page](01-the-core-idea.md)
- [2 · Just enough architecture](02-just-enough-architecture.md)
- [3 · The core data structures](03-core-data-structures.md)

### Part II — Build the mental model
- [4 · The engine in 100 lines](04-the-engine-in-100-lines.md)

### Part III — The mechanisms

*The log*
- [5 · The append-only log](05-the-append-only-log.md)
- [6 · The surface](06-the-surface.md)
- [7 · From log to request](07-from-log-to-request.md)
- [8 · Projections](08-projections.md)

*The loop*
- [9 · The turn and step loops](09-the-turn-and-step-loops.md)
- [10 · Building the request](10-building-the-request.md)
- [11 · The reconstruction invariant](11-the-reconstruction-invariant.md)
- [12 · The inbox](12-the-inbox.md)
- [13 · Phases, cancellation, and quiescence](13-phases-cancellation-quiescence.md)
- [14 · Agent lifecycle](14-agent-lifecycle.md)

*Tools*
- [15 · The tool registry](15-the-tool-registry.md)
- [16 · The execution pipeline](16-the-execution-pipeline.md)
- [17 · Scheduling a step's tool calls](17-scheduling-tool-calls.md)
- [18 · Approval and sandbox escalation](18-approval-and-escalation.md)

*Prompt and context*
- [19 · Prompt assembly](19-prompt-assembly.md)
- [20 · Variable interpolation](20-variable-interpolation.md)
- [21 · Runtime context injection](21-runtime-context-injection.md)
- [22 · Extension points](22-extension-points.md)

*Model I/O*
- [23 · Adapters and `prepareCall`](23-adapters-and-preparecall.md)
- [24 · Streaming and block assembly](24-streaming-and-assembly.md)
- [25 · Failures and retry](25-failures-and-retry.md)

*Context-window management*
- [26 · Measuring and spilling](26-measuring-and-spilling.md)
- [27 · Pruning and compaction](27-pruning-and-compaction.md)

*Delegation and durability*
- [28 · Subagents](28-subagents.md)
- [29 · Persistence](29-persistence.md)
- [30 · Crash repair and chunk packing](30-crash-repair-and-chunk-packing.md)

### Part IV — The engine in motion
- [31 · One real turn, annotated](31-one-real-turn.md)
- [32 · When things go wrong](32-when-things-go-wrong.md)

### Part V — Extending and changing
- [33 · Adding a tool](33-adding-a-tool.md)
- [34 · Composition in full](34-composition-in-full.md)
- [35 · Limits and fragile areas](35-limits-and-fragile-areas.md)
- [36 · Design decisions](36-design-decisions.md)

### Part VI — Rebuild it
- [37 · A milestone path from an empty folder](37-rebuild-it.md)

### Appendices
- [A · Glossary](appendix-a-glossary.md)
- [B · Data-structure reference](appendix-b-data-structures.md)
- [C · Configuration reference](appendix-c-configuration.md)
- [D · Mechanism index](appendix-d-mechanism-index.md)

---

## Six things worth knowing before you start

Each is established in the book and contradicts a reasonable first assumption.

1. **The reconstruction invariant does not run.** The check that asserts the engine's central guarantee is real, correct, and mounted in no composition layer. It is an executable specification and a test oracle, not a production guarantee. → [Ch 11](11-the-reconstruction-invariant.md)

2. **Compaction never deletes anything.** It appends a summary plus a marker that *shadows* the old range. The raw events stay in the log forever, and a user's scrollback is unaffected. → [Ch 6](06-the-surface.md), [Ch 27](27-pruning-and-compaction.md)

3. **The loop never retries.** It offers an extension point whose default is terminal. Retry and compaction-on-overflow are both plugins. → [Ch 25](25-failures-and-retry.md)

4. **Composition is three layers, not one.** Base → web-app patch (which *disables* most tool rows) → agent preset (which re-mounts them, sometimes with different config). Reading two layers produces confident wrong answers. → [Ch 34](34-composition-in-full.md)

5. **A fresh install cannot complete a single model call.** No provider route is registered until one is configured through the UI. → [Ch 32](32-when-things-go-wrong.md)

6. **`packages/context/**` does not use the prompt-context mechanism.** Despite the name, those packages inject through `agent/pre-step` instead. → [Ch 21](21-runtime-context-injection.md)

---

## Research notes

The `_notes/` directory holds the material the book was written from, kept so the work can be resumed or audited:

| File | Contents |
|---|---|
| [`mechanism-map.md`](_notes/mechanism-map.md) | All 37 mechanisms, an interaction diagram, teaching order, and a "exists but does NOT run" table |
| [`control-flow.md`](_notes/control-flow.md) | Every branch point in the engine core, line-cited |
| [`config.md`](_notes/config.md) | Configuration resolved across all three composition layers |
| [`open-questions.md`](_notes/open-questions.md) | Nine questions, with what was checked; six resolved, one corrected a wrong hypothesis |
| [`evidence-report.md`](_notes/evidence-report.md) | Per-chapter claim audit, dead code found, docs-vs-code contradictions |
| [`progress.md`](_notes/progress.md) | Writing status and conventions |
| [`raw/`](_notes/raw/) | 303 KB of subsystem research across six areas |
