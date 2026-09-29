# Chapter 37 · Rebuild it

**What you'll learn:** a milestone path from an empty folder to a working engine, each step adding one mechanism, with the real files to compare against and a way to tell it works.

**Prerequisites:** all of Part III, at least skimmed.

---

## How to use this

Ten milestones. Each adds **one** mechanism, in dependency order. Each names the real files that implement it, a test you can write without a provider, and the trap that milestone exists to avoid.

You do not need this repository's framework. Milestones 1–7 are plain TypeScript with no plugin system at all; the composition machinery only becomes necessary at milestone 9, and only if you want more than one agent configuration.

A deliberate ordering note: **the plugin framework comes last, not first.** Building the loop against concrete dependencies and extracting seams once you know where they belong is a better path than starting with a plugin system and discovering which seams you needed.

---

## Milestone 1 · The log

**Build.** A `Session` class holding `SessionEvent[]`, with one method:

```ts
append(type, data): SessionEvent   // seq = log.length, frozen, deep-snapshotted
get events(): readonly SessionEvent[]
```

Event types: `turn/start`, `turn/end`, `step/start`, `step/end`, `user/message`, `assistant/message`, `tool/call`, `tool/result`.

**Real files.** `packages/core/session/src/index.ts:602-653`, types at `src/types.ts:216-320`.

**Test it.** Append ten events; assert `seq` is `0..9` with no gaps and every event is frozen. Assert that mutating the object you passed in does not change the logged copy.

**The trap.** Storing a reference instead of a snapshot. Callers reuse objects; without a deep copy your history mutates under you, and the bug surfaces as a session that replays differently than it ran.

---

## Milestone 2 · Derivation

**Build.** `deriveMessages(): Message[]` — walk the log, project `user/message`, `assistant/message`, and `tool/result` into messages, and skip everything else.

**Real files.** `packages/core/session/src/surface.ts:83-114` (the per-event rule), `index.ts:724-745` (the walker).

**Test it.** Log a turn's worth of events including boundaries; assert `deriveMessages()` returns only the message-producing ones, in order.

**The trap.** Adding formatting here. Wrap a plugin message in tags at *append* time, never at derive time — otherwise changing the formatting changes the meaning of every session recorded under the old rule ([Ch 7](07-from-log-to-request.md)).

---

## Milestone 3 · The 100-line loop

**Build.** [Chapter 4](04-the-engine-in-100-lines.md)'s `MinimalAgent`: a driver over turns, a turn over steps, and a step that derives messages, calls a model, and appends the result. Use a mock adapter returning a fixed response.

**Real files.** `packages/core/agent-loop/src/agent.ts:219-438`.

**Test it.** A mock adapter returning one text block. Assert the log contains `turn/start`, `step/start`, `user/message`, `assistant/message`, `step/end`, `turn/end` in that order, and that the mock received exactly the messages `deriveMessages()` returns.

**The trap.** Keeping `this.messages` alongside the log. The moment those two can disagree, you have lost the property the whole design is for.

---

## Milestone 4 · Tool calls

**Build.** After appending the assistant message, filter for `tool-call` blocks. For each: append `tool/call`, execute, append `tool/result` citing the call's seq. Return "no ending yet" so the turn runs another step.

**Real files.** `packages/core/agent-loop/src/tool-calls.ts` (start with the sequential path), `packages/core/tools/src/index.ts:1028-1053`.

**Test it.** A mock returning one tool call, then a text answer. Assert the turn has two steps and the second request's messages include the tool result.

**The trap.** Forgetting that `null` from a step means *continue*. If a step that ran tools returns an ending, the model never sees its results.

Also: parse arguments defensively. Invalid JSON should reach the tool as a raw string and become a readable error, never a crash ([Ch 17](17-scheduling-tool-calls.md)).

---

## Milestone 5 · The surface

**Build.** Add `nodes: number[]` and `replaceGeneration`. Require `surfaceOp` on the three eligible event types. Implement `replace` as a splice. Make `deriveMessages()` walk `nodes` rather than the log.

**Real files.** `packages/core/session/src/surface.ts` in full.

**Test it.** Log five messages; replace the middle three with one; assert the surface has three nodes, `replaceGeneration` incremented, and **all five original events are still in the log at their original positions**.

**The trap.** Letting a replacement cite less than it shadows. Require the coverage rule from day one ([Ch 6](06-the-surface.md)) — retrofitting provenance later means every replacement written before it is unattributable.

---

## Milestone 6 · Streaming

**Build.** A `BlockAssembler` keyed by block index. Log every chunk as its own event. Handle `block-end` as authoritative. Drop tool calls when the finish reason is `max-tokens`.

**Real files.** `packages/llm/llm/src/assembler.ts`, types at `src/types.ts:364-376`.

**Test it.** Feed interleaved chunks — block 1's deltas before block 0's `block-end` — and assert both blocks assemble correctly. Feed a truncated tool call with `max-tokens` and assert it is dropped.

**The trap.** Keying by arrival order. Blocks interleave; the index is the identity ([Ch 24](24-streaming-and-assembly.md)).

