# Chapter 1 · The core idea in one page

**What you'll learn:** the single design decision that explains almost everything else in this engine, and what it buys.

**Prerequisites:** none. No code in this chapter.

---

## The engine, in one sentence

An **agent** here is a loop that talks to a language model, runs the tools the model asks for, feeds the results back, and repeats until the model stops asking. That much is ordinary. What makes this particular engine worth studying is *where it keeps its state*.

Most programs of this shape hold the conversation in memory — an array of messages that grows as the turn proceeds. This engine does not. It keeps an **append-only log of events**, and every request it sends to the model is *recomputed from that log* immediately before dispatch.

Nothing is ever overwritten. Nothing is deleted. The log only grows.

## Why that is not a detail

If the conversation lives in an in-memory array, then a handful of things you would like to do are all awkward in the same way. Resuming a crashed session means reconstructing that array from something. Forking a conversation means deep-copying it and hoping nothing shared leaks. Trimming an over-long history means mutating it in place, which destroys the thing you might need to show a user later. Replaying a session for a test means faking the array.

If the conversation is instead *derived* from a log, all four become the same operation: read the log, fold it forward. Resume reads the log from disk. Fork copies a prefix. Trimming appends a marker saying "these old entries are superseded by this summary" — and the raw entries stay exactly where they were. Replay re-folds a recorded log.

The engine takes this seriously enough that the rule has a name in the codebase and a mechanical check behind it. The check asserts that the messages in an outgoing request are byte-identical to what re-deriving the log produces at that moment. When it fails, the error says **"log-reconstruction desync"** — the request drifted from its source of truth.

*(That check ships as a diagnostic companion. It is real, runnable code, and it is the clearest statement of the contract — but it is not switched on in the shipped configuration. Chapter 11 is precise about this.)*

## The shape that follows

Three consequences run through the whole book, and it is worth having them in mind from the start.

**Writing to the log is how you change anything.** A user's message, the model's reply, a tool call, a tool's result, even the boundaries of a turn — all of them are events appended to the log. If something is going to be visible to the model, it is logged first. There is no side channel.

**History is rewritten by addition, not subtraction.** When the conversation grows too long for the model's context window, the engine does not delete old messages. It appends a summary plus a marker saying which range that summary stands in for. A view over the log — the **surface** — honors the marker and hides the superseded range. The raw events remain on disk forever. This one indirection is what makes compaction safe, and it is the subject of Chapter 6.

**The loop itself is small and does almost nothing clever.** The core is under 1,800 lines. It does not know how to retry a failed request, or how to shrink an oversized conversation, or what a subagent is. All of that lives in plugins that hook well-defined points in the loop. When you read the loop expecting to find the retry logic and it is not there, that is not an omission — it is the design. Chapter 25 shows who actually retries.

## What this book does

It explains the machinery, mechanism by mechanism: what happens inside, step by step, and why. Every claim is tied to real code at a real line. Where the code and the documentation disagree, the code wins and the disagreement is noted. Where something could not be confirmed, it is marked ❓ Unknown rather than smoothed over.

By the end you should be able to rebuild the core from an empty folder. Part VI lays out that path explicitly.

---

## Key takeaways

- Every model request is recomputed from an append-only event log rather than read from an in-memory transcript.
- That single decision is what makes resume, fork, compaction, and replay into variations of one operation.
- History is rewritten by appending a superseding marker, never by deleting — the raw log is permanent.
- The loop is deliberately small; retry, compaction, delegation, and tooling are plugins hanging off documented extension points.

## Exercises

1. Before reading on, write down how *you* would implement "the conversation got too long, shorten it" if the conversation were a plain array of messages. Keep your answer; compare it to Chapter 27.
2. Name three things that become difficult if a request is allowed to contain a message that was never written to the log. (Chapter 11 gives one answer you probably will not have listed.)

**Next:** [Chapter 2 · Just enough architecture](02-just-enough-architecture.md)
