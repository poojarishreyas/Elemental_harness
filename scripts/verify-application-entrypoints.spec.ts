/** Application-entrypoint classification and Web backend launch enforcement. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applicationEntrypointViolations } from './verify-application-entrypoints.ts'

const cleanups: string[] = []

afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-application-entrypoints-'))
  cleanups.push(root)
  return root
}

function write(root: string, path: string, content: string): void {
  const target = resolve(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

describe('application entrypoints', () => {
  it('accepts the repository launcher inventory', () => {
    expect(applicationEntrypointViolations(resolve(import.meta.dirname, '..'))).toEqual([])
  })

  it('rejects a package-level application bin', () => {
    const root = fixture()
    write(root, 'packages/example/app/package.json', JSON.stringify({ bin: { app: 'lib/bin.js' } }))

    expect(applicationEntrypointViolations(root)).toEqual([
      'packages/example/app/package.json: product packages expose no bins; applications start apps/server',
    ])
  })

  it('rejects an unclassified executable source', () => {
    const root = fixture()
    write(root, 'packages/example/app/src/bin.ts', '#!/usr/bin/env node\n')

    expect(applicationEntrypointViolations(root)).toEqual([
      'packages/example/app/src/bin.ts: executable source has no application/build/test classification',
    ])
  })

  it('rejects an executable at an application package root', () => {
    const root = fixture()
    write(root, 'apps/example/rogue.mjs', '#!/usr/bin/env node\n')

    expect(applicationEntrypointViolations(root)).toEqual([
      'apps/example/rogue.mjs: executable source has no application/build/test classification',
    ])
  })

  it('rejects an executable at the repository root', () => {
    const root = fixture()
    write(root, 'rogue.mjs', '#!/usr/bin/env node\n')

    expect(applicationEntrypointViolations(root)).toEqual([
      'rogue.mjs: executable source has no application/build/test classification',
    ])
  })

  it('rejects an unclassified executable in an app workspace', () => {
    const root = fixture()
    write(root, 'apps/rogue/src/bin.ts', '#!/usr/bin/env node\n')

    expect(applicationEntrypointViolations(root)).toEqual([
      'apps/rogue/src/bin.ts: executable source has no application/build/test classification',
    ])
  })

  it('rejects a public executable bin on the backend package', () => {
    const root = fixture()
    write(root, 'apps/server/package.json', JSON.stringify({ bin: { dsh: 'lib/index.js' } }))

    expect(applicationEntrypointViolations(root)).toEqual([
      'apps/server/package.json: product packages expose no bins; applications start apps/server',
    ])
  })

  it('rejects missing or redirected server launch commands', () => {
    const root = fixture()
    write(root, 'package.json', JSON.stringify({ scripts: { start: 'node rogue.js' } }))

    expect(applicationEntrypointViolations(root)).toEqual([
      'package.json scripts.start: Web backend launch must be node --import tsx/esm apps/server/src/index.ts',
      'package.json scripts.start:built: Web backend launch must be node apps/server/lib/index.js',
    ])
  })

  it('rejects standalone CLI and demo commands alongside valid Web launchers', () => {
    const root = fixture()
    write(root, 'package.json', JSON.stringify({ scripts: {
      start: 'node --import tsx/esm apps/server/src/index.ts',
      'start:built': 'node apps/server/lib/index.js',
      dsh: 'node old-cli.js',
      'demo:example': 'node demo.js',
    } }))

    expect(applicationEntrypointViolations(root)).toEqual([
      'package.json scripts.demo:example: standalone CLI and demo launchers are unsupported',
      'package.json scripts.dsh: standalone CLI and demo launchers are unsupported',
    ])
  })
})
