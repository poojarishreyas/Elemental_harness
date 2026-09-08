# Agent Note: Web GUI and backend as the only application

Status: implemented

English | [中文](2026-09-04-web-only-application.zh.md)

## Problem

The product needs a browser interface and its agent backend. Maintaining standalone command-line task runners, TypeScript and Python clients, stdio servers, and runtime-wheel packaging adds interfaces and distribution work outside that scope. The browser still depends on configuration loading, the agent engine, tools, permissions, and durable sessions, so deleting the launcher together with those shared services would break the application.

## Decision

The [backend entry](../../../../apps/server/src/index.ts) starts the Web application directly. The fixed `web` configuration retains the base and Web bundle layers, Harness-home storage, user patch files, and optional per-launch overlays. The backend owns process readiness and quiescent shutdown. The server package is private and exposes no npm command-line executable.

The repository has no standalone SDK, headless task runner, or ACP server application. The browser's API controllers and transport remain part of the backend. Model-facing terminal tools and providers that call external agents remain supported; the Codex provider owns its private JSON-RPC line transport because it is the surviving consumer of that helper. Internal base-configuration drivers retain core recorded-session tests without exposing another product entry.

## Alternatives considered

**Keep a reduced public CLI.** A `dsh web` command could preserve the launcher with less work, but the requested product consists solely of the browser and backend. Direct server startup removes command dispatch and unrelated application selection.

**Keep only the browser files.** The browser cannot execute the agent, access its workspace, or persist sessions without the backend. The shared runtime is required product code.

**Keep unused SDK code outside the build.** Build exclusions reduce distribution size but retain source, configuration, and documentation maintenance for interfaces the product does not offer.

## Consequences

Standalone CLI and SDK integrations are intentionally unavailable, including independent process automation and Python's bundled Node-free runtime distribution. The source tree and build cover fewer application modes; this does not promise lower steady-state memory consumption because the Web process already loaded its own composition. External plugin packages remain configuration dependencies, with installation and bundle membership managed through the Web profile's package manifest rather than a product CLI.

Web regression coverage must exercise the backend process entry as well as the assembled browser application: startup, streamed chat, model settings, tool execution, approvals, subagents, and persisted sessions. Fixtures borrowed from removed runner suites remain available under their Web owners. Reintroducing a standalone client requires an explicit product requirement and its own maintained protocol and distribution tests.
