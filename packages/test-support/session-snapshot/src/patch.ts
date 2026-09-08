/** Materialize test patch layers while preserving plugin resolution. */

import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'

interface ProfilePatchEntry {
  name: string
  group?: boolean | null
  config?: unknown
}

/** Parse a bare package or subpath specifier into its package name. */
function barePackageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) return undefined
  const [first = '', second = ''] = specifier.split('/')
  return first.startsWith('@') ? `${first}/${second}` : first
}

/** Find a bare package's directory from the authored patch's module-resolution anchor. */
function packageDirFromPatch(source: string, packageName: string): string | undefined {
  for (const searchPath of createRequire(pathToFileURL(source)).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
  }
  return undefined
}

/**
 * Install an authored patch's resolvable bare package into the temporary
 * profile fallback. This retains the bare entry
 * name and package provenance used by request metadata.
 */
function linkProfilePackage(source: string, cwd: string, packageName: string): void {
  const packageDir = packageDirFromPatch(source, packageName)
  // The package may instead belong to the dsh installation; profile boot heals those links.
  if (packageDir === undefined) return
  const link = join(cwd, '.dsh', 'profiles', 'node_modules', packageName)
  mkdirSync(dirname(link), { recursive: true })
  if (existsSync(link)) {
    if (realpathSync(link) !== packageDir) {
      throw new Error(`snapshot profile package ${packageName} resolves to two directories`)
    }
    return
  }
  /* v8 ignore next -- Windows uses directory junctions; the platform lane owns that branch. */
  symlinkSync(packageDir, link, process.platform === 'win32' ? 'junction' : 'dir')
}

/**
 * Copy one authored patch into the launch cwd with relative plugin names made absolute.
 * @param source - authored profile patch path.
 * @param cwd - isolated process cwd whose profile fallback receives package links.
 * @param targetDir - existing directory that owns the materialized patch.
 * @param index - stable patch ordinal used in the output filename.
 * @returns absolute materialized patch path.
 */
export function materializeProfilePatch(source: string, cwd: string, targetDir: string, index: number): string {
  const parsed = yaml.load(readFileSync(source, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error(`snapshot profile patch must be a top-level array: ${source}`)
  const patches = parsed as PatchOptions[]
  const baseDir = dirname(source)
  const resolveName = (value: string): string => {
    const packageName = barePackageName(value)
    if (packageName !== undefined) linkProfilePackage(source, cwd, packageName)
    return value.startsWith('./') || value.startsWith('../')
      ? pathToFileURL(resolve(baseDir, value)).href
      : value
  }
  const visitEntry = (entry: ProfilePatchEntry): void => {
    entry.name = resolveName(entry.name)
    if (entry.group === true && Array.isArray(entry.config)) {
      for (const child of entry.config as ProfilePatchEntry[]) visitEntry(child)
    }
  }
  for (const patch of patches) {
    if (typeof patch.name === 'string') patch.name = resolveName(patch.name)
    for (const entry of patch.insert ?? []) visitEntry(entry)
  }
  const target = join(targetDir, `${String(index)}-${basename(source)}`)
  writeFileSync(target, yaml.dump(patches, { schema: entryListSchema, lineWidth: -1, noRefs: true }))
  return target
}
