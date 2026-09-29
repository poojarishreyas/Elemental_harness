/**
 * File-finding evaluation runner.
 *
 * For each task mined from a repository's bug-fix history: prepare a worktree
 * with the fix's source reverted, confirm the fix's tests fail, run the agent
 * headless through the shipped base profile with the failing output as its
 * task, re-run the tests, and record file-finding metrics from the session.
 *
 * Usage:
 *   pnpm run eval:file-finding -- --repo <git repo> [--limit 10] [--out eval-results]
 *     [--install "pnpm install --prefer-offline"] [--keep] [--dry-run]
 *
 * `--dry-run` stops after preparing and validating each task, so it needs no
 * model key. A full run needs the provider key (DEEPSEEK_API_KEY by default).
 */

import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { computeMetrics, summarize } from './metrics.ts'
import type { EvalEvent, EvalUsage, RunMetrics } from './metrics.ts'
import { mineTasks, prepareWorkspace, removeWorkspace, taskPrompt } from './tasks.ts'
import type { EvalTask } from './tasks.ts'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const DRIVER = join(repoRoot, 'packages/test-support/loader-smoke/tests/fixtures/base-driver.ts')
const OVERLAY = join(repoRoot, 'scripts/eval/eval.cordis.yml')
const TSCONFIG = join(repoRoot, 'tsconfig.json')
const MAX_FAILURE_CHARS = 6_000
const LOCALE_FILE = /(^|\/)locales?(\/|\.ts$|\.tsx$)/

/** Outcome of one task. */
interface TaskResult {
  readonly task: EvalTask
  readonly status: 'valid' | 'invalid' | 'ran' | 'error'
  readonly passed: boolean
  readonly metrics?: RunMetrics
  readonly finalText?: string
  readonly note?: string
}

