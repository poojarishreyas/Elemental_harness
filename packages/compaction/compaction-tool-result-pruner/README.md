---
description: "Tool-output trimming for deployments composing compaction: choosing size limits or debugging why oversized tool results get shortened."
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-tool-result-pruner

## Summary

`dsh-compaction-tool-result-pruner` keeps the context window from filling up with oversized tool output. When compaction is about to run, it trims over-budget tool results to a bounded head, a short "middle pruned" marker, and a bounded tail, while the full original result stays in the session log for exact replay and inspection. Under ordinary pressure it leaves the newest tool results whole and trims nothing unless the gain is worth a cache rewrite; context-overflow recovery trims every oversized result. When a spill store is mounted, the marker names a file holding the full original, so the model can read back what was cut. Trimming makes no model call and can clear token pressure on its own, so compaction may skip the summary entirely. Character budgets are a heuristic; the token meter decides whether pressure was actually relieved.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package next to `dsh-compaction-basic` when tool output regularly dominates the conversation window. Trimming changes what the model sees — shorter results — and gives compaction less history to condense.

### Smallest working composition

Mount token measurement, this package, and the backend in this order:

```yaml
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
- name: '@deepseek-ai/dsh-compaction-basic'
```

With these rows, oversized tool results are trimmed automatically as part of condensation. You can verify success by checking that future requests show the trimmed results; the full originals remain in the session log.

### What gets trimmed

A tool result whose text exceeds the threshold is replaced by a trimmed version: the configured head, a short "middle pruned" marker, and the configured tail. Rich content such as images and structured blocks keeps its order. The replacement keeps the tool call, step, errors, and metadata — only the text content changes. If a replacement cannot be recorded, the run fails and the trims already applied stay in place.

Which results qualify depends on the trigger:

- **Pressure** — the newest `protectRecentResults` tool results are never trimmed, counted over every current result whatever its size, because they are usually what the model is working with. The remaining candidates are trimmed only if together they remove at least `minTokensSaved` estimated tokens; a smaller gain is not worth invalidating the cached request prefix, so nothing changes.
- **Context overflow** — both safeguards are skipped and every oversized result is trimmed, because the untrimmed request cannot be sent at all.

### Recovering the full original

When a `ctx.spillStore` backend such as `dsh-spill-local` is mounted, the full text of each result about to be trimmed is saved first, and its marker names the saved file with the backend's retrieval guidance. The model can then read or search the removed middle. Saving is best-effort: without a backend, after a failed save (logged as a warning), or when the longer marker would not fit the budget, the plain marker is used. The saved file holds the result's text blocks only; rich blocks stay in the trimmed result itself.

### Setting the size limits

All settings are optional. The defaults trim any result with more than 8,192 text characters to its first 4,096 plus its last 1,024, joined by the marker; under pressure they keep the newest 5 results whole and act only when at least 20,000 tokens would be removed. Those two pressure defaults follow Claude Code's tool-result clearing and opencode's prune minimum. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-compaction-tool-result-pruner) is the exhaustive source.

| Field | Default | Meaning |
|---|---|---|
| `thresholdChars` | `8192` | Trim when combined text exceeds this many Unicode code points. |
| `headChars` | `4096` | Leading Unicode code points retained. |
| `tailChars` | `1024` | Trailing Unicode code points retained. |
| `protectRecentResults` | `5` | Newest tool results a pressure pass never trims. |
| `minTokensSaved` | `20000` | Estimated tokens a pressure pass must remove, or it trims nothing. |

Character counts are Unicode code points, so slicing never splits an emoji pair, though a multi-character grapheme can still be cut. The head plus the plain marker plus the tail must fit within the threshold, so a valid configuration trims every over-budget result without growth or repeated rewriting. An unknown setting rejects the plugin at construction.

### When trimming runs

Trimming only runs when a compaction trigger qualifies: `dsh-compaction-basic` invokes it with the trigger after pressure or overflow is confirmed, before it selects what to condense. Below pressure nothing is trimmed, and trimming itself makes no model call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the pruner; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The pruner is built on three commitments:

- **Deterministic one-pass convergence.** Slicing is by Unicode code point with fixed budgets, so every emitted result has exactly the configured head, marker, and tail in text code points, is no larger than `thresholdChars`, and is strictly smaller than the triggering input.
- **Replay-safe replacement.** The original event remains in the append-only log; the replacement cites it through `sourceEventSeqs`, so replay recovers the exact input that produced the pruned result.
- **The shadow-price protocol.** `compaction/prune` immediately precedes its replacement, pricing the exact replaced range through the injected token meter so pure consumers subtract it without per-node state — the shared protocol documented on the `compaction/prune` event.

