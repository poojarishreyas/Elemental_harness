# Progress

**Status: COMPLETE.** All five phases finished 2026-09-22.

Entry point: [`../README.md`](../README.md). Audit: [`evidence-report.md`](evidence-report.md).

---

## Final state

| Part | Chapters | State |
|---|---|---|
| I — Orientation | 1–3 | ✅ |
| II — Mental model | 4 | ✅ |
| III — Mechanisms | 5–30 | ✅ |
| IV — In motion | 31–32 | ✅ |
| V — Extending | 33–36 | ✅ |
| VI — Rebuild | 37 | ✅ |
| Appendices | A–D | ✅ |
| Phase 5 verification | — | ✅ |

**37 chapters · 4 appendices · ~70,000 words · 27 diagrams · 966 citations · 84 cited paths all verified · 0 broken links.**

---

## Decisions taken during the work

| Decision | Made by | Effect |
|---|---|---|
| Code-only evidence — no `pnpm install`, no test runs | user, 2026-09-21 | Governed how the book was written: every chapter authored from reading alone |
| **Reversed** — install, build, and run the suites | user, 2026-09-22 | Ceiling raised; see the run-verification block below. No prose was rewritten to fit a result |
| Write all 37 chapters rather than a subset | user | Full outline delivered |
| Resolve Q2 and Q9 before writing | user | Both resolved; Q2 materially changed Ch 11 |

---

## Corrections folded in before they reached the page

- **Ch 11** — the reconstruction invariant is mounted **nowhere** (Q2). Written as an executable specification and test oracle, not a production guarantee. Had this chapter been written first it would have been the book's worst error.
- **Ch 32** — a fresh install has zero registered routes; the fix is a settings write, not re-enabling the disabled row (Q9).
- **Ch 30** — `reasoning-chunks` is a lossless production storage codec, not a snapshot artifact (Q3). My original hypothesis was wrong; both it and the correction are preserved in `open-questions.md`.
- **Ch 27 / 34** — the three-layer composition. A two-layer reading concludes compaction and most tools are disabled. Corrections were sent to the research agents mid-flight.

---

## Conventions used (for anyone extending the book)

- Front matter: **What you'll learn** / **Prerequisites**. Close with **Key takeaways**, 2–3 exercises, and a **Next:** link.
- Part III chapters follow the ten-part template: problem → mental model → diagram → walkthrough → data at each stage → control decisions → edge cases → config → interactions → build it yourself.
- Citations inline as `path/file.ts:LINE`, usually beneath a quoted excerpt under ~25 lines.
- New vocabulary introduced as **New term — x.**
- Evidence markers 🔶 / ❓ / ⚠️ only where a claim is *not* plainly verified code; verified prose carries its citation alone.
- Snapshot quotations always labelled normalized, naming the placeholders.
- Every mechanism chapter carries at least one Mermaid diagram.

---

## Resolution pass (2026-09-22, after the first audit)

Every marked claim was chased down. **0 inferred and 1 unknown remain.**

| Was | Outcome |
|---|---|
| Q4 snapshot normalization | ✅ `identity.ts:64` — relationship-preserving numbered tokens; `{{cwd}}`/`{{system}}`/`{{tools}}` flat constants in `normalize.ts:20-22` |
| Q5 header `version` / `delegationDepth` | ✅ `version` **is** `SESSION_FORMAT_VERSION` (`format.ts:13, 267-276`); `delegationDepth` is the persisted subagent floor |
| `PromptSection.complete` dead? | ❌ **wrong** — the `minimal` preset uses it (`presets/minimal/agent.cordis.yml:13`), and the same row is the producer of runtime-context suppression |
| Raw `ToolDefinition` unused? | ❌ **wrong** — MCP client and subagent structured output both use it, for runtime-only schemas |
| Spill retention | ✅ confirmed limitation — mtime-only sweep; `cleanupPeriodDays: 0` disables |
| Subagent depth cap | ✅ default **3** (`tool-subagent/src/index.ts:129`), or `'provider-managed'` |
| `assembler.message()` default | ✅ verified dead — no non-test caller |
| projection-cache mechanism | ✅ schema-validated KV domain, per-record, JSON backend |
| `!!js` evaluator | ✅ `new Function('ctx','expr','with (ctx) {…')` (`utils.ts:5-6`) — so `!!js` is arbitrary code at load time |

### Run verification (2026-09-22)

| Step | Result |
|---|---|
| `pnpm install` | exit 0 |
| `pnpm run build:lib:host` | exit 0 — 178 `lib/` dirs from zero |
| `npx vitest run packages/core/agent-loop` | **342 / 342 pass** |
| `npx vitest run packages/{core,session,llm,compaction,spill}` | **3,373 / 3,383 pass**, 165 files |
| `pnpm run test:snapshot` | 67 fail — POSIX fixtures on Windows (`bash` vs `pwsh`) |

Both failure sets are environmental: 10 unit failures are `EPERM … symlink` in `spill-local`, and the snapshot failures are the documented `!!js process.platform` gate. Neither contradicts the book; the snapshot failure *shape* confirms three of its claims.

### Vendored changelog audit (2026-09-22)

`cordiverse/cordis@56b3d4f7` cloned and diffed. **All 19 logged modifications substantiated — no contradictions.** Thirteen against the exact baseline (item 7's "comment-only" claim confirmed by stripping comments: zero functional diffs), five by presence-check only because `deepseek-harness/cordis` is private.

### Still open

| Question | Would be resolved by |
|---|---|
| Attribution of vendored items 1, 9, 12, 13, 14 to *local* rather than fork authorship | access to `deepseek-harness/cordis` — returns *Repository not found* |

That is the only claim in the book that cannot be verified in this environment.
