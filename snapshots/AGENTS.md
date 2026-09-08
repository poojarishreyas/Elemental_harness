# AGENTS.md — Recorded-session snapshots

This tree contains only tests whose committed session JSONL is replay input and expected persisted output. Keep non-session ARIA, geometry, generator, backend-process, and unit expected output with its owning app, script, or package; use `test:expected`, `test:web`, or `test` for its owning tier.

Web scenarios start the real Web backend with optional patches. Core agent and tool scenarios under `session/` use the internal `test-base` driver in `test-support/loader-smoke`. That driver is test infrastructure and must not become a product command or public SDK.

Each scenario owns or explicitly references one primary `session.jsonl` plus contiguous child files. The owner alone records or refreshes it. For an ordinary one-shot case, derive the user task and replay script from that JSONL; do not duplicate them in an `input.json`. Shared references are read-only, acyclic, and used only when another interface intentionally renders the same recorded behavior.

Committed sessions are normalization fixed points. Replace volatile identities with typed relationship-preserving tokens, replace request system prompts and tool schemas with tokens, and keep exactly one readable sidecar owner per header class. Never redact arbitrary user or tool text merely because it resembles an identifier.

An adapter-local symlink may expose a cross-profile prompt or schema sidecar only when `snapshot.yml` names that source; the corpus gate resolves the link and checks the declared target. The required snapshot lane runs these aliases on macOS and Linux.

Workspace seeds stay scenario-local. A scenario that mutates the workspace sets `workspace.final: true` and commits the complete result under `workspace.expected/`; use only the ignored `.empty` marker for an empty result. Record and refresh do not rewrite this independent oracle. Model prose and tool-result text do not prove the external effect.

`pnpm run test:snapshot` replays without writes. Recording and refresh use the explicit snapshot scripts, and every resulting JSONL, prompt, schema, protocol, UI, and workspace diff is reviewed before commit.
