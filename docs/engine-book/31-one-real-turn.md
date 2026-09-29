# Chapter 31 · One real turn, annotated

**What you'll learn:** every mechanism in this book, in motion, across one captured session — 25 lines of real log, start to finish.

**Prerequisites:** Part III. This chapter assumes the mechanisms and shows them cooperating.

---

## The session

`snapshots/session/text-turn/` is a recorded session held in the repository as a replay fixture. The prompt was:

> Reply with exactly the word: PONG. Do not use any tools.

It is about the smallest possible complete turn: no tools, one model call, one answer. That is why it is a good specimen — every event present is one the engine cannot skip.

**The fixture is normalized.** Session ids, paths, message ids, and the two largest payloads appear as placeholders: `{{session:1}}`, `{{cwd}}`, `{{message:N}}`, `{{system}}`, `{{tools}}`. Event order, chunk shapes, and token counts are as captured. The real system prompt and tool schemas sit beside it in `system-prompt.expected.md` and `tool-schemas.expected.json`.

The numbering matters more than it looks. `identity.ts` performs **relationship-preserving** redaction: each distinct id gets a token numbered by first appearance (`tokenByValue.set(value, \`{{${kind}:${next}}}\`)`, `packages/test-support/session-snapshot/src/identity.ts:64`). So `{{message:1}}` appearing in two different events is proof they reference the *same* message — the redaction scrubs the values while preserving the graph. `{{cwd}}`, `{{system}}`, and `{{tools}}` are flat constants from `normalize.ts:20-22`.

That property is what makes the next section work.

## Line numbers are not sequence numbers

One thing to establish before reading. The file has 25 lines, but the session has **43 events**, because line 15 is a packed chunk row holding twenty of them ([Ch 30](30-crash-repair-and-chunk-packing.md)).

We can verify the mapping from the data itself, without trusting any assumption. Two independent checks:

- **Line 11** (`session/title`) carries `messageSeqs: [7]`, citing the user's message. Counting events from the header line, the user's message is at **seq 7**. ✓
- **Line 23** (`assistant/message`) carries `sourceEventSeqs` spanning **12 through 39** — 28 consecutive values. Counting the streaming events, the first `block-start` is at seq 12 and the `finish` at seq 39: 39 − 12 + 1 = 28. ✓

Two citations, computed by different mechanisms at different times, agreeing with one arithmetic model. That is the provenance system of [Chapter 6](06-the-surface.md) doing exactly what it was built for — and it is how this chapter can annotate seq numbers the file never prints.

## The walkthrough

### Line 1 — the header, which is not an event

```json
{"type":"session","version":0,"id":"{{session:1}}","createdAt":1783600629539,"cwd":"{{cwd}}","delegationDepth":0}
```

Immutable creation metadata, deliberately kept **out** of the event log because it is "a storage concern, not replayable conversation state" ([Ch 5](05-the-append-only-log.md)). `delegationDepth: 0` means a root agent, not a subagent ([Ch 28](28-subagents.md)). The bare `session` tag is slash-less, like the packed chunk rows — the convention for "this line is storage, not an event."

### Lines 2–4 (seq 0–2) — session policy

```json
{"type":"permission/preset","data":{"preset":"danger-full-access"}}
{"type":"sandbox/mode","data":{"mode":"danger-full-access"}}
{"type":"approval/policy","data":{"policy":"never"}}
```

Three events from three different plugins, none of which the engine knows about ([Ch 2](02-just-enough-architecture.md)). None is surface-eligible, so none reaches the model as a message — but their *effects* will, at line 10.

This snapshot runs with approval disabled, which [Chapter 18](18-approval-and-escalation.md) showed is resolved **inline** rather than by any listener.

### Line 5 (seq 3) — input arrives

```json
{"type":"agent/inbox/spliced","data":{"target":"next-turn","start":0,"inserted":[{...}]}}
```

`followup()` → `send(message, 'next-turn', true)` ([Ch 12](12-the-inbox.md)). The queue is durable: this event *is* the queue. The agent was idle, so the wake starts a driver rather than being latched ([Ch 13](13-phases-cancellation-quiescence.md)).

### Line 6 (seq 4) — the turn opens

```json
{"type":"turn/start","data":{"turn":1}}
```

`turn()` entry ([Ch 9](09-the-turn-and-step-loops.md)). Turn 1, because the `turnBoundary` projection folded an empty log to `lastTurn: 0` ([Ch 8](08-projections.md)).

### Line 7 (seq 5) — the claim

