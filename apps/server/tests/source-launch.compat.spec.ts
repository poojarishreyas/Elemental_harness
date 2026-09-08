import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const entry = 'apps/server/src/index.ts'

describe('Web backend source entry', () => {
  it('uses the ESM source launcher from the root start command', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(manifest.scripts.start).toBe('node --import tsx/esm apps/server/src/index.ts')
  })

  it('rejects removed standalone profiles before booting', async () => {
    const result = await execa(process.execPath, ['--import', 'tsx/esm', entry, '--profile', 'sdk'], {
      cwd: repoRoot, input: '', timeout: 30_000, killSignal: 'SIGKILL', reject: false,
    })
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('serves the Web GUI only')
  }, 40_000)
})
