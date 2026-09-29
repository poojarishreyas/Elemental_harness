# Open questions

Every ambiguity found while researching, with what was already checked. Anything still unresolved when a chapter needs it gets written as ❓ **Unknown** in the book rather than guessed.

Status key: **OPEN** (needs an answer), **NEEDS-USER** (only the user can decide), **RESOLVED** (answer recorded inline).

---

## Q1 — Can anything be run-verified at all? · RESOLVED (user decision: no)

**Decision (2026-09-21): the user chose code-only. No `pnpm install`, no test runs.**
Therefore the book's evidence ceiling is ✅ *Verified (code)*; the 🧪 *Verified (run)* level is used nowhere, and the README/evidence-report must say so plainly. Behavioral claims about termination and edge cases rest on reading the implementation — the riskiest category, so those sections get extra re-reading during Phase 5 instead of empirical confirmation.

Original analysis follows.

---

### (original) Q1 — Can anything be run-verified at all?

`node_modules` is absent from this checkout (verified: `test -d node_modules` fails; `package.json` declares `packageManager: pnpm@11.7.0`, `engines.node: ^22.19.0 || >=24.0.0`; local Node is v24.19.0).

Consequence: **zero** claims in the book can carry the 🧪 *Verified (run)* level. Everything is ✅ *Verified (code)*.

What would resolve it: `pnpm install` (network fetch, large dependency tree, writes into the repo). The most valuable targets afterwards would be:
- `pnpm run test:snapshot` — described in AGENTS.md as *keyless* recorded-session replay, so it needs no API key and would let the book show genuinely captured behavior.
- `vitest run packages/core/agent-loop` — 19 spec files exist covering cancel, resume, tool-order, properties, contract-regressions.

Decision needed from the user before running an install.

---

## Q2 — Is the agent-loop invariant actually mounted? · RESOLVED

**Answer: NO. It does not run in the shipped `web` profile.** This materially changes Ch 11.

Evidence:
- `dsh-invariants` (the registry that runs every `src/invariant.ts` companion) lives at `packages/runtime-diagnostics/invariants`.
- Grepping **every** `.yml`/`.yaml` in the repo for `dsh-invariants` returns only `pnpm-lock.yaml` dependency entries — **zero plugin rows**, in `bundle/base`, `bundle/web-app`, the `standard` preset, or any example overlay.
- No env seam: grep for `DSH_INVARIANT` across `.ts`/`.yml` returns nothing.
- The package's own README §"When to use it" states it directly: *"`dsh-base` deliberately omits runtime diagnostics. Custom compositions mount the registry and add companions... Loading the registry alone installs no checks."*

So `agent-loop/src/invariant.ts` is a **diagnostic companion available to custom compositions and exercised by tests** — an executable specification of the engine's central contract — not a guarantee enforced at runtime in the shipped product. Ch 11 must say exactly this. The chapter keeps its place in the outline: the invariant is still the clearest statement of the design thesis, and it is real, runnable code; it simply is not switched on by default.

⚠️ **Docs-vs-code discrepancy for the evidence report.** The same README contradicts itself: §Summary line 10 claims "the standard agent composition already mounts it with the four core companions," while §When-to-use (line 30) says `dsh-base` omits it. The composition files settle it — nothing mounts it. Per the ground rules, the README is a claim, not evidence.

Also noted from the README's own limitations, relevant to Ch 11: "Request reconstruction covers loop-built requests only" — direct one-shot LLM calls (e.g. compaction's summarization request) are outside the contract even when frozen and carrying a session id.

### (original) Q2

`packages/core/agent-loop/src/invariant.ts` defines a companion plugin (`name = 'agent-loop-invariant'`) that machine-checks the engine's central contract (request messages must equal `session.deriveMessages()`).

