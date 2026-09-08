# Agent Note: dsh source launch through the tsx ESM hook

Status: implemented

English | [中文](2026-07-29-dsh-source-launch-tsx-esm.zh.md)

> Supersedes [native TypeScript source launch](../../archived/architecture/2026-07-28-dsh-native-typescript-source-launch.md): Node removed the capability that decision was built on.

## Problem

The [archived native source-launch decision](../../archived/architecture/2026-07-28-dsh-native-typescript-source-launch.md) ran `apps/server/src/index.ts` under `node --experimental-transform-types` with a resolve-only paths loader, so Node owned TypeScript transformation. Node 26.0.0 removed `--experimental-transform-types` (the process rejects the flag with `bad option`), keeping only strip mode, and strip mode rejects syntax this source graph requires: vendored Cordis parameter properties (`constructor(private ctx: Context)`), the `@Inject` decorators in `vendor/hmr`, and runtime enums/namespaces throughout `vendor/` and `packages/workflow`. The repository's engines range (`^22.19.0 || >=24.0.0`) includes Node 26, so the native launch chain could not start at all there — and no CI job executed the real launch vector, so the incompatibility shipped silently.

Startup latency also mattered: the off-thread `module.register()` hooks worker serialized every resolution across threads (~440ms of `makeSyncRequest` wait during TUI boot), and the full tsx default (`--import tsx`) pays ~0.4s in its CJS hook's resolution amplification.

## Decision

The Web backend source entry runs `node --import tsx/esm apps/server/src/index.ts`: the tsx ESM-only hook owns TypeScript transformation and tsconfig `paths` projection. The root `start` script uses this vector, with artifact generation separate. Source modules must remain ESM; the [Web-only application decision](../simplification/2026-09-04-web-only-application.md) owns product entry scope.

`scripts/tspath-loader.ts` and `apps/server/src/tsconfig-paths-loader.ts` are deleted. With them went the loader's runtime rule of mapping a workspace import only for declared runtime dependencies — tsx applies the `paths` map unconditionally. Declaration completeness now rests on the static gates alone: `verify-cordis-config` for configured bare plugins, and workspace constraints for manifests. (That runtime rule found real bugs: `dsh-plan-mode` and `dsh-tool-jobs` imported `@deepseek-ai/dsh-llm` while declaring it only in devDependencies; since fixed.)

Source-launch verification runs the real backend entry to exercise tsx/ESM module resolution. Backend option and rejected-profile tests live under `apps/server/tests/`.

## Alternatives considered

**Keep the native chain on Node ≤25 and branch by version.** Rejected: two transformation semantics (amaro versus esbuild) diverge on edge syntax, the launcher grows version probing, and the node-compat matrix must cover both paths — heavy maintenance for an experimental flag that already changed under us. amaro also rejects the `@Inject` decorators `vendor/hmr` uses, so the native path could not boot the shipped default TUI config anyway.

**Make the source graph erasable-only so Node 26 strip mode accepts it.** Rejected: parameter properties and value namespaces pervade vendored Cordis/cosmokit/loader/schemastery; rewriting them is unbounded churn re-applied on every vendor sync.

**A repo-owned in-thread loader (`module.registerHooks()` plus an esbuild or `@swc/core` transform).** Rejected: prototypes measured about 0.45s, while the esbuild path lacked end-to-end validation and SWC failed on `vendor/hmr`'s decorator plus namespace merge in both decorator modes. This option also makes the repository own transform correctness and a resolve hook that tsx already provides. Revisit only if the measured 0.3s gap becomes a material cost.

**Run built `lib/` for Node 26 and keep native for 24.** Rejected: loses the zero-build development loop on the newest Node line and mixes source and artifact planes.

## Consequences

- One launch vector across the whole engines range, including future Node lines that change native TypeScript support; the smoke gate enforces it per matrix line.
- TypeScript transformation is delegated to tsx/esbuild again, reversing the prior note's goal of proving Node-native transformation; that goal is unreachable while vendored sources use non-erasable syntax and Node ships no transform mode.
- The runtime declared-dependency enforcement in source launches is gone; undeclared workspace imports now surface only through static gates or built-mode resolution failures.
- The ESM-only hook avoids installing a CommonJS transform for the ESM source graph.
