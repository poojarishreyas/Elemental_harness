# Agent Note: A file-finding evaluation gates code-navigation features

Status: implemented

## Problem

Several navigation features were proposed — symbol tools, a code graph with blast-radius queries, git co-change ranking, stack-trace seeding — each promising that the agent finds the right file faster. None could be justified or compared without evidence of how the agent performs today, and the decision was to build them only if they measurably help. The repository had no way to measure file-finding: snapshot tests replay recorded sessions and real-API tests check narrow behaviors.

## Decision

`scripts/eval/` mines tasks from a repository's bug-fix history, runs the agent on each, and records file-finding metrics.

- **Tasks.** A qualifying fix commit changes 1–3 source files and at least one spec file within 12 changed files; locale-only fixes are skipped. The task workspace is a detached worktree at the fix commit with its source files restored to the parent, so the fix's own tests fail. A task whose tests already pass is dropped.
- **Prompt.** The agent receives only the failing test output and an instruction not to edit tests — not the commit subject or source paths — like a CI failure report.
- **Run.** The headless base driver used by recorded snapshots boots the shipped base profile with `scripts/eval/eval.cordis.yml`: model from `DSH_EVAL_PROVIDER`/`DSH_EVAL_MODEL`, workspace-write sandboxing, approvals `never`, uncompressed logs.
- **Metrics.** Computed from the streamed session events: pass, right-file edited, first step that saw or read a fix file, reads before the correct read, steps, tool calls, extra edits, test edits, and token usage.

`pnpm run eval:file-finding -- --repo <path> [--dry-run]` runs it. This repository's history is squashed to 17 commits, so tasks come from a repository with real history; a blobless clone of upstream `deepseek-ai/deepseek-harness` yields 1,751 candidates before the locale filter.

## Alternatives considered

**Hand-written tasks.** Fully controllable, but slow to write and biased toward what the author thinks is hard. Mined fixes come with a real answer (the diff) and real tests.

**SWE-bench.** A standard benchmark, but in Python repositories unlike the TypeScript codebases this harness is used on, and it needs Docker images per task. It can be added later as a second task source.

**Measuring in the web app.** Fidelity would be highest, but runs would need a browser and could not be scripted in bulk; the base driver is already the recorded-snapshot path.

## Consequences

- Navigation features get a before/after number on the same tasks instead of an argument.
- A full run needs a model key and installs dependencies per task, so it is slow and costs tokens; `--dry-run` validates tasks without a key.
- The failing test paths hint at the package, so the numbers measure finding the file within a package more than across the repository.
- The base profile differs from the web presets in compaction mounting, so results describe the agent loop and tools more than web-specific behavior.
