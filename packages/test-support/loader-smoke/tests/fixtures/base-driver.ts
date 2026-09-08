#!/usr/bin/env node
/** Snapshot-only Loader driver: stream one fixture turn as canonical JSONL. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { bootProductionProfile } from './production-profile.ts'

const NAME = 'base-test-driver'
const [configPath, ...taskParts] = process.argv.slice(2)
if (configPath === undefined || taskParts.length === 0 || taskParts.every(part => part.trim() === '')) {
  throw new Error(`${NAME}: expected <config-path> <task...>`)
}

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  loadEnv(NAME)
  const patchInput: unknown = configPath.startsWith('[') ? JSON.parse(configPath) : [configPath]
  if (!Array.isArray(patchInput) || !patchInput.every((path): path is string => typeof path === 'string')) {
    throw new Error('base test driver requires a patch path or JSON array of patch paths')
  }
  ctx = await bootProductionProfile({
    binName: NAME,
    overlayPaths: patchInput.map(path => resolveConfigPath(path, undefined)),
  })
  if (ctx.agents.roots().length === 0) {
    const selection = ctx.agentDefaultModel.currentSelection()
    await ctx.agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        const selected: ModelSelectionRef = { current: selection, assembled: undefined }
        installModelSelection(agentCtx, selected)
      },
    })
  }
  const result = await runFixtureTurn(ctx, {
    task: taskParts.join(' '),
    onEvent: (sessionId: string, event: SessionEvent) => {
      process.stdout.write(`${JSON.stringify({ type: 'session_event', sessionId, event })}\n`)
    },
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
