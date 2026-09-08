---
description: "Configuration bundles for the Web backend core and browser application."
kind: "package-group"
---

# bundle/ — profile plugin bundles

English | [中文](README.zh.md)

## Summary

This group maps the configuration layers used by the Web backend. Each bundle declares `dsh.bundle.patch`; the server applies `dsh-base` and `dsh-web-app`, followed by user configuration patches.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`base`](base/README.md) | Shared core for base-backed profiles | — (patch only) |
| [`web-app`](web-app/README.md) | Browser application layer over base | mounts Web rows |

Built-in bundles resolve from the backend installation. The Web profile manifest declares external plugin dependencies and its ordered bundle list.

<a id="related-documentation"></a>
## Related documentation

- [Web backend](../../apps/server/README.md) — browser application startup and configuration.
- [app-boot](../boot/app-boot/README.md) — how profiles are resolved, layered, and customized.
- [Profile plugin bundles note](../../.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.md) — the profile and bundle composition design.


<a id="dev-note"></a>
## Dev Note

None.
