/**
 * Replay-safe, model-free tool-result pruning service.
 *
 * @module @deepseek-ai/dsh-compaction-tool-result-pruner
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, ToolResultMessage } from '@deepseek-ai/dsh-session'
// Type-only: the trigger union plus the `compaction/*` SessionEventMap merges (the shadow-price event).
import type { CompactionTrigger } from '@deepseek-ai/dsh-compaction'
// Type-only: the optional `ctx.spillStore` Context merge.
import type { SpillRef } from '@deepseek-ai/dsh-spill'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'
import { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig, spillMarker } from './config.ts'
import type {
  PrunedEntry,
  PruneResult,
  ResolvedConfig,
  ToolResultPruneConfig,
} from './types.ts'

export { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig, spillMarker } from './config.ts'
export type {
  PrunedEntry,
  PruneResult,
  ResolvedConfig,
  ToolResultPruneConfig,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    toolResultPruner: ToolResultPruner
  }
}

interface SnapshotCandidate {
  readonly seq: number
  readonly event: SessionEvent<'tool/result'>
}

/** A candidate whose plain-marker replacement is known, before any spill or append. */
interface PlannedPrune extends SnapshotCandidate {
  readonly original: readonly ContentBlock[]
  readonly plain: ContentBlock[]
}

/** Deterministic head/middle/tail pruning for current tool-result surface nodes. */
export class ToolResultPruner extends Service {
  // The token meter prices each shadowed node for its logged shadow-price
  // event, so pruning genuinely requires the pricing capability.
  static inject = ['tokenMeter']

  static Config: z<ToolResultPruneConfig> = z.object({
    thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
    headChars: z.number().step(1).min(0).default(DEFAULTS.headChars),
    tailChars: z.number().step(1).min(0).default(DEFAULTS.tailChars),
    protectRecentResults: z.number().step(1).min(0).default(DEFAULTS.protectRecentResults),
    minTokensSaved: z.number().step(1).min(0).default(DEFAULTS.minTokensSaved),
  })

