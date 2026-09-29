# Chapter 4 · The engine in 100 lines

**What you'll learn:** the whole engine, simplified until it fits on two screens — then an honest inventory of everything the real one adds.

**Prerequisites:** [Chapter 3](03-core-data-structures.md) for the type names.

---

## The minimal engine

This is not pseudocode for a different system; it is the real control flow with the hard parts removed. Every name here is a real name from `packages/core/agent-loop/src/agent.ts`.

```ts
class MinimalAgent {
  constructor(
    private ctx: Context,
    private session: Session,
    private options: { provider: string; model: string },
  ) {}

  /** Entry point: run turns until nothing is pending. */
  private async kick(): Promise<void> {
    while (await this.turn()) {}
  }

  /** One turn: open a boundary, run steps until the turn has an ending. */
  private async turn(): Promise<boolean> {
    const turn = ++this.turnNumber
    this.session.append('turn/start', { turn })
    let turnEnds: TurnEndReason | null = null
    let step = 0

    try {
      while (true) {
        // 1. Claim pending input and assemble the prompt.
        const claimed = this.inbox.claim(step === 0 ? 'next-turn' : 'next-step', turn)
        const assembly = await this.ctx.systemPrompt.assemble({ agent: this, scope: this })

        // 2. Open the step and log the claimed input.
        step += 1
        this.session.append('step/start', { turn, step })
        for (const message of claimed) {
          this.session.append('user/message', message, { surfaceOp: 'append' })
        }

        // 3. Run the step: one model call plus its tool calls.
        turnEnds = await this.step(turn, step, assembly)
        this.session.append('step/end', { turn, step })

        // 4. Stop when the turn has an ending and nothing is queued for a next step.
        if (turnEnds && this.inbox.nextStep.length === 0) break
      }
    } finally {
      this.session.append('turn/end', { turn, reason: turnEnds ?? { kind: 'completed' } })
    }

    return this.inbox.hasPending
  }

  /** One step: build a request from the log, stream it, run any tool calls. */
  private async step(turn: number, step: number, assembly: PromptAssembly)
    : Promise<TurnEndReason | null> {

    // 5. THE CENTRAL MOVE: the request is derived from the log, not remembered.
    const request = {
      provider: this.options.provider,
      model: this.options.model,
      system: renderPrompt(assembly),
      tools: assembly.tools,
      messages: this.session.deriveMessages(),
    }
    this.session.append('request/header', { header: canonicalHeader(request), reason: 'initial' })

    // 6. Stream, logging every chunk and accumulating blocks.
    const assembler = new BlockAssembler()
    const chunkSeqs: number[] = []
    for await (const chunk of this.ctx.llm.stream(request)) {
      chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
      assembler.push(chunk)
    }

    // 7. Commit the assistant message, citing the chunks that built it.
    const message = createAssistantMessage({
      content: assembler.blocks(),
      source: { provider: request.provider, model: request.model },
    })
    this.session.append('assistant/message', { turn, step, message },
      { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })

    if (assembler.finish.kind === 'max-tokens') return { kind: 'max-tokens' }

    // 8. No tool calls means the model is done talking: the turn can end.
    const toolCalls = message.content.filter(block => block.type === 'tool-call')
    if (toolCalls.length === 0) return { kind: 'completed' }

    // 9. Run the tools, logging each call and each result.
    for (const call of toolCalls) {
      const callSeq = this.session.append('tool/call', {
        turn, step, callId: call.id, name: call.name, arguments: call.arguments,
      }).seq
      const result = await this.ctx.tools.execute({
        callId: call.id, name: call.name,
        arguments: JSON.parse(call.arguments || '{}'),
        agent: this, signal: this.signal,
      })
      this.session.append('tool/result', {
        turn, step,
        message: createToolResultMessage({
          callId: call.id, content: result.content, isError: result.isError,
        }),
      }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    }

    // 10. Tools ran, so the model gets another step to react to their results.
    return null
  }
}
```

## Reading it

**The three loops.** `kick` iterates turns, `turn` iterates steps, and (in the real engine) `step` iterates request retries. Each has exactly one exit condition, and confusing them is the single easiest way to misread this engine.

**Step 1 — input arrives at a boundary, never mid-flight.** Messages are *claimed* from a queue at the top of a step. Nothing interrupts a step in progress. The first step of a turn claims from `next-turn`; later steps claim from `next-step`. Chapter 12 explains why that asymmetry exists.

**Step 2 — the log records structure, not just content.** `turn/start`, `step/start`, `step/end`, `turn/end` carry no model-visible text. They exist so the log can be *parsed* later — to find an unterminated turn after a crash, to count turns for a UI, to know which events belong to which step.

