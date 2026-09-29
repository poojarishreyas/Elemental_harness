/**
 * File-finding metrics computed from one agent run's session events.
 *
 * Pure: the runner streams canonical session events from the base driver and
 * passes them here with the task's expected source files.
 */

import { isAbsolute, relative, resolve } from 'node:path'

/** The subset of a canonical session event the metrics read. */
export interface EvalEvent {
  readonly type: string
  readonly data: Record<string, unknown>
}

/** Token totals reported by the driver's result line. */
export interface EvalUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
}

/** What the task's real fix touched. */
export interface EvalExpectation {
  /** Workspace root the agent ran in; tool paths are resolved against it. */
  readonly workspace: string
  /** Source files the real fix changed, workspace-relative with `/` separators. */
  readonly sourceFiles: readonly string[]
  /** Test files that define success; editing them does not count as a fix. */
  readonly testFiles: readonly string[]
}

/** File-finding and cost metrics for one run. */
export interface RunMetrics {
  readonly steps: number
  readonly toolCalls: Readonly<Record<string, number>>
  /** First step whose tool activity named an expected source file (search hit or read), or null. */
  readonly firstSeenStep: number | null
  /** First step that read an expected source file, or null. */
  readonly firstReadStep: number | null
  /** `read` calls made before the first read of an expected source file (all reads when never read). */
  readonly readsBeforeCorrect: number
  /** Workspace-relative files the agent wrote or edited, sorted. */
  readonly editedFiles: readonly string[]
  /** Whether at least one expected source file was edited. */
  readonly editedExpected: boolean
  /** Edited files that are neither expected sources nor the task's tests. */
  readonly extraEdits: readonly string[]
  /** Whether a task test file was edited, which the task forbids. */
  readonly editedTests: boolean
  readonly usage?: EvalUsage
}

const READ_TOOLS = new Set(['read'])
const EDIT_TOOLS = new Set(['edit', 'write', 'str_replace_editor'])

/**
 * Compute the metrics for one run.
 * @param events - the run's session events in log order.
 * @param expected - the task's workspace and real-fix files.
 * @param usage - token totals from the driver's result line, when reported.
 * @returns the run's metrics.
 */
export function computeMetrics(
  events: readonly EvalEvent[],
  expected: EvalExpectation,
  usage?: EvalUsage,
): RunMetrics {
  const sources = new Set(expected.sourceFiles)
  const tests = new Set(expected.testFiles)
  const toolCalls: Record<string, number> = {}
  const edited = new Set<string>()
  const found = { step: 0, steps: 0, seen: null as number | null, read: null as number | null, readsBefore: 0 }

  const noteSeen = (): void => { found.seen ??= found.step }
  const visitCall = (name: string, args: unknown): void => {
    toolCalls[name] = (toolCalls[name] ?? 0) + 1
    const path = workspacePath(expected.workspace, filePathOf(args))
    if (READ_TOOLS.has(name)) {
      if (path !== undefined && sources.has(path)) {
        found.read ??= found.step
        noteSeen()
      } else if (found.read === null) {
        found.readsBefore += 1
      }
    }
    if (EDIT_TOOLS.has(name) && path !== undefined) edited.add(path)
  }

  for (const event of events) {
    switch (event.type) {
      case 'step/start':
        found.step = typeof event.data.step === 'number' ? event.data.step : found.step + 1
        found.steps += 1
        break
      case 'tool/call':
        visitCall(String(event.data.name), parseArguments(event.data.arguments))
        break
      case 'tool/code-dispatch':
        visitCall(String(event.data.name), event.data.arguments)
        if (found.seen === null && mentionsAny(event.data.content, expected.sourceFiles)) noteSeen()
        break
      case 'tool/result':
        if (found.seen === null && mentionsAny(resultContent(event.data), expected.sourceFiles)) noteSeen()
        break
      default:
        break
    }
  }

  const editedFiles = [...edited].sort()
  return {
    steps: found.steps,
    toolCalls,
    firstSeenStep: found.seen,
    firstReadStep: found.read,
    readsBeforeCorrect: found.readsBefore,
    editedFiles,
    editedExpected: editedFiles.some(file => sources.has(file)),
    extraEdits: editedFiles.filter(file => !sources.has(file) && !tests.has(file)),
    editedTests: editedFiles.some(file => tests.has(file)),
    ...usage === undefined ? {} : { usage },
  }
}

/**
 * Resolve a tool-supplied path to a workspace-relative `/`-separated path.
 * @param workspace - the run's workspace root.
 * @param path - the path the model passed, absolute or relative.
 * @returns the relative path, or undefined when absent or outside the workspace.
 */
export function workspacePath(workspace: string, path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  const rel = relative(workspace, resolve(workspace, path))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return rel.split('\\').join('/')
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    // Malformed model-written arguments name no file.
    return undefined
  }
}

function filePathOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  const path = record.file_path ?? record.path
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

function resultContent(data: Record<string, unknown>): unknown {
  const message = data.message as { content?: Array<{ content?: unknown }> } | undefined
  return message?.content?.[0]?.content
}

function mentionsAny(content: unknown, files: readonly string[]): boolean {
  const text = JSON.stringify(content ?? '').split('\\\\').join('/')
  return files.some(file => text.includes(file))
}

/** Aggregate over many runs, for the summary table. */
export interface MetricsSummary {
  readonly runs: number
  readonly passed: number
  readonly editedExpected: number
  readonly medianFirstReadStep: number | null
  readonly medianSteps: number | null
  readonly totalInputTokens: number
}

/**
 * Summarize per-task results.
 * @param results - one entry per task with its pass flag and metrics.
 * @returns counts and medians across tasks.
 */
export function summarize(results: readonly { readonly passed: boolean; readonly metrics: RunMetrics }[]): MetricsSummary {
  return {
    runs: results.length,
    passed: results.filter(result => result.passed).length,
    editedExpected: results.filter(result => result.metrics.editedExpected).length,
    medianFirstReadStep: median(results.flatMap(result => result.metrics.firstReadStep ?? [])),
    medianSteps: median(results.map(result => result.metrics.steps)),
    totalInputTokens: results.reduce((total, result) => total + (result.metrics.usage?.inputTokens ?? 0), 0),
  }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const upper = sorted[mid] ?? 0
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2
}
