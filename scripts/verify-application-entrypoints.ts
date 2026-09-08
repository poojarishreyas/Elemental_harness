/**
 * Enforce the Web backend as the only supported Node application launcher.
 * Vendor CLIs, build tools, and test tools are explicit classifications
 * rather than implicit holes.
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

type ManifestBin = string | Record<string, string>

interface PackageManifest {
  readonly bin?: unknown
}

interface RootManifest {
  readonly scripts?: Record<string, unknown>
}

/** Private build-only WebWorker packer; product packages expose no executable bins. */
const MANIFEST_BIN_ALLOWLIST = new Map<string, ManifestBin>([
  ['packages/experimental/webworker-packer/package.json', { 'dsh-pack-vfs-image': './bin.js' }],
])

/** Every executable in a Node application workspace has one explicit role. */
const EXECUTABLE_SOURCE_ALLOWLIST = new Map<string, string>([
  ['apps/server/src/index.ts', 'supported Web backend launcher'],
  ['packages/context/time-context/tests/fixtures/driver.ts', 'test-only subprocess driver'],
  ['packages/experimental/webworker-packer/bin.js', 'private build-only wrapper'],
  ['packages/experimental/webworker-packer/src/bin.ts', 'private build-only implementation'],
  ['packages/session/session-telemetry-otel/tests/fixtures/driver.ts', 'test-only subprocess driver'],
  ['packages/shell/tool-pwsh/tests/fixtures/loader/driver.ts', 'test-only subprocess driver'],
  ['packages/subagent/subagent-acp/tests/fixtures/loader/driver.ts', 'test-only subprocess driver'],
  ['packages/subagent/subagent-claude-code/tests/fixtures/loader/driver.ts', 'test-only subprocess driver'],
  ['packages/subagent/subagent-codex/tests/fixtures/loader/driver.ts', 'test-only subprocess driver'],
  ['packages/test-support/loader-smoke/tests/fixtures/base-driver.ts', 'test-only subprocess driver'],
  ['packages/test-support/llm-mock-server/src/bin.ts', 'test-only model server'],
])

const ROOT_SERVER_COMMANDS = new Map<string, string>([
  ['start', 'node --import tsx/esm apps/server/src/index.ts'],
  ['start:built', 'node apps/server/lib/index.js'],
])

const SOURCE_PATTERNS = [
  '*.ts',
  '*.js',
  '*.mjs',
  '*.cjs',
  'apps/**/*.ts',
  'apps/**/*.js',
  'apps/**/*.mjs',
  'apps/**/*.cjs',
  'packages/**/*.ts',
  'packages/**/*.js',
  'packages/**/*.mjs',
  'packages/**/*.cjs',
]

const SOURCE_EXCLUDES = [
  '**/node_modules/**',
  '**/lib/**',
  '**/dist/**',
  '**/coverage/**',
]

/** Convert a host path from glob output to the repository's slash form. */
function repositoryPath(path: string): string {
  return path.split(sep).join('/')
}

/** Stable comparison for string and object npm `bin` declarations. */
function normalizedBin(value: unknown): string | undefined {
  if (typeof value === 'string') return JSON.stringify(value)
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value)
  if (!entries.every(([, target]) => typeof target === 'string')) return undefined
  return JSON.stringify(Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))))
}

function manifestBinViolations(root: string): string[] {
  const failures: string[] = []
  const manifests = globSync(['apps/*/package.json', 'packages/*/*/package.json'], { cwd: root }).sort()
  for (const rawPath of manifests) {
    const path = repositoryPath(rawPath)
    const manifest = JSON.parse(readFileSync(resolve(root, path), 'utf8')) as PackageManifest
    if (manifest.bin === undefined) continue
    const expected = MANIFEST_BIN_ALLOWLIST.get(path)
    if (expected === undefined) {
      failures.push(`${path}: product packages expose no bins; applications start apps/server`)
      continue
    }
    if (normalizedBin(manifest.bin) !== normalizedBin(expected)) {
      failures.push(`${path}: classified bin must remain ${JSON.stringify(expected)}, got ${JSON.stringify(manifest.bin)}`)
    }
  }
  return failures
}

function executableSourceViolations(root: string): string[] {
  const failures: string[] = []
  for (const rawPath of globSync(SOURCE_PATTERNS, { cwd: root, exclude: SOURCE_EXCLUDES }).sort()) {
    const path = repositoryPath(rawPath)
    const source = readFileSync(resolve(root, path), 'utf8')
    if (!source.startsWith('#!')) continue
    if (!EXECUTABLE_SOURCE_ALLOWLIST.has(path)) {
      failures.push(`${path}: executable source has no application/build/test classification`)
    }
  }
  return failures
}

function rootLauncherViolations(root: string): string[] {
  const manifestPath = resolve(root, 'package.json')
  if (!existsSync(manifestPath)) return []
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RootManifest
  const failures: string[] = []
  for (const [name, expected] of ROOT_SERVER_COMMANDS) {
    if (manifest.scripts?.[name] !== expected) {
      failures.push(`package.json scripts.${name}: Web backend launch must be ${expected}`)
    }
  }
  for (const name of Object.keys(manifest.scripts ?? {}).sort()) {
    if (name === 'dsh' || name.startsWith('demo:')) {
      failures.push(`package.json scripts.${name}: standalone CLI and demo launchers are unsupported`)
    }
  }
  return failures
}

/**
 * Find unsupported application entrypoints below a repository root.
 * @param root - repository or test-fixture root.
 * @returns deterministic path-qualified violations.
 */
export function applicationEntrypointViolations(root: string): string[] {
  return [
    ...manifestBinViolations(root),
    ...executableSourceViolations(root),
    ...rootLauncherViolations(root),
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '..')
  const failures = applicationEntrypointViolations(root)
  if (failures.length > 0) {
    console.error('verify-application-entrypoints: unsupported launcher(s):')
    for (const failure of failures) console.error(`  ${failure}`)
    process.exitCode = 1
  } else {
    console.log('verify-application-entrypoints: the Web backend is the only supported Node application launcher.')
  }
}