**Step 5 — the line the whole design exists for.** `messages: this.session.deriveMessages()`. Not `this.messages`. There is no in-memory transcript to drift from. Everything appended in steps 2, 7, and 9 is already in the log, so re-deriving picks it up automatically. Delete this line's discipline and most of the rest of the book stops making sense.

**Step 7 — `sourceEventSeqs` links the summary to its raw material.** The assistant message cites every chunk event it was assembled from. That provenance is what lets a UI expand a message back into its stream, and what compaction uses to prove it is superseding the right things.

**Step 10 — returning `null` is how the loop continues.** A step that ran tools returns `null`, meaning "no ending yet"; the turn loop sees `turnEnds` still null and runs another step so the model can react. This is the only path by which a turn contains more than one model call.

## What the real implementation adds

Nothing above is wrong, but a great deal is missing. Each item links to the chapter that covers it.

**Correctness and safety**
- Every `append` is validated against the live surface *before* it lands, and reentrant appends are refused — [Ch 5](05-the-append-only-log.md)
- History can be rewritten by superseding ranges rather than deleting — [Ch 6](06-the-surface.md)
- The derived-message cache is incremental and invalidated by rewrites — [Ch 7](07-from-log-to-request.md)
- A machine-checkable assertion that the request equals the derivation — [Ch 11](11-the-reconstruction-invariant.md)

**Control**
- Turn endings are *sticky* for `max-tokens`, and a rejected step blocks the turn entirely — [Ch 9](09-the-turn-and-step-loops.md)
- Request headers are logged only when they change, with four distinct reasons — [Ch 10](10-building-the-request.md)
- A durable inbox with two queues, backing three different ways to send input — [Ch 12](12-the-inbox.md)
- Cancellation, wake latching, and a phase machine so teardown never waits on a model call — [Ch 13](13-phases-cancellation-quiescence.md)
- A lifecycle that rolls back cleanly if setup fails midway — [Ch 14](14-agent-lifecycle.md)

**Tools**
- A four-stage pipeline with pre-execute, approval, guards, and post-execute — [Ch 16](16-the-execution-pipeline.md)
- Concurrency: exclusive barriers and a bounded parallel pool, with results committed in model order — [Ch 17](17-scheduling-tool-calls.md)
- Two independent approval paths — [Ch 18](18-approval-and-escalation.md)
- Malformed model JSON does not crash anything; it becomes a retryable tool error — [Ch 17](17-scheduling-tool-calls.md)

**What the model sees**
- Prompt sections, contexts, tools, and variables, layered and shadowed per agent — [Ch 19](19-prompt-assembly.md)
- A runtime-context snapshot injected *only when it changes* — [Ch 21](21-runtime-context-injection.md)
- Extension points where every plugin in the system attaches — [Ch 22](22-extension-points.md)

**Model I/O**
- Adapter resolution, exact-model defaults, one-shot prepared calls — [Ch 23](23-adapters-and-preparecall.md)
- Partial output salvaged when a stream is cancelled — [Ch 24](24-streaming-and-assembly.md)
- Retry — which the loop does not implement — [Ch 25](25-failures-and-retry.md)

**Staying inside the context window**
- Token measurement, spilling, pruning, and LLM-summarizing compaction — [Ch 26](26-measuring-and-spilling.md), [Ch 27](27-pruning-and-compaction.md)

**Recursion**
- Subagents, built from this same engine — [Ch 28](28-subagents.md)

**Durability**
- Persistence, crash repair, and a lossless chunk-packing codec — [Ch 29](29-persistence.md), [Ch 30](30-crash-repair-and-chunk-packing.md)

---

## Key takeaways

- Three nested loops: turns, steps, retries.
- Input is claimed at step boundaries; nothing interrupts a step in flight.
- `deriveMessages()` at request time is the design's load-bearing line.
- A step returning `null` — "no ending yet" — is what makes a turn multi-step.
- Boundary events carry no model-visible content; they exist to make the log parseable.

## Exercises

1. In the minimal `turn()`, a step that produces no tool calls ends the turn. Trace what happens if a tool's result sets `concludesTurn`. Which line would need to change, and what would it look like?
2. The minimal `step()` runs tool calls strictly in sequence. List two things that must be true about a tool before it is safe to run it concurrently with its siblings, then check your list against [Chapter 17](17-scheduling-tool-calls.md).
3. Add cancellation to the minimal engine using a single `AbortSignal`. Where does it need to be checked? Count the places, then compare to the real `turn()`, which checks six times.

**Next:** [Chapter 5 · The append-only log](05-the-append-only-log.md)
