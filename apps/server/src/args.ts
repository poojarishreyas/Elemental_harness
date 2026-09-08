/** Web backend configuration arguments; the Web startup plugin owns HTTP options. */
import { Command } from 'commander'

/** Parsed configuration overlays and arguments for the Web startup plugin. */
export interface ServerInvocation {
  /** Ordered configuration overlays applied after the persisted Web configuration. */
  patches: string[]
  /** HTTP options forwarded to the Web startup plugin. */
  args: string[]
  /** Whether to print the effective configuration instead of starting the server. */
  dumpConfig: boolean
  /** Whether the configuration dump omits user overrides. */
  defaultOnly: boolean
}

/**
 * Parse backend configuration options, rejecting standalone application commands.
 * @param argv - arguments after the Node executable and server entry.
 * @param version - application version for `--version`.
 * @returns the Web backend invocation; Commander exits for usage errors or version output.
 */
export function parseServerArgs(argv: readonly string[], version: string): ServerInvocation {
  const program = new Command()
    .name('pnpm start')
    .version(version)
    .helpOption(false)
    .allowUnknownOption()
    .argument('[args...]', 'Web server options')
    .option('--patch <path>', 'additional configuration overlay (repeatable)',
      (value: string, previous: string[]) => [...previous, value], [])
    .option('--dump-config', 'print the effective Web configuration and exit')
    .option('--dump-default-config', 'print the bundled Web configuration and exit')
  if (argv.some(arg => arg === '--profile' || arg.startsWith('--profile='))) {
    program.error('error: this application serves the Web GUI only; --profile is not supported')
  }
  program.parse([...argv], { from: 'user' })
  const options = program.opts<{ patch: string[]; dumpConfig?: boolean; dumpDefaultConfig?: boolean }>()
  if (options.patch.some(path => path.trim() === '')) program.error('error: --patch needs a path')
  if (options.dumpConfig === true && options.dumpDefaultConfig === true) {
    program.error('error: --dump-config and --dump-default-config are mutually exclusive')
  }
  const defaultOnly = options.dumpDefaultConfig === true
  const dumpConfig = options.dumpConfig === true || defaultOnly
  if (dumpConfig && program.args.length > 0) program.error('error: configuration dumps take no Web server options')
  if (defaultOnly && options.patch.length > 0) program.error('error: --dump-default-config takes no --patch')
  return { patches: options.patch, args: program.args, dumpConfig, defaultOnly }
}
