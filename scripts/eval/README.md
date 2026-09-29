# File-finding evaluation

Measures how well the agent finds and fixes the right code before any navigation feature (symbol tools, a code graph, co-change ranking) is built. A feature ships only if it moves these numbers.

## How a task is made

Tasks come from a repository's own bug-fix history. A commit qualifies when its subject reads like a fix (or it adds a `bug-fix` Agent Note), it changes 1–3 package or app source files, it changes at least one `tests/**/*.spec.ts` file, and it touches at most 12 files. Tasks that only change locale files are skipped, because a copy edit says little about file-finding.

For each task the runner:

1. checks out the fix commit in a detached git worktree and restores the source files to the parent commit, keeping the fix's tests;
2. installs dependencies and runs those tests, and drops the task if they already pass;
3. gives the agent the failing test output as its only instruction — the source files and the commit subject are not revealed;
4. runs the agent headless through the shipped base profile (`packages/test-support/loader-smoke/tests/fixtures/base-driver.ts` with [`eval.cordis.yml`](eval.cordis.yml));
5. re-runs the tests and computes metrics from the streamed session events.

## Metrics

| Metric | Meaning |
|---|---|
| passed | The fix's tests pass afterwards and no test file was edited |
| right file edited | At least one of the real fix's source files was edited |
| first seen step | First step whose search results or reads named a real fix file |
| first read step | First step that read a real fix file |
| reads before correct | `read` calls before that first correct read |
| steps, tool calls, input tokens | Cost of the run |
| extra edits | Files edited that are neither fix sources nor tests |

`summary.json` aggregates pass count, correct-file count, and medians; `summary.md` is a per-task table; `<task>.json` holds each run's full metrics and final answer.

## Running it

```sh
# Prepare and validate tasks only; no model key needed.
pnpm run eval:file-finding -- --repo <path-to-repo> --limit 5 --dry-run

# Full run; needs DEEPSEEK_API_KEY (model via DSH_EVAL_PROVIDER / DSH_EVAL_MODEL).
pnpm run eval:file-finding -- --repo <path-to-repo> --limit 20 --out eval-results
```

This repository's history is squashed, so mine a repository with real history, such as a clone of the upstream `deepseek-ai/deepseek-harness`. A blobless clone (`git clone --filter=blob:none`) is enough. `--install` overrides the dependency command, and `--keep` leaves worktrees in place for inspection.

## Limits

- The agent runs the base profile with workspace-write sandboxing and no approval prompts; the web presets add their own compaction rows, so compaction behavior can differ slightly from the web app.
- The prompt names the failing test files, which hints at the package; the metrics measure finding the source file within that hint.
- One run per task is noisy. Compare feature variants on the same tasks and several runs before drawing conclusions.