  /** Resolved and immutable character budgets. */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: ToolResultPruneConfig = {}) {
    super(ctx, 'toolResultPruner')
    this.config = resolveConfig(config)
  }

  /**
   * Measure text content in Unicode code points; non-text blocks cost zero.
   * @param blocks - tool-result content to measure.
   * @returns total Unicode code points across text blocks.
   */
  measureContent(blocks: readonly ContentBlock[]): number {
    let chars = 0
    for (const block of blocks) {
      if (block.type === 'text') chars += codePointLength(block.text)
    }
    return chars
  }

  /** Whether `marker` joined to the configured head and tail stays within `thresholdChars`. */
  private markerFits(marker: string): boolean {
    return this.config.headChars + codePointLength(marker) + this.config.tailChars
      <= this.config.thresholdChars
  }

  /**
   * Replace an over-budget text middle while retaining rich-block order.
   * Text slicing is by Unicode code point, not UTF-16 code unit, so a retained
   * boundary cannot split a surrogate pair. Grapheme clusters may still split.
   * @param blocks - original tool-result content.
   * @param marker - text substituted for the removed span; head + marker + tail must fit `thresholdChars`.
   * @returns pruned content, or `null` when the text is within budget.
   */
  pruneContent(blocks: readonly ContentBlock[], marker: string = PRUNE_MARKER): ContentBlock[] | null {
    const totalChars = this.measureContent(blocks)
    if (totalChars <= this.config.thresholdChars) return null

    const removedStart = this.config.headChars
    const removedEnd = totalChars - this.config.tailChars
    const pruned: ContentBlock[] = []
    let consumed = 0
    let markerInserted = false

    for (const block of blocks) {
      if (block.type !== 'text') {
        pruned.push(block)
        continue
      }

      const points = Array.from(block.text)
      const blockStart = consumed
      const blockEnd = blockStart + points.length
      const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
      const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
      const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
      const inserted = intersectsRemoved && !markerInserted ? marker : ''
      if (inserted.length > 0) markerInserted = true
      const text = points.slice(0, headEnd).join('')
        + inserted
        + points.slice(tailStart).join('')
      if (text.length > 0) pruned.push({ ...block, text })
      consumed = blockEnd
    }

    /* v8 ignore next -- totalChars > threshold and valid budgets guarantee a removed text span. */
    if (!markerInserted) throw new Error('tool-result prune: failed to locate the removed text span')
    const charsAfter = this.measureContent(pruned)
    /* v8 ignore next -- config validation fixes the emitted head + marker + tail budget. */
    if (charsAfter > this.config.thresholdChars || charsAfter >= totalChars) {
      throw new Error('tool-result prune: replacement must be smaller and within threshold')
    }
    return pruned
  }

  /**
   * Prune over-budget tool results from one current-surface snapshot.
   *
   * A `pressure` pass never touches the newest `protectRecentResults` tool
   * results and lands nothing unless the plain-marker replacements would remove
   * at least `minTokensSaved` estimated tokens. A `context-overflow` pass skips
   * both safeguards, because the unpruned request cannot be sent at all.
   *
   * When `ctx.spillStore` is mounted, each selected original's text is saved
   * first and its marker names the stored copy; a failed save, or a marker too
   * long for the budget, falls back to {@link PRUNE_MARKER}. Saves finish before
   * any append, and a result that left the surface meanwhile is skipped.
   *
   * Each replacement preserves the complete event data except for `content`,
   * cites the shadowed node so replay can recover the replacement input, and is
   * immediately preceded by a `compaction/prune` shadow-price event pricing the
   * shadowed node through the injected token meter, so pure consumers can
   * subtract it without per-node state.
   * @param session - session whose current surface is rewritten.
   * @param trigger - the compaction trigger that qualified this pass.
   * @returns landed replacements and aggregate Unicode-code-point savings.
   * @throws when the session rejects a replacement; replacements committed
   * earlier in the pass remain durable.
   */
  async pruneSession(session: Session, trigger: CompactionTrigger): Promise<PruneResult> {
    const results: SnapshotCandidate[] = []
    for (const seq of [...session.surface.nodes]) {
      const event = session.events[seq]
      /* v8 ignore next -- surface seqs are validated contiguous log references. */
      if (event?.type === 'tool/result') results.push({ seq, event })
    }

    const guarded = appliesSafeguards(trigger)
    const eligible = guarded
      ? results.slice(0, Math.max(0, results.length - this.config.protectRecentResults))
      : results
    const planned: PlannedPrune[] = []
    let tokensSaved = 0
    for (const candidate of eligible) {
      const original = candidate.event.data.message.content[0].content
      const plain = this.pruneContent(original)
      if (plain === null) continue
      planned.push({ ...candidate, original, plain })
      tokensSaved += this.ctx.tokenMeter.estimateMessage(candidate.event.data.message)
        - this.ctx.tokenMeter.estimateMessage(withContent(candidate.event, plain))
    }
    if (guarded && tokensSaved < this.config.minTokensSaved) return { pruned: [], charsRemoved: 0 }

    const refs = await this.saveOriginals(session, planned)
    const onSurface = new Set(session.surface.nodes)
    const pruned: PrunedEntry[] = []
    let charsRemoved = 0
    for (const { seq, event, original, plain } of planned) {
      if (!onSurface.has(seq)) continue
      const ref = refs.get(seq)
      const marker = ref === undefined ? undefined : spillMarker(ref)
      const stored = marker !== undefined && this.markerFits(marker) ? ref : undefined
      const content = (stored === undefined ? null : this.pruneContent(original, marker)) ?? plain
      const charsBefore = this.measureContent(original)
      const charsAfter = this.measureContent(content)
      // Shadow-price protocol: the metering event and its replacement are
      // appended synchronously adjacent, so pure consumers subtract the
      // shadowed node's heuristic price without retaining per-node state.
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(event.data.message),
      })
      const replacement = session.append('tool/result', {
        ...event.data,
        message: withContent(event, content),
      }, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
      pruned.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callId: event.data.message.source.callId,
        charsBefore,
        charsAfter,
        ...stored === undefined ? {} : { spillLocator: stored.locator },
      })
      charsRemoved += charsBefore - charsAfter
    }
    return { pruned, charsRemoved }
  }

  /**
   * Save each planned original's text through the optional spill store.
   * Best-effort: a missing store or a rejected save leaves that entry without a
   * stored copy, so it is pruned with the plain marker.
   */
  private async saveOriginals(session: Session, planned: readonly PlannedPrune[]): Promise<Map<number, SpillRef>> {
    const refs = new Map<number, SpillRef>()
    const store = this.ctx.get('spillStore')
    if (store === undefined) return refs
    for (const { seq, event, original } of planned) {
      const callId = event.data.message.source.callId
      const toolName = toolNameFor(session, seq, callId)
      try {
        refs.set(seq, await store.saveText({
          owner: { sessionId: session.id },
          source: { toolName, callId, label: 'pruned-result' },
          suggestedName: `${toolName}.txt`,
          content: textOf(original),
        }))
      } catch (error: unknown) {
        this.ctx.logger.warn(
          `tool-result pruner: saving ${toolName} result ${callId} failed: ${String(error)}; pruning without a stored copy`,
        )
      }
    }
    return refs
  }
}

/** Whether a trigger applies the recency and minimum-gain safeguards. */
function appliesSafeguards(trigger: CompactionTrigger): boolean {
  switch (trigger) {
    case 'pressure':
      return true
    case 'context-overflow':
      return false
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      return assertNever(trigger, 'compaction trigger')
  }
}

/** The tool-result message of `event` with its single result's content replaced. */
function withContent(event: SessionEvent<'tool/result'>, content: ContentBlock[]): ToolResultMessage {
  const result = event.data.message.content[0]
  return freezeMessage<ToolResultMessage>({
    ...event.data.message,
    content: [{ ...result, content }] as [typeof result],
  })
}

/** Concatenated text of every text block; other blocks stay in the replacement itself. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** Name of the tool whose call produced `callId`, searching back from the result at `seq`. */
function toolNameFor(session: Session, seq: number, callId: ToolCallId): string {
  for (let index = seq - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type === 'tool/call' && event.data.callId === callId) return event.data.name
  }
  return 'tool'
}

export default ToolResultPruner
