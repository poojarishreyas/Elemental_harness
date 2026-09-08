import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const entry = fileURLToPath(new URL('../lib/index.js', import.meta.url))

describe('built Web backend', () => {
  it('composes a fresh Web configuration without an SDK or headless runner', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-web-config-'))
    try {
      const result = await execa(process.execPath, [entry, '--dump-default-config'], {
        env: { DSH_HOME: home }, timeout: 60_000, killSignal: 'SIGKILL', reject: false,
      })
      expect(result.timedOut).toBe(false)
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toContain('@deepseek-ai/dsh-web-app')
      expect(result.stdout).toContain('@deepseek-ai/dsh-agent-loop')
      expect(result.stdout).not.toMatch(/dsh-sdk-|dsh-headless|dsh-acp/)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 70_000)

  it('rejects standalone profile selection', async () => {
    const result = await execa(process.execPath, [entry, '--profile', 'sdk'], {
      timeout: 30_000, killSignal: 'SIGKILL', reject: false,
    })
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('serves the Web GUI only')
  }, 40_000)
})
