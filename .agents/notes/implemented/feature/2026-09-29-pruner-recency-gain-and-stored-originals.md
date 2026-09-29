# Agent Note: Tool-result pruner keeps recent results, skips small gains, and stores originals

Status: implemented

## Problem

The tool-result pruner trimmed every current tool result over `thresholdChars` whenever compaction qualified. That included the result the model was working with at that moment, so a pressure pass could cut the middle of the output the next step depended on. Every pass also rewrote the request prefix even when it removed only a few hundred tokens, costing a provider cache miss for little gain. And the removed middle was gone for the model: the full original stayed in the session log for replay, but no tool could reach it, so the model had to guess or rerun the command.

Two other coding harnesses handle this differently. Claude Code (v2.1.281, read from the installed binary) keeps the newest 5 tool results when clearing, clears only when at least 20,000 tokens would be freed, and replaces a cleared result with a pointer to a saved copy. opencode protects the newest 40,000 tokens of tool output and the last two user turns, and prunes only when at least 20,000 tokens would be freed, though it replaces the whole output with no way back.

## Decision

`pruneSession(session, trigger)` is asynchronous and takes the `CompactionTrigger` that qualified the pass; `dsh-compaction-basic` passes its own trigger through.

- **Recency protection.** Under `pressure`, the newest `protectRecentResults` current tool results (default `5`) are never trimmed. The count covers every tool result on the surface, whatever its size.
- **Minimum gain.** Under `pressure`, the pass lands nothing unless its plain-marker replacements would remove at least `minTokensSaved` estimated tokens (default `20000`), priced by `ctx.tokenMeter.estimateMessage`.
- **Overflow bypass.** Under `context-overflow`, both safeguards are skipped: the untrimmed request cannot be sent, so keeping a recent result exact has no value.
- **Stored originals.** When `ctx.spillStore` is mounted, each selected original's text is saved before any append, and the marker becomes `[... tool result middle pruned. Full result stored at: <locator>. <retrieval guidance> ...]`. A missing store, a rejected save (logged), or a marker too long for `headChars + marker + tailChars <= thresholdChars` falls back to the plain `[... tool result middle pruned ...]` marker.
- **Commit after saves.** The pass plans on a surface snapshot, awaits the saves, then appends all replacements synchronously and skips any result that left the surface while saves were in flight. The shadow-price protocol (`compaction/prune` immediately before its replacement) is unchanged.

Both defaults come from the prior art above rather than from measurements on this harness; they are validated `Config` fields so a deployment can tune them.

## Alternatives considered

**Protect by tokens instead of by count.** opencode protects the newest 40,000 tokens of tool output. A token budget adapts to output size, but it can protect a single huge result and nothing else, which is exactly the result pressure trimming most needs to consider. A count matches Claude Code and is predictable; a token budget can be added later if sessions show the count is wrong.

**Apply the safeguards on overflow too.** Rejected: when the newest result itself overflows the window (a large `read`, which `dsh-spill-policy` deliberately never spills), protection would leave overflow recovery unable to shrink the request, and the retry would fail again.

**Replace the whole result with the pointer, as Claude Code does.** Rejected for now: keeping the head and tail lets the model see the command's start and its final status without a tool call, and the stored copy covers the rest. Whole replacement would save more tokens and could be a later option.

**Summarize each pruned middle with a model.** Rejected for this change: it would add a model call to a pass whose value is being free and deterministic. The stored copy gives exact recovery instead of a lossy description.

**Save originals inside the session log instead of the spill store.** The log already holds every original, so a `history_read` tool could serve them without new files. That is the larger design in the [recallable compaction proposal](../../proposed/feature/2026-07-06-recallable-compaction.md); reusing the existing spill seam gives the model a readable file today with the tools it already has.

## Consequences

- The model keeps its most recent tool output exact under pressure and can read back any trimmed middle when a spill store is mounted, which the shipped web presets provide through `dsh-spill-local`.
- Fewer pressure passes rewrite the request prefix, so fewer provider cache misses; a pass that would remove little now changes nothing, and compaction may summarize instead.
- A single huge recent result is trimmed only after the provider reports overflow, one failed request later than before.
- Pruning can write files. They follow the spill backend's retention; a file saved for a replacement that never committed is an orphan until that cleanup runs.
- `pruneSession` is asynchronous with a required trigger, so every caller changed; `dsh-compaction-basic` is the only production caller.

## Related

- [Tool output spill files](../architecture/2026-07-08-tool-output-spill-files.md) — the spill seam the stored originals reuse.
- [After-call compaction pressure and overflow recovery](../architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md) — the two triggers the safeguards distinguish.
- [Compaction summary prefix-cache reuse](../bug-fix/2026-07-21-compaction-summary-prefix-cache-reuse.md) — why avoiding needless prefix rewrites matters.
