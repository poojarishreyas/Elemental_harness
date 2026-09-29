# Agent Note: Compaction checkpoints keep user messages, security constraints, and explicit merge rules

Status: implemented

## Problem

The compaction instruction asked for goals, files, errors, pending work, and critical context, but nothing guaranteed that the user's own words survived. A correction or a "never touch that file" instruction could be paraphrased away in one checkpoint and be gone after the next. The next-step field named an action without anchoring it to what was actually happening, so a resumed model could drift to an older or tangential task. Repeated compactions also relied on a single sentence about merging a prior checkpoint, which said nothing about what happens to facts the newer messages do not mention.

Claude Code's compaction prompt (v2.1.281, read from the installed binary) lists all non-tool user messages, requires security-relevant user instructions to be preserved verbatim, and asks for verbatim quotes showing where the work left off. opencode's prompt gives explicit rules for combining a prior summary: carry forward what newer messages omit, let newer messages win on conflict, and move finished work out of the active sections.

## Decision

`COMPACTION_INSTRUCTION` in `dsh-compaction-basic` adds four things and keeps everything else, including the exact-replay design that reuses the provider's prefix cache:

- **`## User Messages`** — every non-tool user message, oldest first, quoted verbatim, with only long pasted content shortened and marked `[...]`.
- **Security constraints** — a rule to preserve verbatim every security-relevant user instruction (files or data to avoid, forbidden operations, credential or secret handling) and record it under `## Critical Context`.
- **Anchored next step** — `## Next Step` now carries a verbatim quote from the latest messages showing where the work left off.
- **Merge rules** — a prior `<compacted-summary>` is described as discarded once replaced; goals, user messages, directives, constraints, and decisions carry forward even when newer messages omit them; newer messages win on conflict; finished work moves out of `## Pending Jobs` and `## Current Work`.

The README documents the instruction verbatim, and a test asserts the text sent to the summarizer equals that README block. Quoted user messages are exact literals, which the [English checkpoint register](../bug-fix/2026-07-31-english-compaction-checkpoints.md) already exempts from translation.

## Alternatives considered

**Adopt Claude Code's full prompt, including an `<analysis>` scratchpad.** Rejected: the scratchpad spends output tokens under the 8,192-token `maxTokens` cap on text that is stripped afterwards, and our summarizer already runs with the model's own reasoning. The sections that carry user intent were the part worth taking.

**Keep user messages only in `## Primary Request and Intent`.** Rejected: that section is a paraphrase of goals by design, and paraphrase is exactly how corrections and constraints were lost.

**Pin security constraints in a separate durable event instead of the prompt.** A dedicated event would survive every compaction mechanically, but it needs a detector for which messages are security constraints. The prompt rule has no false-negative guarantee either, so it is the cheap first step; a durable pin can follow if checkpoints still drop constraints.

## Consequences

- Checkpoints are longer, mostly by the size of the user's messages, and still bounded by `maxTokens`. Long sessions with many large pastes rely on the `[...]` shortening rule.
- User corrections, constraints, and the current task anchor survive repeated compaction in the user's own words instead of a paraphrase.
- The instruction is the only changed input; the replayed system prompt, tools, and messages are byte-identical, so prefix-cache reuse is unchanged.
- The rules are model instructions, not enforcement: a summarizer can still omit a message, and nothing validates the output sections.

## Related

- [Tool-result pruner keeps recent results, skips small gains, and stores originals](2026-09-29-pruner-recency-gain-and-stored-originals.md) — phase 1 of the same compaction work.
- [Compaction summary prefix-cache reuse](../bug-fix/2026-07-21-compaction-summary-prefix-cache-reuse.md) — why only the trailing instruction may change.
