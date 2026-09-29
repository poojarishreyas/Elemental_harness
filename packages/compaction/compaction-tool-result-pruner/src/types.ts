import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SpillLocator } from '@deepseek-ai/dsh-spill'

/** Budget and selection policy for deterministic tool-result pruning. */
export interface ToolResultPruneConfig {
  /** Prune when total text exceeds this many Unicode code points. Defaults to `8192`. */
  thresholdChars?: number
  /** Maximum leading Unicode code points retained. Defaults to `4096`. */
  headChars?: number
  /** Maximum trailing Unicode code points retained. Defaults to `1024`. */
  tailChars?: number
  /**
   * Newest tool results a pressure pass never prunes, counted over every current
   * tool result regardless of size. Overflow recovery ignores it. Defaults to `5`.
   */
  protectRecentResults?: number
  /**
   * Minimum estimated tokens a pressure pass must remove, or it prunes nothing.
   * Overflow recovery ignores it. Defaults to `20000`.
   */
  minTokensSaved?: number
}

/** Validated, detached, deeply immutable pruning configuration. */
export interface ResolvedConfig {
  readonly thresholdChars: number
  readonly headChars: number
  readonly tailChars: number
  readonly protectRecentResults: number
  readonly minTokensSaved: number
}

/** Cited source event and size accounting for one landed surface replacement. */
export interface PrunedEntry {
  /** Full-fidelity tool-result event shadowed by the replacement. */
  readonly originalSeq: number
  /** Newly appended pruned tool-result event. */
  readonly replacementSeq: number
  /** Tool call shared by the original and replacement. */
  readonly callId: ToolCallId
  /** Original text size in Unicode code points. */
  readonly charsBefore: number
  /** Replacement text size in Unicode code points. */
  readonly charsAfter: number
  /** Where the original text was saved, when a spill store accepted it and its marker fit the budget. */
  readonly spillLocator?: SpillLocator
}

/** Aggregate outcome of one stable-surface pruning pass. */
export interface PruneResult {
  /** Replacements in the snapshotted surface order. */
  readonly pruned: readonly PrunedEntry[]
  /** Total Unicode code points removed across replacements. */
  readonly charsRemoved: number
}
