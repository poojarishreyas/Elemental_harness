# Web backend reference

English | [中文](README.zh.md)

The backend loads the fixed `web` profile and serves the browser application. [`src/args.ts`](../src/args.ts) owns configuration options; the [Web startup plugin](../../../packages/bundle/web-app/src/startup.ts) owns HTTP options.

<a id="profiles"></a>
## Profile boot

The backend initializes `$DSH_HOME/profiles/web` from the shipped template when needed. The profile contains its dependency manifest and `cordis.patch.yml`. Configuration composes over an empty root in this order:

1. Bundle patches in `dsh.profile.bundles` order: built-in base and Web application layers, followed by configured external bundles.
2. The Web profile's `cordis.patch.yml`.
3. The home-level `$DSH_HOME/cordis.patch.yml`.
4. Each `--patch` overlay in argument order.

Later layers replace a target row's whole `config` value or insert rows. `patchReload: live` watches the profile and home patch files. Bundle membership is fixed for a running process; restart after dependency or manifest changes. Built-in bundles resolve from the backend installation, and external bundles resolve from the profile's dependencies.

## Options

| Option | Behavior |
|---|---|
| `--patch <path>` | Apply an additional configuration overlay; repeat for ordered layers. |
| `--dump-config` | Print the effective configuration without starting HTTP services. |
| `--dump-default-config` | Print bundled configuration without user patches. |
| `--host <host>` | Override the HTTP bind host; `0.0.0.0` is rejected. |
| `--port <port>` | Override the listen port; `0` selects a free port. |
| `--trusted-host <authority>` | Add an authority accepted by the browser API trust check. |
| `--no-open` | Start without opening the default browser. |
| `--help` | Show Web startup options. |
| `--version` | Print the application version. |

The two dump options are mutually exclusive and accept no HTTP options. `--dump-default-config` also rejects `--patch`. The backend rejects `--profile` and standalone task or plugin commands. Configuration, schema, resolution, and plugin failures exit nonzero.

## Browser and shutdown

The built-in configuration listens on `http://127.0.0.1:3080`. A local launch opens the browser after the plugin tree settles unless `--no-open` is set. SSH launches print the host URL without opening a browser. Browser handoff failure leaves the server running and reports the URL.

SIGINT and SIGTERM dispose the mounted plugin tree before exit. A second signal forces exit; the bounded shutdown handles plugins that do not finish disposal. The [boot package](../../../packages/boot/app-boot/README.md) owns shutdown behavior.

## Deployment configuration

The invoking directory supplies the default filesystem location; users select a workspace in the browser. Models, tools, settings, credentials, permission policy, and persistence remain configured through the [base bundle](../../../packages/bundle/base/README.md) and [Web application bundle](../../../packages/bundle/web-app/README.md). Shell execution is an agent capability and remains available through browser tasks.

External dependency installation belongs to the deployment's package manager. A profile manifest must list a bundle in `dsh.profile.bundles` to activate its patch layer; installation alone does not do this. The backend offers no package-management command. [Plugin packaging](../../../docs/user/develop/basic/publish.md) explains the manifests.

<a id="source-execution"></a>
## Source execution

`pnpm run build` prepares package and browser artifacts. `pnpm start` invokes `node --import tsx/esm apps/server/src/index.ts` without rebuilding. The source entry still needs generated Host artifacts and browser bundles; rebuild after changing them. The built entry is `node apps/server/lib/index.js`.

The process inherits the launch environment and loads the Harness home and working-directory environment layers. The [development guide](../../../docs/development.md) owns contributor setup and [app-boot](../../../packages/boot/app-boot/README.md) owns home and environment resolution.
