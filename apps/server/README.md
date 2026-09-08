# Web backend

English | [中文](README.zh.md)

This application starts the backend for the Web GUI. It loads the fixed `web` profile, serves the browser application, and keeps agents, tools, approvals, and saved sessions in the shared runtime. The package has no public command bin.

## Run

Build the repository artifacts, then start from the repository root:

```sh
pnpm run build
pnpm start
```

The built backend entry is `node apps/server/lib/index.js`. Configuration errors, rejected options, and plugin boot failures exit nonzero. The [backend reference](reference/README.md) describes options, configuration layers, and source execution.

<a id="profiles"></a>
## Profiles

The backend always uses `$DSH_HOME/profiles/web`. Its manifest records ordered bundles and external plugin dependencies. The built-in `dsh-base` and `dsh-web-app` bundles supply the shared runtime and browser application. The profile patch, home patch, and ordered `--patch` overlays customize that composition.

The backend preserves live reload of configuration patches. Dependency or bundle membership changes require a restart. There is no profile selector or plugin installation command.

## Optional overlays

`config/examples/` contains opt-in overlays for GitHub review webhooks, session reminders, memory MCP servers, and runtime Cordis tools. The [user guides](../../docs/user/guide/index.md) and [developer practice guides](../../docs/user/develop/practice/index.md) own setup instructions.

## Development

[`src/index.ts`](src/index.ts) owns startup, [`src/args.ts`](src/args.ts) parses configuration options, and [`src/profile-boot.ts`](src/profile-boot.ts) mounts and disposes the plugin tree. See [source execution](reference/README.md#source-execution) for the build prerequisites.
