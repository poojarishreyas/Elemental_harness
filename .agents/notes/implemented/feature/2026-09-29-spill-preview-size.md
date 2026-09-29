# Agent Note: Spilled tool results keep a 2 KB preview instead of a full-budget one

Status: implemented

## Problem

`dsh-spill-policy` used one number for two jobs: `maxInlineBytes` decided when a result spills to a file, and it was also the size of the preview left in context. With the shipped `maxInlineBytes: 50000`, a 60 KB tool output was saved to a file and then replaced by roughly 50 KB of preview — about 12,500 tokens staying in context for an output the model could now read from disk on demand. Spilling saved almost nothing for outputs just over the threshold.

The compaction work in this series started by asking whether the spill threshold itself should be lower. Claude Code (v2.1.281, read from the installed binary) clamps each tool's persistence threshold to 50,000 characters (`FU = 50000`; most tools declare 100,000 and are clamped), so our 50,000-byte threshold already matches it. The difference is the preview: Claude Code replaces a persisted result with its first 2,000 characters plus the file path.

## Decision

`dsh-spill-policy` gains `previewBytes`: the UTF-8 size of the replacement — head/tail preview plus the storage notice — for a spilled result. `maxInlineBytes` still decides when to spill. `previewBytes` must be a non-negative integer no larger than `maxInlineBytes`, checked at load; omitted, it equals `maxInlineBytes`, which is the previous behavior. The notice is reserved out of `previewBytes` first, and if the notice alone does not fit, the original result stays inline, as before.

`dsh-base` ships `maxInlineBytes: 50000` and `previewBytes: 2000`. The preview stays head-plus-tail rather than Claude Code's head-only, so a log's final status or error remains visible.

## Alternatives considered

**Lower `maxInlineBytes`.** Rejected: the threshold already matches Claude Code's cap, and without usage data there is no evidence for a different number. A lower threshold with the old full-budget preview would also still keep that many bytes in context.

**Head-only preview, as Claude Code does.** Rejected: build and test output puts the verdict at the end, and `dsh-output-retention` already provides head/tail retention; the tail costs part of the same 2,000 bytes.

**Make the small preview the package default instead of a `dsh-base` setting.** Rejected: the package has no default for `maxInlineBytes` either, and every existing composition that sets only `maxInlineBytes`, including the snapshot overlays, keeps its behavior.

## Consequences

- A spilled result costs about 500 tokens in context instead of up to about 12,500, and the model reads the file for the middle when it needs it; that trade costs extra `read` or `grep` calls when the preview is not enough.
- Results between 2 KB and 50 KB are unaffected: they are below the spill threshold and stay inline.
- A patch that replaces the `spill-policy` row's config without `previewBytes` returns to a full-budget preview, because patches replace a row's whole config.
- The durable `run_code` sub-call log copy uses the same replacement, so it shrinks too.

## Related

- [Tool output spill files](../architecture/2026-07-08-tool-output-spill-files.md) — the spill seam and policy this setting extends.
- [Tool-result pruner keeps recent results, skips small gains, and stores originals](2026-09-29-pruner-recency-gain-and-stored-originals.md) — phase 1; the same recover-from-file approach for trimmed results.