### Pruning mechanics

Pruning measures `text` blocks by Unicode code point (non-text blocks cost zero), produces a bounded replacement — or none when content is already within budget — and swaps each selected tool result for one newly appended `tool/result` that replaces the original event and cites it through `sourceEventSeqs`, immediately preceded by a `compaction/prune` shadow-price event. Non-text blocks keep their original relative positions, and slicing never splits a UTF-16 surrogate pair. Exact signatures are in [`src/index.ts`](src/index.ts).

A pass runs in three phases. **Plan** snapshots the current surface, applies the trigger's safeguards, and prices each plain-marker replacement with the token meter; the minimum-gain check uses that plain-marker estimate. **Save** awaits the optional spill store for each planned original; no event is appended while saves are in flight. **Commit** appends every replacement synchronously, skipping any result that left the surface during the saves. A session that rejects a replacement fails the run; replacements committed earlier in the pass stay durable, and saved files for uncommitted replacements remain as orphans.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `ToolResultPruner` service, `pruneSession` / `pruneContent` / `measureContent` |
| [`src/config.ts`](src/config.ts) | `PRUNE_MARKER`, `spillMarker`, defaults, code-point counting, budget validation |
| [`src/types.ts`](src/types.ts) | `ToolResultPruneConfig`, `ResolvedConfig`, `PrunedEntry`, `PruneResult` |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; replacements are observable in the session log) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the consuming backend to the shared seam and the pricing service.

- [Compaction basic backend](../compaction-basic/README.md) — the backend that trims oversized tool outputs before condensing.
- [Compaction seam](../compaction/README.md) — the condensation contract this package plugs into.
- [Compaction subsystem reference](../../../docs/subsystems/compaction.md) — the condensation vocabulary, results, and service behavior.
- [Token meter](../../llm/token-meter/README.md) — the measurement service that decides whether trimming relieved pressure.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-compaction-tool-result-pruner) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Pruned tool result

#### What the model sees

Once a compaction trigger qualifies, future requests see the retained head, a marker, and the retained tail in place of the removed text. With a stored original the marker is `\n\n[... tool result middle pruned. Full result stored at: <locator>. <retrieval guidance> ...]\n\n`; `dsh-spill-local` supplies a file path and `Use read with offset/limit, or grep this path to search within it.` Without one the marker is `\n\n[... tool result middle pruned ...]\n\n`. Rich blocks keep their order. The model does not see a second copy of the original unless it reads the stored file.

#### Token effect

Each rewritten tool result has at most `thresholdChars` text code points. Pruning itself makes no model call; compaction-basic skips summarization when the remeasured request falls below pressure, otherwise the summarizer reads the pruned surface. Reading a stored original back costs the tokens of whatever the model reads.

#### KV Cache effect

Replacing an earlier result invalidates reuse from the first changed token. The pressure safeguards limit how often that happens: protected recent results stay byte-identical, and a pass whose estimated gain is below `minTokensSaved` changes nothing. The pruned prefix is eligible for reuse while its route, envelope, and preceding history remain identical.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when trimming is a poor fit or needs special care; they are the current package constraints.

- **Character budgets are not token budgets** — provider token density varies, so `ctx.tokenMeter` remains the authority for deciding whether trimming relieved request pressure.
- **Pruning is syntactic** — it retains the beginning and end without interpreting which middle lines are semantically important.
- **Grapheme clusters can split** — code-point slicing protects surrogate pairs but does not perform locale-aware grapheme segmentation.
- **Protected results can still cause overflow** — under pressure the newest results are never trimmed, so a single huge recent result is only trimmed once the provider reports a context overflow.
- **Stored originals are not cleaned up by the pruner** — saved files follow the spill backend's retention; a file saved for a replacement that never committed is an orphan until that cleanup runs.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative; shipped behavior lives in the sections above, the package code, and the linked Agent Notes.

- **Semantic middle selection, undecided** — pruning keeps the head and tail blindly; interpreting which middle lines matter would need a model or structured heuristics, neither of which ships.
- **Token-based budgets, deferred** — budgets are Unicode code points; switching to token-based budgets would require an estimator contract the token meter does not expose.

</details>
