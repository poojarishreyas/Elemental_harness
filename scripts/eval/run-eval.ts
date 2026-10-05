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
 *     [--install "pnpm install --prefer-offline"] [--keep] [--dry-run] [--hard] [--only <id,...>]
 *
 * `--dry-run` stops after preparing and validating each task, so it needs no
 * model key. A full run needs the provider key (DEEPSEEK_API_KEY by default).
 * `--hard` keeps only tasks where the failing test does not lead straight to
 * the fix (see `difficultyTags`), taken round-robin across those kinds.
 */

import { spawn } from 'node:child_process'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { computeMetrics, summarize } from './metrics.ts'
import type { EvalEvent, EvalUsage, RunMetrics } from './metrics.ts'
import { difficultyTags, mineTasks, prepareWorkspace, readTestSources, removeWorkspace, taskPrompt } from './tasks.ts'
import type { EvalTask, TaskTag } from './tasks.ts'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const DRIVER = join(repoRoot, 'packages/test-support/loader-smoke/tests/fixtures/base-driver.ts')
const OVERLAY = join(repoRoot, 'scripts/eval/eval.cordis.yml')
const TSCONFIG = join(repoRoot, 'tsconfig.json')
const MAX_FAILURE_CHARS = 6_000
const LOCALE_FILE = /(^|\/)locales?(\/|\.ts$|\.tsx$)/

/** Outcome of one task. */
interface TaskResult {
  readonly task: EvalTask
  readonly tags: readonly TaskTag[]
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

/** The error message of a turn that ended in error, e.g. a model provider rejecting every request. */
function turnErrorOf(events: readonly EvalEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    const reason = event.data.reason as { kind?: string; error?: { message?: string } } | undefined
    if (reason?.kind === 'error') return reason.error?.message ?? 'unknown error'
  }
  return undefined
}

interface RunOptions {
  readonly repo: string
  readonly install: string
  readonly keep: boolean
  readonly dryRun: boolean
  /** Existing DSH home whose settings and stored credentials the agent run should use. */
  readonly homeFrom?: string
}

/** Files copied from `--home-from`: provider settings and the credential store they reference. */
const HOME_FILES = ['settings.yaml', '.credentials.yaml']

async function runTask(task: EvalTask, options: RunOptions): Promise<Omit<TaskResult, 'tags'>> {
  const workspace = join(tmpdir(), `dsh-eval-${task.id}`)
  // Kept outside the repository and deleted after the task, since it may hold copied credentials.
  const home = join(tmpdir(), `dsh-eval-home-${task.id}`)
  await rm(workspace, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
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

    await mkdir(home, { recursive: true })
    if (options.homeFrom !== undefined) {
      for (const file of HOME_FILES) {
        await copyFile(join(options.homeFrom, file), join(home, file)).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        })
      }
    }
    const launch = resolveExampleLaunch({
      srcBin: DRIVER,
      libBin: DRIVER,
      mode: 'src',
      tsconfigPath: TSCONFIG,
      configArgs: [JSON.stringify([OVERLAY]), taskPrompt(task, tail(`${baseline.stdout}\n${baseline.stderr}`, MAX_FAILURE_CHARS))],
      env: { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
    })
    const agent = await exec(launch.command, launch.args, workspace, { ...process.env, ...launch.env }, 60 * 60_000)
    const parsed = parseDriverOutput(agent.stdout)
    const turnError = turnErrorOf(parsed.events)
    if (turnError !== undefined) return { task, status: 'error', passed: false, note: `agent turn failed: ${turnError}` }
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
    await rm(home, { recursive: true, force: true })
    if (!options.keep) await removeWorkspace(options.repo, workspace).catch(() => rm(workspace, { recursive: true, force: true }))
  }
}

function markdownTable(results: readonly TaskResult[]): string {
  const rows = results.map(result => [
    result.task.id,
    result.tags.join(', '),
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
    '| task | difficulty | status | passed | right file edited | first seen step | first read step | steps | input tokens | subject |',
    '|---|---|---|---|---|---|---|---|---|---|',
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
      'home-from': { type: 'string' },
      only: { type: 'string' },
      hard: { type: 'boolean', default: false },
    },
  })
  if (values.repo === undefined) throw new Error('--repo <git repository with bug-fix history> is required')
  const dryRun = values['dry-run']
  const homeFrom = values['home-from'] === undefined ? undefined : resolve(values['home-from'])
  if (!dryRun && homeFrom === undefined && process.env.DEEPSEEK_API_KEY === undefined) {
    throw new Error('no model credentials: set DEEPSEEK_API_KEY, pass --home-from <dsh home>, or use --dry-run')
  }
  const repo = resolve(values.repo)
  const out = resolve(values.out)
  await mkdir(out, { recursive: true })

  const limit = Number(values.limit)
  const only = values.only?.split(',').map(id => id.trim()).filter(Boolean)
  const candidates = (await mineTasks(repo, Number.MAX_SAFE_INTEGER))
    .filter(task => !task.sourceFiles.every(file => LOCALE_FILE.test(file)))
    .filter(task => only === undefined || only.some(id => task.fixCommit.startsWith(id)))
  const tags = new Map<EvalTask, TaskTag[]>()
  const tasks = await selectTasks(candidates, limit, values.hard, async (task) => {
    const taskTags = difficultyTags(task, await readTestSources(repo, task))
    tags.set(task, taskTags)
    return taskTags
  })
  process.stdout.write(`eval: ${tasks.length} task(s) from ${repo}${dryRun ? ' (dry run)' : ''}\n`)

  const results: TaskResult[] = []
  for (const task of tasks) {
    process.stdout.write(`eval: ${task.id} [${(tags.get(task) ?? []).join(', ')}] ${task.subject}\n`)
    const result = { tags: tags.get(task) ?? [], ...await runTask(task, {
      repo,
      install: values.install,
      keep: values.keep,
      dryRun,
      ...homeFrom === undefined ? {} : { homeFrom },
    }) }
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

/** Most candidates tagged while hunting for hard tasks; each tag reads test files from git. */
const MAX_TAGGED = 400
const HARD_TAGS: readonly TaskTag[] = ['cross-package', 'indirect', 'multi-file']

/**
 * Pick the tasks to run: the first `limit` candidates, or with `hard` a
 * round-robin over the hard kinds so each is represented.
 */
async function selectTasks(
  candidates: readonly EvalTask[],
  limit: number,
  hard: boolean,
  tag: (task: EvalTask) => Promise<TaskTag[]>,
): Promise<EvalTask[]> {
  if (!hard) {
    const chosen = candidates.slice(0, limit)
    for (const task of chosen) await tag(task)
    return chosen
  }
  const byKind = new Map<TaskTag, EvalTask[]>(HARD_TAGS.map(kind => [kind, []]))
  for (const task of candidates.slice(0, MAX_TAGGED)) {
    const taskTags = await tag(task)
    for (const kind of HARD_TAGS) if (taskTags.includes(kind)) byKind.get(kind)?.push(task)
    if (HARD_TAGS.every(kind => (byKind.get(kind)?.length ?? 0) >= limit)) break
  }
  const chosen: EvalTask[] = []
  while (chosen.length < limit) {
    const before = chosen.length
    for (const kind of HARD_TAGS) {
      const next = byKind.get(kind)?.find(task => !chosen.includes(task))
      if (next !== undefined && chosen.length < limit) chosen.push(next)
    }
    if (chosen.length === before) break
  }
  return chosen
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

await main()