Checked so far:
- It is a real export: `package.json` exports `./invariant` → `./lib/invariant.js`.
- `tsconfig.base.json:318` maps `@deepseek-ai/dsh-agent-loop/invariant`.
- It does **not** appear as a row id in `packages/bundle/base/cordis.patch.yml` or `packages/bundle/web-app/cordis.patch.yml`.
- `packages/workflow/workflow-worker-thread/tests/integration.spec.ts:9` imports it, so it is at least exercised in tests.
- ~30 other packages define a parallel `src/invariant.ts` with the identical `ctx.invariants.register(PACKAGE_NAME, install)` shape, so there is clearly a generic mounting mechanism.

Still needed: find what loads these companions (an `invariants` service with a discovery/filter mechanism?) and whether it is active in a normal `web` run or only under tests/dev. **This matters a lot** — if the invariant runs in production it is a load-bearing runtime guarantee; if it is dev/test-only it is a testing device, and the book must say which.

---

## Q3 — Is `reasoning-chunks` a real session event? · RESOLVED

**Answer: it is neither a session event nor a snapshot artifact. It is a lossless storage-compression row.** My original hypothesis (below) was wrong; recording that here because it is a good example of why names must not be trusted.

Source: `packages/core/session/src/chunk-rows.ts` (371 lines), ✅ verified by reading the whole module.

- `ChunkRow` (`chunk-rows.ts:66-69`) has exactly three variants: `text-chunks`, `reasoning-chunks`, `tool-call-chunks`.
- The module doc (`:9-12`) states packed rows "are an encoding vocabulary, NOT session events: they never enter `Session.events`, have no `SessionEventMap` entry, and use bare (slash-less) type tags" — and the code bears this out: `decodeStorageRecord` (`:363-370`) expands them back to `assistant/chunk` events before anything else sees them.
- `packChunkRuns` (`:214-243`) packs a run of ≥ `MIN_RUN` consecutive, whitelisted, same-kind, same-block delta chunks into one row. `MIN_RUN = 3` (`:99`), documented as a format constant rather than a tunable because both layouts decode identically.
- `dt` (`:44-45`) holds epoch-ms **gaps**, length one less than the member count; member *k* reconstructs as seq `seq0 + k` and time `time0` plus the first *k* gaps. Gaps may be negative if the wall clock steps backwards.
- Round-trip safety is enforced hard: `classify` (`:118-145`) whitelists *exact* key sets and primitive types, falling through to verbatim storage for anything unrecognized ("unknown fields or future chunk variants lose compression, never data"). `continues` (`:158-173`) refuses to extend a run when `next.time - prev.time` is not a safe integer. `validateRow` (`:270-312`) re-checks that every reconstructed seq and time stays in safe-integer range, and `malformed()` throws rather than silently dropping a run.
- Used by both persistence and bounded history transport (`:13`).

So `snapshots/session/text-turn/session.jsonl:15` is a genuine persisted line: a packed run of 20 reasoning deltas. The book should present this as a real mechanism (good Part III chapter material — a concrete problem with a measurable payoff) and must **not** describe it as a session event type.

⚠️ One unverified figure: the module doc claims "~56× measured on a real DeepSeek session" for envelope overhead. That is a comment, not code — cite it as the authors' claim, not as a verified measurement.

Original (incorrect) analysis follows.

---

### (original, superseded) Q3

`snapshots/session/text-turn/session.jsonl:15` contains an event of type `reasoning-chunks` with fields `{turn, step, index, dt: number[], texts: string[]}`.

But the loop only ever appends `assistant/chunk` (`agent.ts:368`). The same file also contains ordinary `assistant/chunk` events carrying `block-start`/`text-delta`/`block-end`/`usage`/`finish` chunks.

Hypothesis (**unconfirmed**): the snapshot writer collapses a run of reasoning text-delta chunks into one compact event with inter-chunk timings (`dt`), purely for fixture readability/stability — i.e. it is a *snapshot serialization* form, not a session event type.

Must be confirmed against the snapshot normalizer before any chapter shows this file as a raw session log. If unconfirmed, the book shows the `assistant/chunk` lines and explicitly notes that the fixture is normalized.

