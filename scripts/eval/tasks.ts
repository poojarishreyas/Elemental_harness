/**
 * Evaluation tasks mined from this repository's own bug-fix history.
 *
 * A task is a past fix commit whose change is confined to a few package
 * source files plus the tests that pin it. Preparing a task checks out the fix
 * commit in a detached worktree and restores the source files to their
 * pre-fix content, so the fix's own tests fail until the agent repairs them.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** One mined task. */
export interface EvalTask {
  /** Short id: the fix commit's abbreviated hash. */
  readonly id: string
  readonly fixCommit: string
  readonly parentCommit: string
  readonly subject: string
  /** Package source files the fix changed, repo-relative with `/`. */
  readonly sourceFiles: readonly string[]
  /** Spec files the fix added or changed; they define success. */
  readonly testFiles: readonly string[]
}

/** Limits on which commits become tasks. */
export interface MiningRules {
  /** Most source files a task may span. */
  readonly maxSourceFiles: number
  /** Most changed files of any kind in the commit. */
  readonly maxChangedFiles: number
}

/** Defaults: small, focused fixes, where file-finding is the interesting part. */
export const DEFAULT_RULES: MiningRules = { maxSourceFiles: 3, maxChangedFiles: 12 }

const FIX_SUBJECT = /\b(fix(es|ed)?|repair(s|ed)?|correct(s|ed)?|prevent(s|ed)?|restore[sd]?|avoid(s|ed)?|stop(s|ped)?)\b/i
const SOURCE_FILE = /^(packages\/[^/]+\/[^/]+|apps\/[^/]+)\/src\/.+\.(ts|tsx)$/
const SPEC_FILE = /^(packages\/[^/]+\/[^/]+|apps\/[^/]+)\/tests\/.+\.spec\.(ts|tsx)$/
const BUG_FIX_NOTE = /^\.agents\/notes\/[^/]+\/bug-fix\//

/**
 * Decide whether one commit is a usable task.
 * @param subject - the commit subject line.
 * @param files - repo-relative paths the commit changed.
 * @param rules - size limits.
 * @returns the task's source and test files, or undefined when the commit does not qualify.
 */
export function classifyCommit(
  subject: string,
  files: readonly string[],
  rules: MiningRules = DEFAULT_RULES,
): { sourceFiles: string[]; testFiles: string[] } | undefined {
  const isFix = FIX_SUBJECT.test(subject) || files.some(file => BUG_FIX_NOTE.test(file))
  if (!isFix || files.length > rules.maxChangedFiles) return undefined
  const sourceFiles = files.filter(file => SOURCE_FILE.test(file) && !file.endsWith('.d.ts'))
  const testFiles = files.filter(file => SPEC_FILE.test(file))
  if (sourceFiles.length === 0 || sourceFiles.length > rules.maxSourceFiles || testFiles.length === 0) return undefined
  return { sourceFiles, testFiles }
}

/**
 * Parse `git log --name-only --format=%x00%H%x09%P%x09%s` output into commits.
 * @param log - raw git output.
 * @returns commits with their hash, parents, subject, and changed files.
 */
export function parseGitLog(log: string): Array<{ hash: string; parents: string[]; subject: string; files: string[] }> {
  return log.split('\0').filter(chunk => chunk.trim() !== '').map((chunk) => {
    const [header = '', ...rest] = chunk.split('\n')
    const [hash = '', parents = '', subject = ''] = header.split('\t')
    return {
      hash,
      parents: parents.split(' ').filter(Boolean),
      subject,
      files: rest.map(line => line.trim()).filter(Boolean),
    }
  })
}

/**
 * Mine tasks from the repository's history, newest first.
 * @param repo - repository root.
 * @param limit - most tasks to return.
 * @param rules - size limits.
 * @returns qualifying single-parent fix commits.
 */
export async function mineTasks(repo: string, limit: number, rules: MiningRules = DEFAULT_RULES): Promise<EvalTask[]> {
  // --no-renames: rename detection needs file contents, which a blobless clone fetches one commit at a time.
  const { stdout } = await run('git', ['log', '--no-merges', '--no-renames', '--name-only', '--format=%x00%H%x09%P%x09%s'], {
    cwd: repo,
    maxBuffer: 256 * 1024 * 1024,
  })
  const tasks: EvalTask[] = []
  for (const commit of parseGitLog(stdout)) {
    if (tasks.length >= limit) break
    const parent = commit.parents[0]
    if (parent === undefined || commit.parents.length !== 1) continue
    const classified = classifyCommit(commit.subject, commit.files, rules)
    if (classified === undefined) continue
    tasks.push({
      id: commit.hash.slice(0, 10),
      fixCommit: commit.hash,
      parentCommit: parent,
      subject: commit.subject,
      ...classified,
    })
  }
  return tasks
}

/**
 * Create a detached worktree at the fix commit with its source files reverted
 * to the parent commit, leaving the fix's tests in place.
 * @param repo - repository root.
 * @param task - the task to prepare.
 * @param dir - new worktree directory; must not exist.
 */
export async function prepareWorkspace(repo: string, task: EvalTask, dir: string): Promise<void> {
  await run('git', ['worktree', 'add', '--detach', dir, task.fixCommit], { cwd: repo })
  await run('git', ['checkout', task.parentCommit, '--', ...task.sourceFiles], { cwd: dir })
}

/**
 * Remove a task worktree.
 * @param repo - repository root.
 * @param dir - the worktree directory.
 */
export async function removeWorkspace(repo: string, dir: string): Promise<void> {
  await run('git', ['worktree', 'remove', '--force', dir], { cwd: repo })
}

/**
 * The model-facing task: the failing test output, as a CI report would show it.
 * @param task - the task.
 * @param failure - test runner output from the prepared workspace.
 * @returns the prompt given to the agent.
 */
export function taskPrompt(task: EvalTask, failure: string): string {
  return [
    'These tests fail in this repository:',
    '',
    ...task.testFiles.map(file => `- ${file}`),
    '',
    'Test output:',
    '```',
    failure.trim(),
    '```',
    '',
    'Find the cause in the source code and fix it so the tests pass. Do not modify the test files.',
  ].join('\n')
}