```json
{"type":"agent/inbox/spliced","data":{"target":"next-turn","start":0,"removedCount":1,"inserted":[]}}
```

`claim('next-turn', 1)` popping **exactly one** item ([Ch 12](12-the-inbox.md)). Note the ordering: the claim is logged *before* `step/start`, because `preStep` runs before the step opens.

`removedCount: 1` with an empty `inserted` — a removal recorded as durably as an insertion. The inbox's whole history is in the log.

### Line 8 (seq 6) — the step opens

```json
{"type":"step/start","data":{"turn":1,"step":1}}
```

### Line 9 (seq 7) — the human's message

```json
{"type":"user/message","data":{"content":[{"type":"text","text":"Reply with exactly the word: PONG. Do not use any tools."}],"source":{"kind":"user"},...},"surfaceOp":"append"}
```

The claimed message, now durable and on the surface. `source: { kind: 'user' }` distinguishes it from what comes next.

### Line 10 (seq 8) — the runtime-context snapshot

```json
{"type":"user/message","data":{"content":[{"type":"text","text":"Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent DSH file policy: danger-full-access...\n\nApproval prompts are disabled in this session..."}],"source":{"kind":"plugin","plugin":"@deepseek-ai/dsh-system-prompt","form":"snapshot","sections":[{"name":"sandbox:policy",...},{"name":"approval:policy",...}]},...},"surfaceOp":"append"}
```

The chapter's best single illustration. This message:

- was produced by `RuntimeContextProjection.project()` because `retained` was `undefined` and the rendered context was non-empty ([Ch 21](21-runtime-context-injection.md));
- entered as the **innermost default** of the `agent/pre-step` waterfall, so every listener inherited it by delegating ([Ch 22](22-extension-points.md));
- carries the two sections that lines 3 and 4 caused, each attributed to its plugin;
- was appended by `turn()` as an ordinary `user/message` — **indistinguishable from line 9 except by its source tag**. No side channel.

Read the second section's text again: *"do not request sandbox escalation (do not set `sandbox_permissions`)"*. The policy from line 4 is being enforced *and* explained, so the model does not waste a turn attempting something that would be auto-rejected ([Ch 18](18-approval-and-escalation.md)).

### Line 11 (seq 9) — a title appears

```json
{"type":"session/title","data":{"title":"Reply with exactly the word:","messageSeqs":[7],"source":{"kind":"fallback"}}}
```

A plugin, not the engine. `source: { kind: 'fallback' }` means the LLM titler did not run; the fallback truncated the first message to five words. `messageSeqs: [7]` cites its source — the same provenance discipline, in a plugin the engine never heard of.

### Lines 12–13 (seq 10–11) — the request is pinned

```json
{"type":"request/header","data":{"header":{"config":{"provider":"deepseek-official","model":"deepseek-v4-flash"},"system":"{{system}}","tools":"{{tools}}"},"reason":"initial"}}
{"type":"request/context","data":{"provider":"deepseek-official","model":"deepseek-v4-flash"}}
```

`reason: 'initial'` — first request of this loop instance over a log with no prior header ([Ch 10](10-building-the-request.md)). `system` and `tools` are the normalized placeholders; the real ones are 4.4 KB and 35.5 KB respectively.

At this moment the request's `messages` array is exactly **two entries** — seq 7 and seq 8 — derived by walking the surface ([Ch 7](07-from-log-to-request.md)). Everything else logged so far is not surface-eligible.

Had the invariant been mounted, this is where it would have compared those two messages against a fresh derivation ([Ch 11](11-the-reconstruction-invariant.md)).

### Lines 14–22 (seq 12–39) — the stream

| Line | Seq | Chunk |
|---|---|---|
| 14 | 12 | `block-start` index 0, `reasoning` |
| 15 | 13–32 | **20 packed** `reasoning-delta` |
| 16 | 33 | `block-start` index 1, `text` |
| 17 | 34 | `text-delta` `"P"` |
| 18 | 35 | `text-delta` `"ONG"` |
| 19 | 36 | `block-end` index 0 |
| 20 | 37 | `block-end` index 1 |
| 21 | 38 | `usage` |
| 22 | 39 | `finish` `{ kind: 'stop' }` |

Three things worth pausing on.

**The blocks interleave.** Block 1 starts (seq 33) and receives both its deltas (34, 35) *before* block 0 closes (36). Identity is the index, not arrival order — which is why the assembler keys partials by index ([Ch 24](24-streaming-and-assembly.md)).