---

## Q4 — What normalizes the snapshot fixtures? · LOCATED, not yet read

The normalizer is `packages/test-support/session-snapshot/src/normalize.ts`, with `suite.ts` beside it and specs at `tests/normalize.spec.ts`, `tests/identity.spec.ts`, `tests/suite.spec.ts`. Related: `packages/test-support/llm-replay/` supplies the keyless replay side.

Note this is **test-support**, so the `{{…}}` placeholders are a fixture-normalization concern only — they never appear in a live session log. (Contrast Q3: `reasoning-chunks` *is* live storage.) Still to read: the exact substitution rules, so quotations can state precisely how the fixture differs from a live log.

### (original) Q4

`snapshots/session/text-turn/session.jsonl` contains placeholder tokens: `{{session:1}}`, `{{cwd}}`, `{{message:1}}`, `{{message:2}}`, `{{message:3}}`, and — inside the `request/header` event — `{{system}}` and `{{tools}}`.

So the fixture is **not** a byte-faithful session log; ids, paths, and the two largest payloads are substituted. The real system prompt and tool schemas live beside it in `system-prompt.expected.md` and `tool-schemas.expected.json`.

Needed: the normalizer's location and exact substitution rules, so the book can state precisely how the shown data differs from a live log. Until then every quotation of this file must be labelled "snapshot-normalized fixture".

---

## Q5 — `version: 0` in the session header vs `SESSION_FORMAT_VERSION` · OPEN

`session.jsonl:1` is `{"type":"session","version":0,...}`. AGENTS.md claims `SESSION_FORMAT_VERSION` bumps only on structural format changes, and that released Session JSONL generations are never moved or overwritten.

Needed: where `SESSION_FORMAT_VERSION` is defined, whether the `version` field in the header event is that same constant, and what `delegationDepth: 0` (same line) governs.

---

## Q6 — Does anything register an `agent/request-error` retry listener? · OPEN (delegated)

The step loop retries a failed request **only** if a waterfall listener returns `{kind:'retry'}` (`agent.ts:404-407`); the engine never retries on its own.

`packages/bundle/base/cordis.patch.yml:84-85` mounts `@deepseek-ai/dsh-llm-retry`, and `snapshots/session/empty-response-retry/` exists as a recorded scenario — both strongly suggest a real retry listener, but neither is proof of *which* extension point it uses. A research agent is checking. If nothing registers it, that must be stated plainly.

---

## Q7 — Which of the three composition layers wins, per row? · PARTIALLY RESOLVED

Established by reading the files directly:
1. `packages/bundle/base/cordis.patch.yml` inserts the shared core.
2. `packages/bundle/web-app/cordis.patch.yml` overrides rows **by id**, and sets `disabled: true` on most agent-plane rows.
3. `packages/preset/agent-presets/presets/standard/agent.cordis.yml` re-mounts the agent plane per-agent, some rows inside `cordis:group` entries carrying `isolate:` realms.

A patch **replaces** a targeted row's whole `config` rather than merging into it (stated in both patch headers — *treated as a claim to verify against the Loader, not as evidence*).

Still needed: the Loader code proving the merge/override semantics, and how/when the preset layer mounts relative to session creation. Delegated.

Config values that genuinely differ between layer 1 and layer 3 (so the book must quote the preset, not the base, for web):
- `tool-web`: `fetch: false` (base) → `fetch: true` (standard preset)
- `tool-subagent-fork`: `backgroundMode: one-shot` (base) → `continuable` (standard preset)

---

## Q9 — How does a provider route become live when config disables it? · RESOLVED

**Answer: by writing the `llm-pi-ai:` user-settings section, which registers routes live without a restart. The disabled `llm-deepseek` Cordis row is never re-enabled.**

