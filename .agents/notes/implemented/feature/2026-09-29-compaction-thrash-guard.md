# Agent Note: Automatic compaction stops a turn that keeps refilling the context

Status: implemented

## Problem

When one file or tool output is nearly as large as the space compaction can free, the context refills to the threshold almost immediately after every compaction. A long agentic turn then pays for a summarization call on nearly every step, the summaries lose more history each time, and nothing tells the user why the session has become slow and expensive. Before this change `dsh-compaction-basic` had no limit on that loop.

Claude Code (v2.1.281, read from the installed binary) guards against it: when the context refills to the limit within 3 turns of the previous compaction, 3 times in a row, it stops with "Autocompact is thrashing … A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use /clear to start fresh."

## Decision

The automatic `agent/pre-step` pressure listener keeps, per agent, the number of steps since its last pressure compaction and how many compactions in a row followed the previous one within `thrashWindowSteps` (default `3`). When that rapid count reaches `thrashLimit` (default `3`; `0` disables), the listener throws `CompactionThrashError` after the compaction commits. The agent loop ends the turn with `{ kind: 'error' }` carrying the message, exactly like a failed model request, and the agent stays usable. The count resets when the guard trips and whenever a compaction comes outside the window.

The count is in model steps, not user turns, because a single turn can run many steps and is exactly where the loop burns tokens. Only automatic pressure compactions count; overflow recovery and `/compact` are not tracked.

## Alternatives considered

**Return `{ kind: 'reject' }` from the pre-step waterfall.** That ends the turn as `blocked`, which carries no reason, so the user would see the turn stop without knowing why. An error turn end shows the explanation through the existing error presentation.

**Skip compaction instead of stopping the turn.** The next request would overflow and fail with a provider error that does not name the cause, after one more expensive request.

**Count user turns, as Claude Code does.** Claude Code's "turn" is its query-loop iteration, which corresponds to our model step; counting our user turns would let a single long turn thrash without limit.

**Persist the count in the session log.** It would survive restarts, but the guard protects a live loop from burning tokens; after a restart the loop is not running, and a durable counter would need its own event and replay rules.

## Consequences

- A thrashing turn stops after the third rapid refill with an actionable message instead of running on; the compaction that triggered the stop still stands.
- A legitimately busy turn whose context refills quickly for other reasons can be stopped too; `thrashLimit: 0` turns the guard off and the two settings tune it.
- The count is process memory keyed by the live `Agent`, so it resets on restart.

## Related

- [After-call compaction pressure and overflow recovery](../architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md) — the pressure listener this guard extends.
- [Compaction checkpoints point to a stored transcript and re-attach recently read files](2026-09-29-checkpoint-transcript-and-restored-files.md) — phase 3 of the same compaction work.
