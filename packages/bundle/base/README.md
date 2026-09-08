---
description: "Shared Web backend model access, tools, durable sessions, and safety defaults."
kind: "package-bundle"
---

# @deepseek-ai/dsh-base

English | [中文](README.zh.md)

## Summary

`dsh-base` supplies the Web backend with model access, tools, durable sessions, and workspace safety defaults. The Web profile includes this bundle first; later bundles and profile patches customize its defaults.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Web profile includes the core automatically when the backend first starts.

### Web profile composition

The Web profile includes `@deepseek-ai/dsh-base` followed by `@deepseek-ai/dsh-web-app`. Start the backend with `pnpm start`; customize its `cordis.patch.yml` or profile manifest as described in the [backend reference](../../../apps/server/reference/README.md).

### What you get

Out of the box, every profile built on this core provides: a DeepSeek model connection (the provider and model are configurable, and you can enable extra providers from your settings), the full tool set — file editing, shell commands, web search, subagents, task and goal tracking — durable sessions that survive restarts, and the default permission policy that confines file writes to your workspace and asks before risky actions. Telemetry stays off unless you opt in.

### Shell tools per platform

On macOS and Linux you get the bash shell tools; on Windows you get the PowerShell twins instead, so exactly one shell stack is available per machine. The safety behavior is identical on every platform. A Windows host that prefers the unconfined PowerShell executor can switch the shell rows in its profile patch — the switch must disable both PowerShell rows and re-enable both bash rows, otherwise the profile fails to load.

### Changing the defaults

To change what a profile built on this core provides — a different default model, a stricter permission mode, extra or fewer tools — edit your profile's `cordis.patch.yml` or add a later bundle. Each patch entry replaces the target's whole configuration, so restate every setting you want to keep. Keep the sandboxed filesystem provider as the single file-write path: adding the plain filesystem provider on top of it makes the profile fail to load.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle is a static patch document: one `insert` list applied over the empty profile root. It mounts no service, emits no events, and holds no mutable state; each inserted row's package owns that row's behavior and invariants.

### Composition mechanics

A patch replaces the targeted row's whole `config` rather than merging into it. Later bundle layers and the user's profile `cordis.patch.yml` override rows by id, with the last write winning per row. Rows whose value differs by mode do not live here: each mode bundle restates its complete configuration, keeping any single row down to one bundle layer plus the user's. The full row set and its rationale are documented inline in [`cordis.patch.yml`](cordis.patch.yml); the [generated composition graph](../../../apps/server/composition.md) renders it.

### Platform gating

The patch gates the two shell stacks by platform on its own rows: `bash-sandbox` and `tool-bash` carry `disabled: !!js process.platform === 'win32'`, and their twins `pwsh-sandbox` and `tool-pwsh` mount on win32 only with the inverted expression. The permission surface stays identical to POSIX: the sandbox policy executes the same file-effect policy through the Windows ACL restricted-token runner (`dsh-sandbox-local` → `@deepseek-ai/dsh-sandbox-windows-acl`), and `fs-sandbox` keeps fencing `ctx.fs` writes — mounting `dsh-fs-local` alongside it would double-register `ctx.fs` and fail the load.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The bundle substance: the base plugin rows, with per-row rationale as inline comments |
| [`src/index.ts`](src/index.ts) | Package entry; carries no runtime API |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: no runtime invariant; each inserted row's package owns its invariants |
| [`tests/base.spec.ts`](tests/base.spec.ts) | Manifest declaration and platform-gating checks |

### Invariant ownership

The invariant companion registers an empty installer because the package is a static patch-list carrier: each inserted row's own package carries that row's invariants, and the bundle owns no mutable relation to check.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you want to go deeper into profiles, the surfaces built on this core, or the exact composition.

- [app-boot profile section](../../boot/app-boot/README.md) — how profiles are resolved, layered, and customized.
- [Bundle package map](../README.md) — the surfaces built on this core.
- [Generated composition graph](../../../apps/server/composition.md) — the exact plugin set each shipped profile uses.
- [Profile plugin bundles note](../../../.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.md) — the profile and bundle composition design.
- [Codex and Claude Code provider bundles](../../subagent/README.md) — optional provider bundles you can install on top.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through each inserted row's package, which owns that row's model-facing behavior.

#### KV Cache effect

The bundle itself adds no request prefix; each inserted row's package owns any cache effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits tell you when the core needs extra care or where an override must go. They are current package constraints, not a general comparison or a task backlog.

- **Overrides replace whole settings blocks** — a patch entry replaces the target's entire configuration, so your override must restate every setting you want to keep; nothing merges automatically.
- **Per-surface settings belong to the surface's bundle** — a default that differs between the web GUI and headless mode lives in that surface's bundle, not in the shared core.
- **Windows temp grants are private per-session subdirectories** — `workspace-write` confines writes to the workspace plus the session's own temp subdirectory (`<temp>\dsh-<hash>`, TMP/TEMP rewritten for confined children); `read-only` grants nothing. See `@deepseek-ai/dsh-sandbox-windows-acl`.
- **Adding the plain filesystem provider on top of the sandboxed one fails the profile** — the two register the same service, so the profile refuses to load; use one or the other.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
