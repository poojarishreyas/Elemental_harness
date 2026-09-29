import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeMetrics, summarize, workspacePath } from './metrics.ts'
import type { EvalEvent, RunMetrics } from './metrics.ts'

const WORKSPACE = resolve('/work/repo')
const SOURCE = 'packages/core/session/src/index.ts'
const TEST = 'packages/core/session/tests/session.spec.ts'
const EXPECTED = { workspace: WORKSPACE, sourceFiles: [SOURCE], testFiles: [TEST] }

function step(n: number): EvalEvent {
  return { type: 'step/start', data: { turn: 1, step: n } }
}
function call(name: string, args: Record<string, unknown> | string): EvalEvent {
  return { type: 'tool/call', data: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }
}
function result(text: string): EvalEvent {
  return { type: 'tool/result', data: { message: { content: [{ content: [{ type: 'text', text }] }] } } }
}
function dispatch(name: string, args: unknown, text = ''): EvalEvent {
  return { type: 'tool/code-dispatch', data: { name, arguments: args, content: [{ type: 'text', text }] } }
}

describe('workspacePath', () => {
  it('normalizes relative and absolute paths inside the workspace and rejects others', () => {
    expect(workspacePath(WORKSPACE, SOURCE)).toBe(SOURCE)
    expect(workspacePath(WORKSPACE, join(WORKSPACE, SOURCE))).toBe(SOURCE)
    expect(workspacePath(WORKSPACE, '../outside.ts')).toBeUndefined()
    expect(workspacePath(WORKSPACE, '.')).toBeUndefined()
    expect(workspacePath(WORKSPACE, undefined)).toBeUndefined()
  })
})

describe('computeMetrics', () => {
  it('finds when the expected file was first seen, read, and edited', () => {
    const events: EvalEvent[] = [
      step(1),
      call('grep', { pattern: 'appendEvent' }),
      result(`${SOURCE}:12: appendEvent(x)`),
      step(2),
      call('read', { file_path: 'README.md' }),
      call('read', { file_path: join(WORKSPACE, SOURCE) }),
      step(3),
      call('edit', { file_path: SOURCE, old_string: 'a', new_string: 'b' }),
      call('write', { path: 'notes.txt', content: 'x' }),
      call('bash', 'not json'),
    ]
    const metrics = computeMetrics(events, EXPECTED, { inputTokens: 100, outputTokens: 10 })
    expect(metrics).toEqual({
      steps: 3,
      toolCalls: { grep: 1, read: 2, edit: 1, write: 1, bash: 1 },
      firstSeenStep: 1,
      firstReadStep: 2,
      readsBeforeCorrect: 1,
      editedFiles: ['notes.txt', SOURCE],
      editedExpected: true,
      extraEdits: ['notes.txt'],
      editedTests: false,
      usage: { inputTokens: 100, outputTokens: 10 },
    } satisfies RunMetrics)
  })

  it('reads run_code sub-calls and their outputs, flags test edits, and handles never-found files', () => {
    const found = computeMetrics([
      step(1),
      // Windows search output separates path segments with single backslashes.
      dispatch('grep', { pattern: 'x' }, `${SOURCE.split('/').join('\\')}:3`),
      step(2),
      dispatch('read', { file_path: SOURCE }),
      dispatch('edit', { file_path: TEST }),
    ], EXPECTED)
    expect(found).toMatchObject({ firstSeenStep: 1, firstReadStep: 2, editedTests: true, editedExpected: false })
    expect(found.usage).toBeUndefined()

    const lost = computeMetrics([
      { type: 'step/start', data: {} },
      call('read', { file_path: 'a.ts' }),
      call('read', {}),
      dispatch('read', null),
      { type: 'assistant/message', data: {} },
      result('nothing'),
    ], EXPECTED)
    expect(lost).toMatchObject({ steps: 1, firstSeenStep: null, firstReadStep: null, readsBeforeCorrect: 3, editedFiles: [] })
  })
})

describe('summarize', () => {
  const base = computeMetrics([], EXPECTED)

  it('counts passes and correct edits and takes medians', () => {
    const summary = summarize([
      { passed: true, metrics: { ...base, editedExpected: true, firstReadStep: 2, steps: 5, usage: { inputTokens: 10, outputTokens: 1 } } },
      { passed: false, metrics: { ...base, firstReadStep: 6, steps: 9 } },
      { passed: true, metrics: { ...base, editedExpected: true, firstReadStep: null, steps: 4 } },
      { passed: false, metrics: { ...base, firstReadStep: 3, steps: 7 } },
    ])
    expect(summary).toEqual({
      runs: 4,
      passed: 2,
      editedExpected: 2,
      medianFirstReadStep: 3,
      medianSteps: 6,
      totalInputTokens: 10,
    })
    expect(summarize([])).toMatchObject({ runs: 0, medianFirstReadStep: null, medianSteps: null })
  })
})
