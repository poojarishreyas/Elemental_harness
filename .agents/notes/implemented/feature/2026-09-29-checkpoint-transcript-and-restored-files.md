# Agent Note: Compaction checkpoints point to a stored transcript and re-attach recently read files

Status: implemented

## Problem

After a compaction checkpoint the model had only the summary. Every exact detail the summary dropped — an error string, a code snippet, a value the user gave — was gone from its reach, even though the session log still held it, because the JSONL log is compressed (Zstandard by default, gzip in the web profile) and not readable with the model's tools. The files the model had been working with also disappeared from context, so its first move after a checkpoint was usually to read them again.

Claude Code (v2.1.281, read from the installed binary) handles both: its continuation message says "If you need specific details from before compaction … read the full transcript at: <path>", and it re-attaches up to 5 recently read files, capped at 5,000 tokens each and 50,000 in total.

## Decision

`dsh-compaction-basic` appends optional recovery context after the framed summary in the checkpoint message, built by `src/continuation.ts`:

- **Stored transcript.** With a `ctx.spillStore` backend, the condensed span's messages are rendered as a labeled plain-text transcript (`[User]:`, `[Assistant]:`, `[Tool call <id>]:`, `[Tool result <id>]:` …), saved, and named in one line with the backend's retrieval guidance. The spill source uses tool name `compaction` and the call id `compaction:<compactionId>` as descriptive labels, since a transcript belongs to no tool call.
- **Re-attached files.** With a `ctx.fs` backend, the log is scanned for successful `read` calls — `tool/call` events paired with a non-error `tool/result`, and non-error `tool/code-dispatch` sub-calls inside `run_code`. Paths read again after the condensed span are skipped because the retained tail still holds them. Up to `restoreFileCount` most recent paths are resolved against the session directory and re-read from disk; each is cut at a line boundary to `restoreFileTokens`, and the block is kept within `restoreTotalTokens`. Unreadable files are skipped.
- **Shrink guarantee.** The bare framed summary must still price below the span it replaces. The continuation then receives the remaining budget and prices each block as its own message; because the token meter prices a message as its blocks plus one role overhead, the summed per-block prices bound the blocks' price inside the checkpoint from above, so the extended checkpoint always shrinks. The transcript line takes priority over files.

Defaults (5 / 5,000 / 50,000) follow Claude Code and are validated `Config` fields. The recovery text is part of the checkpoint `user/message`, so it is logged and replay reproduces it.

## Alternatives considered

**Point the model at the session log instead of storing a transcript.** Rejected: logs are compressed by default and in every shipped profile, and even uncompressed they are event JSON rather than readable conversation. A rendered transcript through the existing spill seam is readable with `read` and `grep` today.

**A `history_read` tool over the log.** This is the [recallable compaction proposal](../../proposed/feature/2026-07-06-recallable-compaction.md). It avoids duplicate storage and could address spans precisely, but it is a new model-facing tool with its own schema, permissions, and prompt cost. The transcript file delivers most of the recall value with tools the model already has.

**Re-attach files as they were when read, from the logged `read` results.** Rejected: the logged copy may be stale after edits, and the model's next action is usually to edit the file. Current content from disk is what it needs; the heading says the content may differ from what was read.

**Track reads through `fs-observation-policy`.** It records observations for its guards but exposes no API, and adding one would widen a policy plugin into a query service for one consumer. The log already records every read with its path.

## Consequences

- The model can recover exact pre-checkpoint details by reading one file, and resumes with its working files in context instead of spending the first steps re-reading them.
- Checkpoints are larger when files are attached, bounded by the budget; compaction still frees at least one token of pressure per checkpoint by construction, but frees less than before when files are attached.
- Transcripts are saved before the checkpoint commits, so a failed or cancelled compaction leaves an orphan file for the spill backend's retention to remove.
- Compaction now reads the filesystem. A sandboxed backend that denies a path simply skips that file.
- `RegionDependencies.continuation` is required, so any future caller of the region transaction must supply it.

## Related

- [Tool-result pruner keeps recent results, skips small gains, and stores originals](2026-09-29-pruner-recency-gain-and-stored-originals.md) — phase 1; stores trimmed tool results through the same spill seam.
- [Compaction checkpoints keep user messages, security constraints, and merge rules](2026-09-29-compaction-checkpoint-user-messages-and-merge-rules.md) — phase 2; what the summary itself carries.
- [Tool output spill files](../architecture/2026-07-08-tool-output-spill-files.md) — the spill seam reused here.
