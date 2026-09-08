# Testing policy

English | [中文](testing.zh.md)

How this repo tests, tier by tier, and the rules that keep a green suite meaningful. Commands live in root [AGENTS.md](../AGENTS.md); linked Agent Notes carry the rationale.

## Tiers

- **Unit** (`pnpm run test`): vitest over package and example specs under their `tests/**` directories plus repository script specs under `scripts/**/*.spec.ts`; tests stay with the code area they exercise. Every registry gets an HMR-safety test (dispose the contributing fiber, assert cleanup). Prefer edge cases, error paths, event ordering, concurrency races, and permanent tests for contract regressions (see `packages/core/agent-loop/tests/contract-regressions.spec.ts`).
- **Coverage gate** (`pnpm run test:coverage`): the gating run, per-file 100% on `packages/*/*/src`. An uncovered line is often dead code the gate flags for deletion, not a missing test to bolt on. Line coverage is necessary, never sufficient — it proves lines ran, not that the feature works as shipped. Per-file 100% on `packages/shell/pwsh-local/src` needs a real `pwsh`: without one its executor suites self-skip and `vitest.config.ts` exempts the file so pwsh-less hosts stay green, while CI runners ship pwsh and enforce the full bar.
- **Real-API e2e** (`pnpm run test:e2e`): with-key tests against live provider APIs — the DeepSeek model plus provider-specific smokes that gate on their own keys (`EXA_API_KEY`, `PERPLEXITY_API_KEY`, …); each suite self-skips without its key so keyless CI stays green ([real-API e2e Agent Note](../.agents/notes/implemented/testing/2026-06-19-real-api-e2e-ci.md)).
- **Owner-local expected output** (`pnpm run test:expected`): keyless assembled backend/process expectations without a recorded-session round trip. Drivers use `*.expected.e2e.ts` beside `tests/expected/`; CI runs built exports. Package/script expectations use `test`, while browser expectations use `test:web`.
- **Snapshot** (`pnpm run test:snapshot`): recorded `session.jsonl` supplies user input, model replay, and the expected persisted result. Web scenarios retain browser and ARIA evidence beside the same session. Mutating scenarios independently compare the complete `workspace.expected/` tree. Use `test:snapshot:record` when a model transcript changes and `test:snapshot:refresh` when replay input remains valid; review every resulting diff.
- **Web browser snapshot** (`pnpm run test:web`; required Linux PR gate): Chromium compares session-driven output under `snapshots/web/` and UI-only output under `apps/web/tests/expected/`. CI forces read-only `DSH_SNAPSHOT=replay`, never writing expected outputs; record/refresh stay local and every diff is reviewed ([web e2e lane](../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.md), [CI gate decision](../.agents/notes/implemented/testing/2026-07-30-web-browser-snapshot-ci-gate.md)). `test:web` [builds first](../.agents/notes/implemented/bug-fix/2026-07-28-themed-scrollbars-and-reserved-gutter.md) for plugin CSS.

Session fixtures keep headers and payloads but omit body sequence/time envelopes. Replay synthesizes them. Fixtures use canonical packed rows; [the migrator](../scripts/migrate-packed-session-fixtures.ts) rewrites old layouts.

## How specs execute

Forked workers run several spec files at once, the coverage gate splits into concurrent partitions beside the other gates in its job, and the self-hosted runners share one host and one volume. Only the process is isolated: ports, predictable paths, external namespaces, and inherited children are not. Own each acquired resource through its teardown, and read a spec that passes only when it runs alone as a defect in the spec rather than an unstable runner. [dsh-ci-test-reliability](../.agents/skills/dsh-ci-test-reliability/SKILL.md) owns the allocation, restoration, synchronization, timeout-budget, platform, and teardown rules; its [flake diagnosis workflow](../.agents/skills/dsh-ci-test-reliability/references/ci-flake-diagnosis.md) classifies an existing probabilistic failure.

## The with-key policy: inference is cheap here

We are DeepSeek — do not ration real-API tests. A no-key test proves plumbing; only a with-key run proves the agent works against a real model. Cover file-writing prompts, multi-turn conversations, tool use, and mid-stream cancellation. Highest-value are **smoke tests** that boot the Web backend, send one prompt, and check the world — they catch the "green unit tests, broken product" class that mocks cannot ([postmortem 0001](postmortem/0001-acp-default-export-drops-inject.md)). Self-skip keeps secretless CI and keyless contributors unblocked; it is not a cost signal. Profile-level integration tests live under `apps/server/tests/profiles/`; package-specific compositions stay with their package tests.

## Prefer the real implementation over a mock

Mock only the expensive or non-deterministic boundary (LLM adapter, network, clock); keep everything downstream real. A hand-rolled stand-in proves the bridge moves bytes, not that the shipping tool behaves as asserted.

Recovery tests separate pre/post-chunk failures by step and prove failed chunks derive no message or tool side effect. Cover exhaustion, cancellation, policy composition, persistence, status, wire counts, transport-closing idle timeouts, and shipping Loader composition.

## Verify the world, not the self-report

An e2e assertion re-runs the command or re-reads the file externally; a keyword probe on the agent's own output lets a cheating agent pass. Assert untouched files are byte-identical. e2e tests own their resources: create it in the test, dispose in `afterEach` (even on failure/retry/timeout); shared fixtures live in a plain `tests/harness.ts`, never another `*.e2e.ts` (importing a spec re-registers its `describe` and duplicates real API calls).

## Test the real entry path

- Product-visible plugins require a non-unit REAL-composition test. Hand-built `ctx.plugin(...)` suites are insufficient: boot test-only `cordis.yml` through Loader and app/process, mock only external services or nondeterministic inputs, and assert model-visible request/log, durable state, or user-visible output. Keep opt-ins out of shipped defaults.
- A guard only guards if the regression fails it. For a plugin without `inject` (bundle/composition plugins), a Loader smoke stays green when a default export replaces the required named exports — add an explicit `expect('default' in mod).toBe(false)` plus an `unwrapExports` round-trip assertion, and prove it: introduce the regression, watch red, revert.
- "Real entry path" includes the built backend entry `apps/server/lib/index.js` under plain Node, worker entries, and modules shared across bundles. Built-artifact smokes verify startup, module resolution, and shutdown; assert that missing configuration exits non-zero.

## Test resolution: source plane only

- Every vitest config points vite-tsconfig-paths at `tsconfig.base.json`; bare workspace imports resolve to `src` ([layout](development.md#typescript-project-layout)), never through package `exports` to built `lib/` — stale artifacts there load a second copy of module singletons. Built artifacts are consumed only explicitly: `lib`-mode subprocesses and the built smokes below.

## Test subprocess launch modes

- CI and build-having test lanes run every profile or Cordis-config subprocess from built `lib/` through the shared dual-mode launcher. Do not hand-write `--import tsx` for these subprocesses.
- Protocol and operating-system fixtures that do not load Cordis run erasable `.ts` directly with Node, without tsx or the root paths map.
- Only a test whose subject is source-path resolution may select `src`; state that contract in the test.

## When a snapshot test is required

Every non-trivial model-, protocol-, or user-visible change adds or updates a keyless recorded-session scenario in the same PR. Web recordings live under `snapshots/web/`; core agent and tool recordings under `snapshots/session/` use the internal `test-base` driver. Expected output that is not driven by a recorded session stays with its owning app, package, or script under `tests/expected/`. [`dsh-session-snapshot`](../packages/test-support/session-snapshot/README.md) owns shared storage rules. Agent-loop, session-lifecycle, and `SessionEventMap` changes cover the backend events and durable state consumed by the browser.
