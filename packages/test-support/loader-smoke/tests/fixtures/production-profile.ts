/** Boot a test overlay over the production base bundle. */

import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  healProfilesModuleFallback,
  initProfile,
  resolveProfileDir,
  loadOverlayPatches,
  loadProfile,
  type ProfileLayer,
} from '@deepseek-ai/dsh-app-boot'

const installAnchor = fileURLToPath(new URL('../../../../../apps/server/package.json', import.meta.url))

function insertedPluginNames(entries: readonly EntryOptions[]): string[] {
  return entries.flatMap((entry) => {
    const children = entry.group && Array.isArray(entry.config)
      ? insertedPluginNames(entry.config as EntryOptions[])
      : []
    return [entry.name, ...children]
  })
}

function packageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('file:') || specifier.includes(':')) return undefined
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

function overlayModuleLayers(path: string, patches: readonly PatchOptions[]): ProfileLayer[] {
  const require = createRequire(path)
  const packages = new Map<string, string>()
  const inserted = patches.flatMap(patch => patch.insert ?? [])
  for (const specifier of insertedPluginNames(inserted)) {
    const name = packageName(specifier)
    if (name === undefined || packages.has(name)) continue
    packages.set(name, dirname(require.resolve(`${name}/package.json`, {
      paths: [dirname(path), dirname(installAnchor)],
    })))
  }
  return [...packages].map(([name, packageDir], index) => ({
    packageName: `test-overlay:${index}:${name}`,
    packageDir,
    patchPath: path,
    patches: [],
  }))
}

/** Inputs for {@link bootProductionProfile}. */
export interface ProductionProfileOptions {
  /** Diagnostic prefix for profile and Loader failures. */
  readonly binName: string
  /** Test overlay files applied above the base bundle layers in order. */
  readonly overlayPaths: readonly string[]
  /** Optional host setup before any composed entry mounts. */
  readonly prepare?: (ctx: Context) => Promise<void> | void
}

/**
 * Load and compose the production base bundle with narrow test overlays.
 *
 * The test profile applies the base bundle without an application runner. Each overlay owns only the
 * test's provider, model, persistence directory, and subject-specific changes.
 * @param options - overlay files and optional host setup.
 * @returns the settled Loader root context.
 */
export async function bootProductionProfile(options: ProductionProfileOptions): Promise<Context> {
  const testProfile = 'test'
  initProfile(resolveProfileDir(testProfile), ['@deepseek-ai/dsh-base'], 'startup')
  const profile = loadProfile(options.binName, testProfile, installAnchor, undefined, { userLayer: false })
  const rootConfig = join(profile.dir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')

  const overlays = options.overlayPaths.map(path => loadOverlayPatches(options.binName, path))
  // Overlay-only packages need profile module visibility in plain-Node mode,
  // but these synthetic layers do not contribute Cordis patches.
  const moduleLayers = options.overlayPaths.flatMap((path, index) => (
    overlayModuleLayers(path, overlays[index] ?? [])
  ))
  await healProfilesModuleFallback({
    installAnchor,
    profile: { ...profile, layers: [...profile.layers, ...moduleLayers] },
  })
  return boot(
    options.binName,
    rootConfig,
    [
      ...profile.layers.flatMap(layer => layer.patches),
      ...overlays.flat(),
    ],
    options.prepare,
  )
}
