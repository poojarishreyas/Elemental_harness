# AGENTS.md

Lynx Harness is a web-only fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): an all-plugin Cordis agent harness. The CLI, SDK, ACP, headless and desktop applications have been removed; the only application is the Web GUI.

Read [docs/architecture.md](docs/architecture.md) before changing `packages/`; follow [docs/AGENTS.md](docs/AGENTS.md) for documentation conventions.

## Pre-release stance: foundation over blast radius

APIs are pre-stable and there are no external consumers to protect. Prefer the change that leaves the better foundation over the one that touches fewer files: update every consumer, delete the superseded path, and do not add a compatibility shim for a caller that does not exist. Released Session JSONL is the exception — body reads may add a version-named successor but never move, overwrite, or delete committed generations. SQLite domains use monotonic `SCHEMA_VERSION`.

**Application launch.** There is exactly one application entry, `apps/server`, and it boots the fixed `web` profile. `--profile` is rejected. Package bins and demos are not application launchers ([rule](docs/architecture.md#application-launch)).

## Commands

```sh
pnpm install            # pnpm workspaces, node ^22.19 || >=24
pnpm run build          # tsc emits lib/types, tsdown bundles runtime, vite builds apps/web
pnpm start              # run the Web backend from source (tsx ESM hook)
pnpm run start:built    # run the compiled entry, after a build
pnpm run dev:web        # watch the browser half
pnpm run clean          # remove build outputs and residue from deleted packages
pnpm run typecheck
pnpm run lint
pnpm run test           # unit tests
pnpm run test:coverage  # coverage gate: per-file 100% on packages/*/*/src
pnpm run test:e2e       # real-API tests; self-skip without DEEPSEEK_API_KEY
pnpm run test:snapshot  # keyless recorded-session replay; filter: -t <name>
pnpm run test:web       # browser snapshots (builds first)
pnpm run duplication    # cross-file TypeScript clone detection
pnpm run hygiene        # publint + workspace/package/dependency checks
pnpm run doc-sync       # all documentation gates; leaf list in scripts/run-gates.ts
pnpm run check:all      # the full gate matrix
```

### Run relevant checks locally

Match evidence to the surface: focused behavior tests, model/user-output snapshots, `doc-sync` for docs, built smokes for published paths, real-API e2e for providers. Report only commands actually run.

- Never default to the full suite or repeat a passing check just to commit.
- `test:coverage`, not `test`, is the coverage gate ([why](docs/testing.md)).
- Regenerate rather than hand-edit: most of `docs/` is generated, so change the source and run the matching `gen-*` script.

## Secrets / .env

Real-API tests read `DEEPSEEK_API_KEY`, optional `DEEPSEEK_BASE_URL`, and root `.env`. `cordis.yml` allows `!!js` (never `!js`) under plugin `config` and entry `disabled`; other metadata stays literal, so conditional composition uses overlays ([primer](docs/cordis-primer.md#loader-configuration)). Never commit credentials.

## Conventions

- Every npm package is `@deepseek-ai/dsh-<name>`; vendored packages are rescoped ([mapping](docs/rescope.md)) and `private: true`. `@deepseek-ai/cordis` is a peerDependency (+ dev) of every harness package.
- ESM everywhere (`"type": "module"`). Use package names across packages and `.ts` in local relative imports. The source launch runs through tsx's ESM-only hook (`node --import tsx/esm`); modules it reaches must stay ESM. Raw/Web `cordis.yml` bare plugins must appear in their resolver manifest's `dependencies`; `verify-cordis-config` enforces it.
- **Registrations are effects**: every contribution goes through `ctx.effect()` / `ctx.on()`; a registry's `register()` returns the disposer.
- **Runtime invariants assert owned relationships.** Publish `./invariant` only when independent observations can diverge. Otherwise omit its source and wiring and record why in its README ([package invariant rules](packages/AGENTS.md)).
- **Typed events use declaration merging** and merge-extensible maps. Event JSDoc needs `@mode` and payload `@param`; scoped keys absent from payloads need `@dshScopeScan unsupported`. Public service methods document parameters and non-void returns. `SessionEventMap` members are required-on-read by default; only structural format changes bump `SESSION_FORMAT_VERSION`.
- **Switch on discriminant tags.** Closed unions end in `assertNever`; merge-extensible unions fall through a documented default.
- **Waterfall listeners MUST call `next()`** to delegate; returning without it short-circuits the chain ([semantics](docs/cordis-primer.md#cordis-waterfall-semantics)).
- **Model-visible ⟺ logged**: anything that reaches a model request must be reconstructable from the session log; a new model-visible input requires a session event.
- **Plugins, not loop changes**: new behavior goes on documented extension points; changing `agent-loop` requires updating docs/architecture.md.
- **A capability seam comprises Service Definition / Service Provider / Consumer roles.** It is complete, never one role; split only when roles evolve independently ([glossary](docs/glossary.md#capability-seam)).
- **Explicit > implicit at package boundaries**: defaulting is an explicit `resolve(request): Spec` step in the owning implementation, never a hidden `?? default` inside `run()`.
- **No hardcoded tunables in plugins**: deployment-varying choices are validated `Config` fields changeable from `cordis.yml`. Protocol constants, external specs, and security invariants stay fixed.
- **Misconfiguration fails loud** at load when self-contained, otherwise at the earliest resolvable point; never silently skip a missing referent.
- **Opaque cross-boundary ids are branded** (`Branded<B>` from `dsh-brand`), never bare `string`.
- **Trust TypeScript at typed same-process boundaries.** Validate at parser/config, queued, model/tool JSON, durable/file, worker, process, and wire boundaries — not for values the static interface already requires.
- **Source plane vs artifact plane, never mixed.** Static gates resolve workspace imports through tsconfig `paths` to `src`; gates consuming built `lib/` declare that dependency ([layout](docs/development.md#typescript-project-layout)).
- **Keep compiler faces explicit.** A package with both Host and Client programs exposes face-specific leaf configs and a solution-only root; repo-wide programs seed a face config, never the root solution.
- **An empty `catch` names what it swallows** and why nothing else can reach it; keep the `try` to one statement.
- **Keep comments local.** Do not restate code or explain distant behavior unless locally required.
- **Prefer symmetry for parallel values**; unexplained asymmetry usually signals a missed extraction.
- **Tests describe behavior, not correctness.** Change obsolete behavior together with its tests.
- **Non-trivial changes add or update an Agent Note** in the same change; only mechanical/local edits are exempt ([scope](.agents/notes/README.md#when-to-write-one)).
- **Client UI copy is locale-owned.** Route product text through typed dictionaries and `t` or localized primitive props; `verify-client-ui-i18n` rejects hardcoded copy. This is the browser UI's own en/zh selector and is unrelated to documentation language.
- **Testing policy** — [docs/testing.md](docs/testing.md). Model- or user-visible changes update a keyless recorded-session snapshot; [snapshot ownership](snapshots/AGENTS.md) reserves the top-level tree for session-driven cases.
- **Design each tool's UI presentation up front.** Host presenters stay pure; Web cards derive from raw events and persisted result metadata ([cookbook](docs/cookbook/adding-a-tool.md)).
- TODO markers: `FIXME`/`TODO`/`XXX` by urgency ([semantics](docs/development.md)).
- Files end with exactly one trailing newline; `git diff --cached --check` (pre-commit) gates it.

## Defensive patterns

Read [docs/defensive-patterns.md](docs/defensive-patterns.md) before lifecycle, concurrency, subprocess, or teardown work.

## Type safety and documentation

Everything compiles under `strict: true` with `noImplicitAny`; every remaining `any` explains why narrowing is infeasible. Every module and export carries concise JSDoc for its non-obvious contract; function-like exports include `@param`/`@returns`, enforced by `verify-export-jsdoc`.

Comments and docs state complete contracts, not reasoning transcripts. Use direct, concrete terms; before writing `contract`, `boundary`, or `shape`, ask whether a more exact term names the subject. Keep behavior, failure, timing, ownership, and safe-use facts; link the rationale. Use [dsh-prose-standard](.agents/skills/dsh-prose-standard/SKILL.md) for decisions.

Docs accompany every code change: update affected README and JSDoc contracts together. Documentation is English only. Current-state prose, one physical line per paragraph, one home per fact, and word budgets live in [docs/AGENTS.md](docs/AGENTS.md).

## Repository layout

```
apps/
  server/    the only application: Web GUI backend (@deepseek-ai/dsh)
  web/       vite build of the browser shell; dist/ is served by apps/server
vendor/      vendored Cordis source — manifest + sync procedure in vendor/README.md
packages/    @deepseek-ai/dsh-<pkg> workspaces at packages/<group>/<pkg>/
             group map: packages/README.md
  core/        product API spine: session, system-prompt, tools, agent, agent-loop
  api/         remote BFF assembly and Typert RPC gateway
  typert/      type graph generator, loader, and runtime registry
  boot/        app-boot profile composition + cmdline
  bundle/      the two patch layers: base (shared core) and web-app (browser surface)
  host/        Web-GUI host half: API gateway, HTTP route server, static frontend
  client/      Web-GUI browser half: shell, wire, object services, slots, ui-* plugins
  llm/         LLM capability: Service Definition/Consumer + DeepSeek providers
  session/     durable session data: persistence, projection, titles, reporting
  fs/ shell/ terminal/ subprocess/ sandbox/  execution capabilities and their tools
  web/         web capability: seam + search/fetch providers + tool Consumer
  subagent/ workflow/ jobs/ plan/ goal/ todo/  orchestration capabilities
  interaction/ approval/interaction seams, permission presets, commands, ask-user
  settings/ credentials/ storage/ workspace/   state and configuration
  experimental/ private prototypes
  test-support/ testkits, invariants, replay, Loader smokes
  util/        zero-dependency utilities
native/      @deepseek-ai/node-addon-landlock-run source of record (Linux sandbox)
.agents/     agent workflows and Agent Notes (`notes/`)
docs/        architecture, generated catalogs, postmortems, cookbook (docs/AGENTS.md)
scripts/     gates and generators
```

## Editing these instructions

`CLAUDE.md` points at `AGENTS.md` at root and `packages/`; edit the real file. Keep each rule self-contained while linking high-level docs.

## Vendoring policy

`vendor/` packages are pinned source copies (manifest with upstream SHAs in [vendor/README.md](vendor/README.md)). Update via the sync procedure there, re-apply or retire the logged local modifications, then rerun `pnpm run test && pnpm run build`.