Verified in `packages/llm/llm-pi-ai/src/index.ts`:
- `ensureRegistrationFacts()` (`:271-293`) is called once at mount (`:294`). With an empty `providers` dict, `routes.length === 0`, so it records the facts and **returns without registering anything** (`:284-287`) — the documented "dormant bare mount."
- The plugin installs a settings section named `llm-pi-ai` (`:296-330`, `NS = 'llm-pi-ai'` at `:92`) through `settings.installSection`.
- Its `onChange` (`:305-329`) re-runs `ensureRegistrationFacts()`, which on the first non-empty profile set calls `ctx.llm.registerAdapter(routes, adapter)` (`:288`). Subsequent changes use `registration.replace(routes)` (`:290`) — an atomic same-instance swap.
- `registeredFacts` only advances once the registry actually holds the new set, so a refused update **keeps the previous routes serving** and returning to a working configuration re-applies (`:274-292`, and the two contained `try/catch` blocks at `:312-328`).

The settings document is `$DSH_HOME/settings.yaml`, mounted hot-reloading as `dsh-settings-file` (`bundle/base/cordis.patch.yml:87-91`, whose comment names "a `llm-deepseek:` or `llm-pi-ai:` section" as what "the web Models page writes").

So the out-of-the-box story for Ch 32(c) is precise and non-obvious: a fresh install has **zero registered routes**; the first turn fails `NO_ADAPTER`; and the fix is a settings write from the Models page, which brings routes up live with no restart and no change to the composition.

### (original) Q9

`packages/bundle/web-app/cordis.patch.yml:41-42` sets `llm-deepseek: disabled: true`, and `llm-pi-ai` registers zero routes while its `providers` dict is empty (`llm-pi-ai/src/config.ts:340-342`). So a fresh install appears to have **no registered provider at all**, and the first request fails `NO_ADAPTER` end to end.

Needed: how the web Models settings page makes a route live. Two candidate paths were seen but not traced — `packages/host/plugin-inventory/src/index.ts:73` surfaces an `enabled: !entry.disabled` field to the UI (suggesting a disabled row can be re-enabled at runtime), and `packages/client/ui-settings-models/src/client/DeepSeekOnboardingDialog.tsx` is a first-run onboarding step. Whether the mechanism is re-enabling the Cordis row or writing an `llm-pi-ai:` settings section is unconfirmed.

Load-bearing for Ch 32(c), which otherwise cannot state what the user must do to get a working install.

---

## Closed by the coordinator's own reading

Three UNKNOWNs raised in `raw/` are answerable from `packages/core/agent-loop/src/index.ts`, which I read in full:

- **Non-test `sessionProjections.register()` call site** (asked in `raw/session-log.md`): `agent-loop/src/index.ts:409` registers `turnBoundaryProjectionDefinition`. The engine registers its own projection.
- **Where `provider` / `model` / `cwd` prompt variables are registered** (asked in `raw/prompt-context.md`): `agent-loop/src/index.ts:414-416`, reading `agent.options.provider`, `agent.options.model`, and `agent.session.header.cwd`.
- **How the driver uses `{ concluded }`** (asked in `raw/tools.md` §6): `agent.ts:436` — `return concluded ? { kind: 'completed' } : null`, where `null` means "run another step in this turn."

---

## Q8 — Does `experimental/` load? · RESOLVED

**Answer: no.** Grepping both bundle patches for `experimental` returns zero matches, and no `packages/experimental/**` package is referenced by the standard preset either (`raw/plugins-context-mgmt.md` §8). The AGENTS.md "private prototypes" description is confirmed by absence from every composition file, not merely trusted.

### (original) Q8 — Does `experimental/` load?

`packages/experimental/` holds 106 source files — the second-largest group after `client/`. AGENTS.md calls it "private prototypes". `packages/experimental/agent-team-profile/cordis.patch.yml` exists, which means at least one experimental package ships a patch layer.

Needed: whether any experimental row reaches the shipped `web` profile. Nothing unmounted may be described as if it runs.