---

## Milestone 7 · Cancellation

**Build.** An `AbortController` per turn. Check it before each boundary append. On abort: salvage text/reasoning blocks into an `interrupted: true` message, drain started tools, and synthesize results for unstarted ones.

**Real files.** `packages/core/agent-loop/src/agent.ts:143-232`, `tool-calls.ts:238-260`.

**Test it.** Abort mid-stream. Assert the log is **balanced** — every `step/start` has a `step/end`, every `tool/call` has a `tool/result` — and that a fresh request built from the cancelled session is valid.

**The trap.** Abandoning unstarted tool calls. A `tool/call` with no result makes the *next* request invalid, so a cancelled session cannot be resumed. This is the milestone where "resumable" starts being true or false.

---

## Milestone 8 · The inbox and step boundaries

**Build.** Two queues, `next-turn` and `next-step`, as a replay of `agent/inbox/spliced` events. `claim(target)` drains all of `next-step` and pops **one** from `next-turn`. Wire `followup` / `steer` / `inject`.

**Real files.** `packages/core/agent/src/inbox.ts`, `agent-loop/src/agent.ts:122-141`.

**Test it.** Call `inject` on an idle agent; assert **no turn starts** and only the splice event is logged. Then `steer` and assert the message is claimed at the next step boundary.

**The trap.** Making the queue a plain array. Then a crashed agent loses pending input, and the reason the queue is durable — it *is* the log — is lost.

---

## Milestone 9 · Prompt assembly and extension points

**Build.** A registry of named prompt sections with numeric orders, rendered by order and joined. A `waterfall(listeners, payload, default)` where each listener gets a `next`. Convert your hardcoded step logic into an `agent/pre-step` waterfall whose innermost default is the current behavior.

**Real files.** `packages/core/system-prompt/src/index.ts:536-611`, `vendor/cordis/src/events.ts:234-243`, `packages/core/agent/src/dispatch.ts`.

**Test it.** Register two sections with different orders; assert deterministic output. Register a waterfall listener that returns without calling `next()`; assert the default behavior did **not** run.

**The trap.** Assuming listeners always delegate. The veto is the point — and it means anything living in the innermost default can be suppressed ([Ch 21](21-runtime-context-injection.md), [Ch 22](22-extension-points.md)).

---

## Milestone 10 · Compaction

**Build.** A token estimate over the surface. At a threshold, select a range that retains recent history and does not split a tool call from its result. Summarize it with a model call. Commit as a `replace` citing every shadowed node. Refuse to commit if the summary is not smaller.

**Real files.** `packages/compaction/compaction-basic/src/region.ts:154-256`, `src/index.ts:259-333`.

**Test it.** Build a long session; compact; assert the surface shrank, the log did not, `replaceGeneration` incremented, and `deriveMessages()` returns the summary in place of the range. Then assert a second compaction of an already-terse session is **refused**.

**The trap.** Splitting a tool-call/result pair. The next request will be rejected by the provider, and the cause will look like a model problem rather than a boundary-selection bug.

---

## What you will have

An engine that resumes, forks, cancels cleanly, and compacts — around 1,500–2,000 lines.

What the shipped engine adds beyond this, and where to read it:

| Not in the ten milestones | Chapter |
|---|---|
| The four-stage tool pipeline and approval | [16](16-the-execution-pipeline.md), [18](18-approval-and-escalation.md) |
| Parallel scheduling with ordered commits | [17](17-scheduling-tool-calls.md) |
| Adapter resolution and prepared calls | [23](23-adapters-and-preparecall.md) |
| Retry as a listener | [25](25-failures-and-retry.md) |
| Spill and pruning | [26](26-measuring-and-spilling.md), [27](27-pruning-and-compaction.md) |
| Subagents | [28](28-subagents.md) |
| Persistence, crash repair, chunk packing | [29](29-persistence.md), [30](30-crash-repair-and-chunk-packing.md) |
| Presets, realms, and scope layering | [34](34-composition-in-full.md) |

Each is genuinely optional. None is needed to demonstrate the central property — and that is the strongest evidence that the property is the design, rather than a consequence of the size.

---

## Key takeaways

- Ten milestones, in dependency order; the first seven need no plugin framework.
- Build the loop first and extract seams once you know where they belong.
- Milestone 5 (the surface) is the point where compaction becomes possible without loss.
- Milestone 7 (cancellation) is where "resumable" becomes true or false.
- Every milestone has a trap that produces a bug you will find much later than you introduced it.

## Exercises

1. Do milestones 1–3. Then write the test from milestone 3 that asserts the mock received exactly `deriveMessages()`. Keep it green for the rest.
2. At milestone 5, retrofit the surface onto milestone 4's tool results. What breaks, and what does that tell you about introducing it earlier?
3. Skip milestone 7 and go straight to 8. Build a session, cancel it mid-tool, resume. Describe the exact failure — and then say which of the three pieces of milestone 7 would have prevented it.

**Next:** [Appendix A · Glossary](appendix-a-glossary.md)
