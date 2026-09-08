/** Web backend process entry: configuration, plugin activation, HTTP serving, and shutdown. */
import { readFileSync } from 'node:fs'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { parseServerArgs } from './args.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
const invocation = parseServerArgs(process.argv.slice(2), manifest.version)

if (invocation.dumpConfig) {
  const { runDumpConfig } = await import('./dump-config.ts')
  runDumpConfig('web', invocation.defaultOnly, invocation.patches)
} else {
  const { runProfile } = await import('./profile-boot.ts')
  await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'web',
    patchFiles: invocation.patches,
    args: invocation.args,
  })
}