interface Command {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

function exec(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Command> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env, shell: process.platform === 'win32' && !command.endsWith('.exe'), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

function runTests(workspace: string, files: readonly string[]): Promise<Command> {
  return exec('npx', ['vitest', 'run', ...files], workspace, process.env, 15 * 60_000)
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : `[... ${text.length - max} earlier characters omitted ...]\n${text.slice(-max)}`
}

/** Parse the driver's JSONL stdout into session events and the final result row. */
function parseDriverOutput(stdout: string): { events: EvalEvent[]; usage?: EvalUsage; output?: string } {
  const events: EvalEvent[] = []
  let usage: EvalUsage | undefined
  let output: string | undefined
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    let row: { type?: string; event?: EvalEvent; usage?: EvalUsage; output?: string }
    try {
      row = JSON.parse(line) as typeof row
    } catch {
      // Non-JSON log lines from plugins are not events.
      continue
    }
    if (row.type === 'session_event' && row.event !== undefined) events.push(row.event)
    if (row.type === 'result') {
      usage = row.usage
      output = row.output
    }
  }
  return { events, ...usage === undefined ? {} : { usage }, ...output === undefined ? {} : { output } }
}

interface RunOptions {
  readonly repo: string
  readonly install: string
  readonly keep: boolean
  readonly dryRun: boolean
  readonly home: string
}

async function runTask(task: EvalTask, options: RunOptions): Promise<TaskResult> {
  const workspace = join(tmpdir(), `dsh-eval-${task.id}`)
  await rm(workspace, { recursive: true, force: true })
  try {
    await prepareWorkspace(options.repo, task, workspace)
    const [installCommand = 'pnpm', ...installArgs] = options.install.split(' ')
    const install = await exec(installCommand, installArgs, workspace, process.env, 30 * 60_000)
    if (install.code !== 0) return { task, status: 'error', passed: false, note: `install failed: ${tail(install.stderr, 800)}` }

    const baseline = await runTests(workspace, task.testFiles)
    if (baseline.code === 0) {
      return { task, status: 'invalid', passed: false, note: `tests pass without the fix:\n${tail(baseline.stdout, 1_500)}` }
    }
    if (options.dryRun) return { task, status: 'valid', passed: false, note: 'dry run: prepared and validated' }

    const launch = resolveExampleLaunch({
      srcBin: DRIVER,
      libBin: DRIVER,
      mode: 'src',
      tsconfigPath: TSCONFIG,
      configArgs: [JSON.stringify([OVERLAY]), taskPrompt(task, tail(`${baseline.stdout}\n${baseline.stderr}`, MAX_FAILURE_CHARS))],
      env: { DSH_HOME: join(options.home, task.id), DSH_TELEMETRY_DISABLED: '1' },
    })
    const agent = await exec(launch.command, launch.args, workspace, { ...process.env, ...launch.env }, 60 * 60_000)
    const parsed = parseDriverOutput(agent.stdout)
    const after = await runTests(workspace, task.testFiles)
    const metrics = computeMetrics(parsed.events, { workspace, sourceFiles: task.sourceFiles, testFiles: task.testFiles }, parsed.usage)
    return {
      task,
      status: 'ran',
      passed: after.code === 0 && !metrics.editedTests,
      metrics,
      ...parsed.output === undefined ? {} : { finalText: parsed.output },
      ...agent.code === 0 ? {} : { note: `driver exited ${String(agent.code)}: ${tail(agent.stderr, 800)}` },
    }
  } catch (error: unknown) {
    return { task, status: 'error', passed: false, note: error instanceof Error ? error.message : String(error) }
  } finally {
    if (!options.keep) await removeWorkspace(options.repo, workspace).catch(() => rm(workspace, { recursive: true, force: true }))
  }
}

function markdownTable(results: readonly TaskResult[]): string {
  const rows = results.map(result => [
    result.task.id,
    result.status,
    result.passed ? 'yes' : 'no',
    result.metrics?.editedExpected === true ? 'yes' : 'no',
    String(result.metrics?.firstSeenStep ?? '-'),
    String(result.metrics?.firstReadStep ?? '-'),
    String(result.metrics?.steps ?? '-'),
    String(result.metrics?.usage?.inputTokens ?? '-'),
    result.task.subject.replaceAll('|', '/').slice(0, 60),
  ].join(' | '))
  return [
    '| task | status | passed | right file edited | first seen step | first read step | steps | input tokens | subject |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map(row => `| ${row} |`),
  ].join('\n')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const { values } = parseArgs({
    // `pnpm run eval:file-finding -- --repo …` forwards the separator itself.
    args: argv[0] === '--' ? argv.slice(1) : argv,
    options: {
      repo: { type: 'string' },
      limit: { type: 'string', default: '10' },
      out: { type: 'string', default: 'eval-results' },
      install: { type: 'string', default: 'pnpm install --prefer-offline' },
      keep: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  if (values.repo === undefined) throw new Error('--repo <git repository with bug-fix history> is required')
  const dryRun = values['dry-run']
  if (!dryRun && process.env.DEEPSEEK_API_KEY === undefined && process.env.DSH_EVAL_PROVIDER === undefined) {
    throw new Error('DEEPSEEK_API_KEY is not set; use --dry-run to only prepare and validate tasks')
  }
  const repo = resolve(values.repo)
  const out = resolve(values.out)
  await mkdir(out, { recursive: true })
  const home = join(out, 'dsh-home')

  const limit = Number(values.limit)
  const tasks = (await mineTasks(repo, Number.MAX_SAFE_INTEGER))
    .filter(task => !task.sourceFiles.every(file => LOCALE_FILE.test(file)))
    .slice(0, limit)
  process.stdout.write(`eval: ${tasks.length} task(s) from ${repo}${dryRun ? ' (dry run)' : ''}\n`)

  const results: TaskResult[] = []
  for (const task of tasks) {
    process.stdout.write(`eval: ${task.id} ${task.subject}\n`)
    const result = await runTask(task, { repo, install: values.install, keep: values.keep, dryRun, home })
    results.push(result)
    await writeFile(join(out, `${task.id}.json`), `${JSON.stringify(result, null, 2)}\n`)
    process.stdout.write(`eval: ${task.id} -> ${result.status}${result.passed ? ' (passed)' : ''}${result.note === undefined ? '' : ` — ${result.note.split('\n')[0]}`}\n`)
  }

  const ran = results.flatMap(result => result.status === 'ran' && result.metrics !== undefined
    ? [{ passed: result.passed, metrics: result.metrics }]
    : [])
  const summary = { tasks: results.length, byStatus: countBy(results.map(result => result.status)), ...summarize(ran) }
  await writeFile(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  await writeFile(join(out, 'summary.md'), `${markdownTable(results)}\n`)
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

await main()
