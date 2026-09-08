---
description: "Session fixtures, manifests, normalization, and workspace checks for browser tests."
kind: "package-library"
---

# @deepseek-ai/dsh-session-snapshot

English | [中文](README.zh.md)

## Summary

This package provides pure helpers for the Web browser test scaffold: manifest parsing, identity redaction, session normalization, prompt and tool-schema snapshots, fixture refresh, and workspace comparison. The browser scaffold owns backend startup and user interaction; the internal base driver retains core session replay coverage.

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

Import the helpers from the package entry. [The Web scaffold](../../../apps/web/tests/scaffold.ts) normalizes harvested sessions and compares prompt, tool-schema, and workspace evidence. Snapshot manifests select the Web browser controller or the internal `test-base` controller; malformed fields and unsupported controllers fail parsing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Developer reference</summary>

| Module | Responsibility |
|---|---|
| [manifest.ts](src/manifest.ts) | Validate scenario manifests |
| [identity.ts](src/identity.ts) | Redact typed session identities |
| [normalize.ts](src/normalize.ts) | Normalize volatile session fields |
| [suite.ts](src/suite.ts) | Format prompt/schema snapshots and stabilize fixture refreshes |
| [workspace.ts](src/workspace.ts) | Capture final filesystem state |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [llm-replay](../llm-replay/README.md) — replay recorded model responses.
- [Testing policy](../../../docs/testing.md) — evidence and fixture ownership.
- [Test-support group map](../README.md) — sibling test helpers.

-----

<a id="model-experience"></a>
## Model Experience

None, as this test-only support normalizes recorded sessions without changing the assembled model request.

#### KV Cache effect

None; this package neither assembles nor sends provider requests.

## Known Limitations and Deferred Work

- Normalization requires the owning session's identities and working directory. Reusing another session's context can hide meaningful differences or retain volatile fields.

<a id="dev-note"></a>
### Dev Note

None.
