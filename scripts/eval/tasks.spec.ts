import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyCommit, difficultyTags, mineTasks, packageOf, parseGitLog, prepareWorkspace, removeWorkspace, taskPrompt } from './tasks.ts'

const git = promisify(execFile)
let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('classifyCommit', () => {
  const src = 'packages/core/session/src/index.ts'
  const spec = 'packages/core/session/tests/session.spec.ts'

  it('accepts a small fix with source and spec changes', () => {
    expect(classifyCommit('fix(session): keep order', [src, spec, 'README.md'])).toEqual({ sourceFiles: [src], testFiles: [spec] })
    expect(classifyCommit('Prevent a double append', [src, spec])).toBeDefined()
    expect(classifyCommit('Tidy things', [src, spec, '.agents/notes/implemented/bug-fix/2026-01-01-x.md'])).toBeDefined()
    expect(classifyCommit('fix(app): x', ['apps/server/src/main.ts', 'apps/server/tests/main.spec.ts'])).toBeDefined()
  })

  it('rejects non-fixes, missing tests, declaration-only, and oversized commits', () => {
    expect(classifyCommit('Add a feature', [src, spec])).toBeUndefined()
    expect(classifyCommit('fix: x', [src])).toBeUndefined()
    expect(classifyCommit('fix: x', ['packages/a/b/src/types.d.ts', spec])).toBeUndefined()
    expect(classifyCommit('fix: x', [spec, 'packages/a/b/src/1.ts', 'packages/a/b/src/2.ts', 'packages/a/b/src/3.ts', 'packages/a/b/src/4.ts'])).toBeUndefined()
    expect(classifyCommit('fix: x', [src, spec], { maxSourceFiles: 3, maxChangedFiles: 1 })).toBeUndefined()
  })
})

describe('parseGitLog', () => {
  it('splits NUL-separated commits into hash, parents, subject, and files', () => {
    const log = '\0aaa\tppp\tfix: one\n\nsrc/a.ts\ntests/a.spec.ts\n\0bbb\tp1 p2\tmerge\n\n'
    expect(parseGitLog(log)).toEqual([
      { hash: 'aaa', parents: ['ppp'], subject: 'fix: one', files: ['src/a.ts', 'tests/a.spec.ts'] },
      { hash: 'bbb', parents: ['p1', 'p2'], subject: 'merge', files: [] },
    ])
  })
})

describe('taskPrompt', () => {
  it('shows the failing tests and forbids editing them without naming the source', () => {
    const prompt = taskPrompt({
      id: 'abc',
      fixCommit: 'f',
      parentCommit: 'p',
      subject: 'fix: secret subject',
      sourceFiles: ['packages/a/b/src/hidden.ts'],
      testFiles: ['packages/a/b/tests/b.spec.ts'],
    }, '  FAIL b.spec.ts > keeps order  ')
    expect(prompt).toContain('- packages/a/b/tests/b.spec.ts')
    expect(prompt).toContain('FAIL b.spec.ts > keeps order')
    expect(prompt).toContain('Do not modify the test files.')
    expect(prompt).not.toContain('hidden.ts')
    expect(prompt).not.toContain('secret subject')
  })
})

describe('mining and preparing from a real repository', () => {
  async function commit(repo: string, files: Record<string, string>, message: string): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(repo, path, '..'), { recursive: true })
      await writeFile(join(repo, path), content)
    }
    await git('git', ['add', '-A'], { cwd: repo })
    await git('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.com', 'commit', '-q', '-m', message], { cwd: repo })
  }

  it('mines the fix and prepares a worktree with the source reverted and the tests kept', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-eval-tasks-'))
    const repo = join(root, 'repo')
    await mkdir(repo)
    await git('git', ['init', '-q'], { cwd: repo })
    const src = 'packages/core/math/src/add.ts'
    const spec = 'packages/core/math/tests/add.spec.ts'
    await commit(repo, { [src]: 'export const add = (a, b) => a - b\n', 'README.md': 'x\n' }, 'Add math')
    await commit(repo, { [src]: 'export const add = (a, b) => a + b\n', [spec]: 'test\n' }, 'fix(math): add adds')

    const tasks = await mineTasks(repo, 10)
    expect(tasks).toHaveLength(1)
    const [task] = tasks
    expect(task).toMatchObject({ subject: 'fix(math): add adds', sourceFiles: [src], testFiles: [spec] })
    expect(await mineTasks(repo, 0)).toEqual([])

    const workspace = join(root, 'workspace')
    await prepareWorkspace(repo, task!, workspace)
    // Git may check files out with CRLF line endings on Windows.
    const text = async (path: string): Promise<string> => (await readFile(join(workspace, path), 'utf8')).replaceAll('\r\n', '\n')
    expect(await text(src)).toBe('export const add = (a, b) => a - b\n')
    expect(await text(spec)).toBe('test\n')
    await removeWorkspace(repo, workspace)
    await expect(readFile(join(workspace, src), 'utf8')).rejects.toThrow()
  })

  it('deletes a source file the fix created instead of failing to restore it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-eval-tasks-'))
    const repo = join(root, 'repo')
    await mkdir(repo)
    await git('git', ['init', '-q'], { cwd: repo })
    const src = 'packages/core/math/src/add.ts'
    const created = 'packages/core/math/src/sum.ts'
    const spec = 'packages/core/math/tests/add.spec.ts'
    await commit(repo, { [src]: 'old\n' }, 'Add math')
    await commit(repo, { [src]: 'new\n', [created]: 'sum\n', [spec]: 'test\n' }, 'fix(math): add sum')

    const [task] = await mineTasks(repo, 10)
    const workspace = join(root, 'workspace')
    await prepareWorkspace(repo, task!, workspace)
    expect((await readFile(join(workspace, src), 'utf8')).replaceAll('\r\n', '\n')).toBe('old\n')
    await expect(readFile(join(workspace, created), 'utf8')).rejects.toThrow()
    await removeWorkspace(repo, workspace)
  })
})

describe('difficultyTags', () => {
  const testFile = 'packages/client/ui-x/tests/section.spec.tsx'

  it('maps paths to their package or app', () => {
    expect(packageOf('packages/client/ui-x/src/a.ts')).toBe('packages/client/ui-x')
    expect(packageOf('apps/web/src/a.ts')).toBe('apps/web')
  })

  it('calls a same-package fix the test imports direct', () => {
    const task = { sourceFiles: ['packages/client/ui-x/src/client/Section.tsx'], testFiles: [testFile] }
    expect(difficultyTags(task, ["import { Section } from '../src/client/Section.tsx'"])).toEqual(['direct'])
  })

  it('treats an imported index file as importing its directory', () => {
    const task = { sourceFiles: ['packages/client/ui-x/src/client/index.ts'], testFiles: [testFile] }
    expect(difficultyTags(task, ["const mod = await import('../src/client')"])).toEqual(['direct'])
  })

  it('tags fixes the test never imports, in other packages, or across files', () => {
    const task = {
      sourceFiles: ['packages/client/ui-x/src/client/helper.ts', 'packages/core/engine/src/run.ts'],
      testFiles: [testFile],
    }
    expect(difficultyTags(task, ["vi.mock('../src/client/other.ts')"])).toEqual(['cross-package', 'indirect', 'multi-file'])
  })
})
