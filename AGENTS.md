# AGENTS.md

Elemental Harness is a web-only fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
an all-plugin [Cordis](vendor/README.md) agent harness. The CLI, SDK, ACP, headless
and desktop applications have been removed; the only application is the Web GUI.

Read [docs/architecture.md](docs/architecture.md) before changing `packages/`;
follow [docs/AGENTS.md](docs/AGENTS.md) for documentation conventions.

## Pre-stable APIs and released Session data

Public APIs are pre-stable; update every consumer. Released Session JSONL follows
adjacent migration: body reads may add a version-named successor but never move,
overwrite, or delete committed generations; predecessors imply neither fallback nor
downgrade support. SQLite domains use monotonic `SCHEMA_VERSION`.

**Application launch.** There is exactly one application entry, `apps/server`, and it
boots the fixed `web` profile. `--profile` is rejected. Package bins and demos are not
application launchers ([rule](docs/architecture.md#application-launch)).

## Run

```sh
pnpm install
pnpm run build      # tsc -b + tsdown (host, client) + vite (web frontend)
pnpm start          # node --import tsx/esm apps/server/src/index.ts
pnpm run start:built  # node apps/server/lib/index.js, after a build
pnpm run dev:web    # watch mode for the browser half
```

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
website/     VitePress projection of selected docs/ sources
```

## Gates

`scripts/run-gates.ts` drives every check; `pnpm run check:all` runs the full set.
Most doc catalogs under `docs/` are generated — change the source, then run the
matching `gen-*` script rather than editing the catalog by hand.
