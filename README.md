# Elemental Harness

A web-only agent harness, forked from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and cut down to one application.

Everything is a plugin. The harness is a [Cordis](vendor/README.md) plugin tree composed at boot: the model adapter, the tool registry, the session log, and the agent loop itself are all plugins, each replaceable from configuration. There is no privileged core to patch — you extend the harness by mounting a plugin beside the others.

## What this fork changed

Upstream ships five application profiles (`web`, `headless`, `sdk`, `sdk-minimal`, `acp`) plus a desktop app and a Python SDK. This fork keeps **only the Web GUI**:

- `apps/server` is the single entry point and boots the fixed `web` profile; `--profile` is rejected.
- The CLI, SDK, ACP, headless and desktop applications are gone, along with the Python SDK and the benchmark suite.
- Documentation is English only.

## Run

### Run from source

```sh
pnpm install
pnpm run build
pnpm start
```

`pnpm start` runs the backend from source with the tsx ESM hook and serves the Web GUI on `http://127.0.0.1:3080`. After a build, `pnpm run start:built` runs the compiled entry instead. `pnpm run dev:web` watches the browser half.

Configuration overlays apply with `--patch <path>`; `pnpm start -- --dump-config` prints the effective plugin tree, and every row it prints can be replaced by a patch of your own.

## Layout

| Path | Contents |
|---|---|
| `apps/server` | Web GUI backend: configuration, agent runtime, HTTP serving |
| `apps/web` | Vite build of the browser shell; `dist/` is served by `apps/server` |
| `packages/` | ~245 `@deepseek-ai/dsh-*` workspaces, grouped by capability — see [packages/README.md](packages/README.md) |
| `packages/bundle/` | The two patch layers: `base` (agents, tools, persistence, sandbox, settings) and `web-app` (the browser surface) |
| `vendor/` | Vendored Cordis framework source |
| `docs/` | Architecture, generated catalogs, cookbook — start at [docs/architecture.md](docs/architecture.md) |
| `scripts/` | Gates and generators; `pnpm run check:all` runs the full matrix |

## Safety

This is experimental software with no security audit. It executes model-generated code and commands, loads third-party plugins, and reaches the network, processes, credentials, and files you give it. Sandboxing and approval prompts reduce risk but do not guarantee isolation. Run it with the least privilege it needs, preferably in a disposable VM or container, and keep backups of anything it can reach.

## License

[MIT](LICENSE), inherited from DeepSeek Harness. Third-party dependencies are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
