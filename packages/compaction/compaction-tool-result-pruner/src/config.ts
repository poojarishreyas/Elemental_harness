/** Configuration resolution for deterministic tool-result pruning. */

import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { SpillRef } from '@deepseek-ai/dsh-spill'
import type { ResolvedConfig, ToolResultPruneConfig } from './types.ts'

/** Fixed marker substituted for a removed middle span when no spill artifact holds the original. */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

/**
 * Defaults for coding-agent tool output. The recency and minimum-gain values
 * follow Claude Code's tool-result clearing (keeps the last 5 results, acts only
 * above 20,000 tokens) and opencode's prune minimum (20,000 tokens).
 */
export const DEFAULTS: ResolvedConfig = deepFreeze({
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
  protectRecentResults: 5,
  minTokensSaved: 20_000,
})

const CONFIG_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULTS))

/**
 * Count Unicode code points without splitting surrogate pairs.
 * @param text - text to measure.
 * @returns the Unicode code-point count.
 */
export function codePointLength(text: string): number {
  return Array.from(text).length
}

/**
 * Marker substituted for a removed middle span whose full original text was saved.
 * @param ref - the saved artifact's locator and retrieval guidance.
 * @returns the marker, delimited by blank lines like {@link PRUNE_MARKER}.
 */
export function spillMarker(ref: SpillRef): string {
  return `\n\n[... tool result middle pruned. Full result stored at: ${ref.locator}. ${ref.retrievalHint} ...]\n\n`
}

/**
 * Resolve and validate pruning budgets.
 * @param config - raw plugin configuration.
 * @returns a detached deeply immutable configuration.
 */
export function resolveConfig(config: ToolResultPruneConfig = {}): ResolvedConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(
        `ToolResultPruneConfig: unknown key "${key}" `
        + `(allowed: ${[...CONFIG_KEYS].join(', ')})`,
      )
    }
  }

  const resolved: ResolvedConfig = {
    thresholdChars: config.thresholdChars ?? DEFAULTS.thresholdChars,
    headChars: config.headChars ?? DEFAULTS.headChars,
    tailChars: config.tailChars ?? DEFAULTS.tailChars,
    protectRecentResults: config.protectRecentResults ?? DEFAULTS.protectRecentResults,
    minTokensSaved: config.minTokensSaved ?? DEFAULTS.minTokensSaved,
  }
  assertPositiveInteger('thresholdChars', resolved.thresholdChars)
  assertNonNegativeInteger('headChars', resolved.headChars)
  assertNonNegativeInteger('tailChars', resolved.tailChars)
  assertNonNegativeInteger('protectRecentResults', resolved.protectRecentResults)
  assertNonNegativeInteger('minTokensSaved', resolved.minTokensSaved)

  const emittedChars = resolved.headChars
    + codePointLength(PRUNE_MARKER)
    + resolved.tailChars
  if (emittedChars > resolved.thresholdChars) {
    throw new Error(
      `ToolResultPruneConfig: headChars + marker + tailChars (${emittedChars}) `
      + `must be at most thresholdChars (${resolved.thresholdChars})`,
    )
  }
  return deepFreeze(structuredClone(resolved))
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a positive integer`)
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a non-negative integer`)
  }
}