**"PONG" arrived as two deltas**, and inside the packed reasoning row the model's tokenizer split the quoted word into `" \""`, `"P"`, `"ONG"`, `"\""`. The codec stores each member separately precisely so those boundaries survive ([Ch 30](30-crash-repair-and-chunk-packing.md)).

**Line 15's `dt` array is `[0,0,...,1,0,0,0]`** — nineteen gaps, all zero but one. The whole reasoning block arrived within two milliseconds.

### Line 23 (seq 40) — the assistant message

```json
{"type":"assistant/message","data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"reasoning","text":"The user wants me to reply with exactly the word \"PONG\" and not use any tools."},{"type":"text","text":"PONG"}],"source":{"kind":"model","provider":"deepseek-official","model":"deepseek-v4-flash"}},"usage":{"inputTokens":3091,"outputTokens":23,"cacheReadTokens":0,"reasoningTokens":20}},"sourceEventSeqs":[12,13,...,39],"surfaceOp":"append"}
```

The assembled result, citing **all 28 chunk events**. Both blocks survive because `finish.kind` was `stop`, not `max-tokens` — had it been the latter, any tool call would have been dropped ([Ch 24](24-streaming-and-assembly.md)).

The usage numbers are worth sitting with: **3,091 input tokens to produce 23 output tokens**. The input is almost entirely system prompt and tool schemas — 35.5 KB of tool JSON for a request that was told not to use tools. That is the standing cost of a stable tool catalog, and the reason [Chapter 15](15-the-tool-registry.md) noted plan mode keeps tools listed rather than removing them: changing the catalog would change the header and invalidate the provider's prefix cache, which is what makes the *next* request cheap.

### Lines 24–25 (seq 41–42) — closing

```json
{"type":"step/end","data":{"turn":1,"step":1}}
{"type":"turn/end","data":{"turn":1,"reason":{"kind":"completed"}}}
```

The step returned `{ kind: 'completed' }` because the assistant message contained no tool-call blocks ([Ch 9](09-the-turn-and-step-loops.md) ⑨). `turnEnds` was set, `inbox.nextStep` was empty, `agent/turn-stopping` dispatched to nobody ([Ch 22](22-extension-points.md)), the re-test still found the queue empty, and the loop broke. `turn()` returned `false` — no pending input — and the driver went idle.

## What the turn cost

| | |
|---|---|
| Log lines | 25 |
| Events | 43 |
| Surface nodes at request time | 2 |
| Messages sent to the model | 2 |
| Model calls | 1 |
| Input tokens | 3,091 |
| Output tokens | 23 (20 of them reasoning) |

Forty-three events for one word. That ratio is not waste — it is the price of the property in [Chapter 1](01-the-core-idea.md). Every one of those events is something a resumed, forked, compacted, or replayed session would need.

## Which mechanisms were active

| Mechanism | Where |
|---|---|
| Inbox | 5, 7 |
| Phase machine | 5 (wake), 25 (idle) |
| Turn loop | 6, 24, 25 |
| Step loop | 8, 24 |
| Prompt assembly | before 12 |
| Runtime context | 10 |
| Extension points | 10 (pre-step default), 25 (turn-stopping, no listeners) |
| Request construction | 12, 13 |
| Adapters | before 14 |
| Streaming + assembly | 14–23 |
| Surface | 9, 10, 23 |
| Derivation | before 12 |
| Chunk packing | 15 |
| Projections | 6 (turn number) |
| Token meter | 21 (real usage recorded) |

Not exercised: tools, approval, compaction, retry, subagents, crash repair. The next chapter covers the paths where those appear — by looking at what happens when things go wrong.

---

## Key takeaways

- A minimal turn is 43 events; two of them reach the model.
- Two independent provenance citations confirm the seq mapping without assuming it.
- The runtime-context snapshot is an ordinary logged `user/message`, distinguished only by its source tag.
- Streaming blocks interleave; index is identity.
- 3,091 input tokens for a 23-token answer, almost all of it the stable tool catalog that keeps later requests cheap.
- Boundary events carry no model-visible content and exist to make the log parseable.

## Exercises

1. Recompute the seq mapping yourself from line 1, then check it against both citations. Which line would shift if `MIN_RUN` were 2?
2. Suppose the model had emitted one tool call. List every additional event, in order, with its seq.
3. The request carried two messages but the log has 43 events. Which chapters explain each of the 41 that did not reach the model?

**Next:** [Chapter 32 · When things go wrong](32-when-things-go-wrong.md)
