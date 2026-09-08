# Agent Note: Minimal profiles use the bare two-tool runtime

Status: implemented

English | [中文](2026-08-11-minimal-profiles-bare-two-tool-runtime.zh.md)

## Problem

The Web `minimal` preset and standalone JSON-RPC minimal composition exposed persistent `bash` and `str_replace_editor`, but their supporting services did not match the intended training runtime. Both mounted context compaction, while the Web preset inherited the host's sandboxed filesystem and the JSON-RPC composition mounted `fs-sandbox` plus filesystem policy. A long session could therefore replace history, and the editor advertised and enforced a filesystem policy that the bare local reference runtime does not have.

The two launch paths also have different configuration owners. Web mounts a per-agent preset over a running host, while the Python SDK initializes a complete stdio JSON-RPC child process. Treating them as one interchangeable Cordis leaf would hide those lifecycle differences, and the SDK example had no environment path for selecting its model or system prompt.

## Decision

The Web minimal preset exposes persistent `bash` and `str_replace_editor`, mounts no context-compaction provider, suppresses system-prompt runtime-context contributions for fresh sessions, and runs the editor against an agent-local `@deepseek-ai/dsh-fs-local` provider. Other Web agents retain the host filesystem provider. Its fixed persona is owned by the [minimal-preset composition decision](../bug-fix/2026-08-10-minimal-preset-owns-rl-composition.md). The Web host retains its sandbox and approval services.



## Verification

The Web replay boots the complete Web host, creates the agent through the preset service, and asserts that the scoped filesystem is bare, no scoped compaction service exists, no system-prompt-owned runtime-context message was appended, and the assembled request contains exactly the fixed prompt and two tools. It then executes persistent Bash and the editor against the real scoped services.

Cordis validation checks the preset configuration and declared plugin dependencies.

## Alternatives considered

**Keep `compaction-basic` mounted with a high threshold.** Rejected because even an inert-for-short-tests provider permits history replacement in longer sessions and leaves the minimal composition dependent on model-capacity metadata and the token meter.

**Keep `fs-sandbox` in danger-full-access mode.** Rejected because the sandboxed provider still makes confinement and escalation part of the editor capability. The target runtime requires the bare local provider, whose lack of `sandboxMode` is composition truth.

**Use one Cordis leaf for Web and Python SDK startup.** Rejected because a Web preset contributes agent-scoped services to an existing multi-session host, while the Python SDK must launch a complete process containing the JSON-RPC server and its process-wide dependencies.

**Mirror the requested model into `DSH_MODEL`.** Rejected because the direct adapter accepts model ids outside its advisory catalog and resolves fallback context metadata for them. Mirroring creates two inputs for one selection; the SDK initialization request is authoritative, while `DSH_MODEL` remains only a convenience default in `minimal.py`.

## Consequences

Minimal sessions never summarize or replace earlier history and never add a runtime-context snapshot; callers must keep turns within the selected model's context capacity and must not rely on model-visible narration of standing sandbox or approval policy. The editor can address any absolute path visible to the runtime process, independently of the persistent shell's sandbox policy.
