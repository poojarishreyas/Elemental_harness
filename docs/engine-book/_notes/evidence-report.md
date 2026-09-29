# Evidence report

A claim-level audit of *How the Engine Works*, produced as the final step before declaring the book complete.

---

## 1. The evidence ceiling

> **Superseded by §1a.** The repository was later installed, built, and its suites run — 3,373 tests pass and a large part of Part III is now 🧪 *Verified (run)*. The original position is kept below because it governed how the book was written: every chapter was authored from reading the implementation alone, and nothing in it was adjusted to fit a test result afterwards.

**No claim in this book is 🧪 Verified (run).**

`node_modules` is absent from this checkout, and the decision was taken (2026-09-21) not to install it. So nothing was confirmed by execution: no unit tests, no `pnpm run test:snapshot` replay, no manual run of the application. Every verified claim rests on **reading the implementation**.

This matters most for the categories the brief itself flagged as riskiest — control decisions and termination conditions. Those were compensated for by a dedicated re-verification pass (§4), not by empirical confirmation.

What *would* have been available with an install: `pnpm run test:snapshot` (keyless recorded-session replay, needing no API key) and 19 spec files in `packages/core/agent-loop/tests/` covering cancel, resume, tool ordering, properties, and contract regressions.

---

## 1a. Run verification (added after the first audit)

The ceiling in §1 was subsequently raised. The repository was installed, built, and its suites run.

| Step | Result |
|---|---|
| `pnpm install` | exit 0 — pnpm 11.7.0 (as pinned), Node 24.19.0 |
| `pnpm run build:lib:host` | exit 0 — **178** `lib/` directories produced, from zero |
| `npx vitest run packages/core/agent-loop` | **342 / 342 pass**, 18 files, exit 0 |
| `npx vitest run packages/{core,session,llm,compaction,spill}` | **3,373 / 3,383 pass**, 165 files |
| `pnpm run test:snapshot` | 67 fail — environmental (below) |

**The 10 unit failures share one cause.** All are in `packages/spill/spill-local/tests/spill-local.spec.ts`, and the only error kind emitted across the whole run is `EPERM: operation not permitted, symlink`. Windows blocks symlink creation without Developer Mode or elevation; the tests create symlinks to prove the spill sweep does *not* follow them. Not behavioral.

**The 67 snapshot failures are platform drift, and they are evidence.** Every diff shows expected `"name": "bash"` against received `"name": "pwsh"`. The fixtures were recorded on POSIX; this is Windows. The gate is the one documented in Ch 34 and Appendix C:

```yaml
- id: tool-bash
  disabled: !!js process.platform === 'win32'
- id: tool-pwsh
  disabled: !!js process.platform !== 'win32'
```

So the suite cannot serve as a snapshot oracle on this machine — but its failure *shape* independently confirms three claims: that `!!js` platform gating swaps the shell tool at mount, that the tool catalog is part of the request header, and that a catalog change therefore changes the header. Chapter 15 argued the third point as the reason plan mode keeps mutation tools listed rather than removing them; here it is, breaking 67 comparisons.

### Claims raised to 🧪 Verified (run)

The agent-loop suite's 18 files map directly onto Part III chapters: `cancel.spec.ts` (32 cases → Ch 13), `request-reconstruction.spec.ts` (24) and `invariant.spec.ts` (8) → Ch 11, `resume.spec.ts` (28) → Ch 14, `scope-lifecycle.spec.ts` (37) → Ch 14/34, `tool-calls.spec.ts` (21) → Ch 17, `interception.spec.ts` (23) → Ch 22, `settings.spec.ts` (6) → Ch 17, `loop.spec.ts` (51) → Ch 9/12/19/20/21.

Individual case names confirm specific passages — "replays a wake latched behind maintenance at convergence" and "suppresses the replay when a latched maintenance wake is removed" are Chapter 13's latch and its `hasPending` guard; "clears compacted runtime context after the active set becomes empty" is Chapter 21's `CLEARED` sentinel; "re-emits unchanged runtime context when a surface replacement removed the retained snapshot" is its `retained = null` path.

### Two process errors caught during this pass

**A masked exit code.** The first snapshot run was piped to `tail`, so the task notification reported "exit code 0" while the real result was `exit 1`, 67 failures. Had I trusted the notification I would have reported a clean pass. Subsequent runs capture `REAL_EXIT` explicitly.

**A missed prerequisite.** That first run failed 67/82 on `ERR_MODULE_NOT_FOUND` for `lib/typert.host.js` — zero `lib/` directories existed. `test:snapshot` is an artifact-plane gate and I had installed without building. The repo's own AGENTS.md states the rule ("Source plane vs artifact plane, never mixed"); I hit it anyway.

---

## 2. Mechanical verification (all passed)

| Check | Result |
|---|---|
| Chapter files present | 41 of 41 (37 chapters + 4 appendices), plus README and OUTLINE |
| Internal cross-links resolve | **0 broken** out of all `[…](NN-slug.md)` links |
| Cited source paths exist | **84 of 84** distinct `packages/…`, `vendor/…`, `apps/…`, `snapshots/…` paths verified present |
| Mermaid diagrams | 27, all in valid `flowchart` / `sequenceDiagram` / `stateDiagram-v2` form |
| Every mechanism chapter (5–30) has ≥1 diagram | **yes** — six were added during this pass |
| Code-fence balance | balanced in all 41 files |
| Citation density | 966 file/line citation tokens across the book |

---

## 3. Claims per chapter

Counting individual prose "claims" would be arbitrary, so the table reports **citation tokens** (an inline `path.ts:LINE` reference) as the density proxy, alongside exact counts of marked claims. A verified claim is written as ordinary prose carrying its citation; only non-verified claims are marked.

| Chapter | Citations | 🔶 Inferred | ❓ Unknown |
|---|---:|---:|---:|
| 01 The core idea | 0 | 0 | 0\* |
| 02 Just enough architecture | 12 | 0 | 0 |
| 03 Core data structures | 28 | 0 | 0 |
| 04 The engine in 100 lines | 1 | 0 | 0 |
| 05 The append-only log | 33 | 0 | 1 |
| 06 The surface | 28 | 0 | 0 |
| 07 From log to request | 12 | 0 | 0 |
| 08 Projections | 28 | 1 | 0 |
| 09 The turn and step loops | 35 | 0 | 0 |
| 10 Building the request | 24 | 0 | 0 |
| 11 The reconstruction invariant | 20 | 0 | 0 |
| 12 The inbox | 22 | 0 | 0 |
| 13 Phases, cancellation, quiescence | 21 | 0 | 0 |
| 14 Agent lifecycle | 32 | 0 | 0 |
| 15 The tool registry | 20 | 1 | 0 |
| 16 The execution pipeline | 41 | 0 | 0 |
| 17 Scheduling tool calls | 27 | 0 | 0 |
| 18 Approval and escalation | 25 | 0 | 0 |
| 19 Prompt assembly | 40 | 0 | 1 |
| 20 Variable interpolation | 14 | 0 | 0 |
| 21 Runtime context injection | 22 | 0 | 0 |
| 22 Extension points | 21 | 0 | 0 |
| 23 Adapters and prepareCall | 32 | 0 | 0 |
| 24 Streaming and assembly | 24 | 1 | 0 |
| 25 Failures and retry | 31 | 0 | 0 |
| 26 Measuring and spilling | 23 | 0 | 1 |
| 27 Pruning and compaction | 57 | 0 | 0 |
| 28 Subagents | 23 | 0 | 1 |
| 29 Persistence | 33 | 0 | 0 |
| 30 Crash repair and chunk packing | 28 | 0 | 0 |
| 31 One real turn | 2 | 0 | 0 |
| 32 When things go wrong | 8 | 0 | 0 |
| 33 Adding a tool | 6 | 0 | 0 |
| 34 Composition in full | 39 | 1 | 1 |
| 35 Limits and fragile areas | 7 | 0 | 1† |
| 36 Design decisions | 2 | 0 | 0 |
| 37 Rebuild it | 19 | 0 | 0 |
| App B Data structures | 46 | 0 | 0 |
| App C Configuration | 18 | 0 | 0 |
| App D Mechanism index | 62 | 0 | 0 |
| **Total** | **966** | **5** | **7** |

\* Ch 01's marker match is the word "❓ Unknown" used to *describe* the convention, not a marked claim.
† Ch 35's unknown is a restatement of Ch 26's (spill retention), cross-referenced rather than independent.

Chapters 31–33 and 36 have low citation counts by design: 31 cites one fixture repeatedly, 32 and 36 synthesize mechanisms already cited in Part III, and 33 is a construction guide.

---

## 4. Re-verification of control decisions

The brief singled out control decisions and termination conditions as where errors are "most likely and most harmful." Because no run-verification was available, every termination condition documented in Chapter 9 was re-read against the source line by line in this pass.

All 15 spot-checked citations matched **exactly**:

| Citation | Source line |
|---|---|
| `agent.ts:221` | `while (await this.turn()) {}` |
| `agent.ts:277-278` | `turnEnds = { kind: 'blocked' }` / `return false` |
| `agent.ts:284-285` | `turnEnds = { kind: 'completed' }` / `return false` |
| `agent.ts:299` | `if (turnEnds === null \|\| turnEnds.kind !== 'max-tokens') turnEnds = stepEnd` |
| `agent.ts:308` | `if (turnEnds && this.inbox.nextStep.length === 0) break` |
| `agent.ts:333` | `if (!this.inbox.hasPending) return false` |
| `agent.ts:428` | `if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }` |
| `agent.ts:431` | `if (toolCalls.length === 0) return { kind: 'completed' }` |
| `agent.ts:436` | `return concluded ? { kind: 'completed' } : null` |
| `constants.ts:6` | `export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10` |
| `tool-calls.ts:90` | `const group = mode === 'parallel' ? planned.slice(next) : [first]` |
| `tool-calls.ts:132` | `const { maxParallelToolCalls } = ctx.agentLoop.config` |
| `tool-calls.ts:158` | `concluded \|\|= result.concludesTurn === true` |
| `tool-calls.ts:245` | `if (committed !== started) throw new Error(...)` |

An independent cross-check also holds. Chapter 31 computes seq numbers for the recorded session and validates them against **two** citations produced by different mechanisms at different times — `session/title`'s `messageSeqs: [7]` and `assistant/message`'s `sourceEventSeqs` spanning 12–39 (28 values). Both agree with the arithmetic model.

---

## 4a. Resolution pass (added after the first audit)

The first audit left 5 inferred claims and 7 unknowns. Each was then chased down by targeted reading. **All but one resolved**, and two resolutions showed the original claim was *wrong* rather than merely unconfirmed.

| Original marker | Outcome | Now in |
|---|---|---|
| Ch 5 ❓ header `version` / `delegationDepth` | ✅ Resolved — `version` **is** `SESSION_FORMAT_VERSION` (`format.ts:13, 267-276`); `delegationDepth` is the persisted subagent floor | [Ch 5](../05-the-append-only-log.md) |
| Ch 8 🔶 projection-cache mechanism | ✅ Resolved — schema-validated KV domain, one record per session, JSON backend (`src/index.ts:78, 91`) | [Ch 8](../08-projections.md) |
| Ch 15 🔶 raw `ToolDefinition` unused | ❌ **WRONG** — two production sites use it | §9 |
| Ch 19 ❓ `complete: true` possibly dead | ❌ **WRONG** — the `minimal` preset uses it | §9 |
| Ch 24 🔶 `assembler.message()` default unused | ✅ Resolved — verified dead; no non-test caller | [Ch 24](../24-streaming-and-assembly.md) |
| Ch 26 / 35 ❓ spill retention | ✅ Resolved — confirmed limitation; mtime-only sweep, `0` disables | [Ch 26](../26-measuring-and-spilling.md) |
| Ch 28 ❓ subagent depth cap | ✅ Resolved — default **3**, from `tool-subagent`'s schema (`:129`) | [Ch 28](../28-subagents.md) |
| Ch 34 🔶 `!!js` evaluator | ✅ Resolved — `new Function('ctx','expr', 'with (ctx) {…')` (`utils.ts:5-6`) | [Ch 34](../34-composition-in-full.md) |
| Ch 34 ❓ vendor changelog items | ✅ **Resolved** — upstream cloned and diffed; all 19 items substantiated | §6a |
| Q4 snapshot normalization | ✅ Resolved — relationship-preserving identity tokens (`identity.ts:64`) | [Ch 31](../31-one-real-turn.md) |

**Final marker count: 0 🔶 Inferred · 1 ❓ Unknown · 3 ⚠️ flags.**

One resolution improved a chapter beyond correcting it. The snapshot normalizer turns out to number identity tokens **by first appearance and reuse them**, so `{{message:1}}` in two events proves they reference the same message. That is what makes Chapter 31's independent seq verification valid, and the chapter now says so.

---

## 5. Inferred claims (all resolved)

**🔶 Ch 8 · Projections** (`08-projections.md:178`) — the persisted-cache backend is `packages/session/session-projection-cache`, mounted at base:162-166 with `writeEveryEvents: 200` / `writeIntervalMs: 5000`.
*Evidence:* the row exists in the base bundle; the `(sessionId, key, ver, seq, val)` row shape is confirmed from the projection registry's own checkpoint API.
*Gap:* the cache package's source was not read, so its concrete storage mechanism is unverified.

**🔶 Ch 15 · The tool registry** (`15-the-tool-registry.md:129`) — no shipped first-party tool uses the raw (non-`defineTool`) definition path.
*Evidence:* `bash`, `str_replace_editor`, `tool-fs` readers, and `tool-web` all use `defineTool`; the raw path is exercised only by the tools package's own tests.
*Gap:* not exhaustively checked across all ~30 tool packages.

**🔶 Ch 24 · Streaming** (`24-streaming-and-assembly.md:176`) — `assembler.message()`'s default `source` (`{kind:'plugin', plugin:'dsh-llm/assembler'}`) is unused.
*Evidence:* the agent loop always supplies its own source via `createAssistantMessage`.
*Gap:* consumers outside `packages/core/agent-loop` were not searched.

**🔶 Ch 34 · Composition** (`34-composition-in-full.md:121`) — `!!js` expressions are likely evaluated via a scoped `with`/`Function` construction.
*Evidence:* a comment elsewhere notes "An identifier this scope cannot resolve throws under `with`"; call sites and the `isJsExpr` predicate are confirmed.
*Gap:* `vendor/loader/src/config/utils.ts`'s `evaluate()` body was not read.

**🔶 Ch 32 · No provider configured** (inline, not badge-marked) — the net "zero registered routes on a fresh install" conclusion.
*Evidence:* the YAML facts are read directly (`llm-deepseek` disabled at web-app:41-42; `llm-pi-ai` `providers` defaults to `{}`), and the dormant-mount early return is read at `llm-pi-ai/src/index.ts:284-287`. The revival path via the settings section's `onChange` → `registerAdapter` is read at `:288-330`.
*Gap:* the client-side Models page was not traced, so the exact UI action that writes the section is not verified.

---

## 6. Every unknown

**❓ Ch 5 · The append-only log** (`:156`) — whether the session header's `version: 0` field is literally `SESSION_FORMAT_VERSION`, and what `delegationDepth` governs beyond subagent recursion capping.
*Checked:* `SESSION_FORMAT_VERSION = 0` at `types.ts:51`; `SessionHeader` shape at `types.ts:56-94`; the fixture's header line.
*Would confirm:* `session-persistence-jsonl/src/format.ts`.

**❓ Ch 19 · Prompt assembly** (`:115`) — whether `PromptSection.complete` has any live producer.
*Checked:* grepped `packages/**/src` for `complete: true`; no producer found besides the type.
*Would confirm:* a grep across `apps/`, all `*.yml`, and dynamically constructed section objects, plus reading `packages/preset/**` in full. May be dead code.

**❓ Ch 26 / Ch 35 · Spill retention** (`26:156`, restated `35:134`) — whether a session older than `cleanupPeriodDays` (default 30) can still resolve spill locators in its history.
*Checked:* the sweep exists at `spill-local/src/index.ts:68`; the notice remains in the log pointing at a path.
*Would confirm:* the sweep's exact predicate and whether resume touches spill files.

**❓ Ch 28 · Subagents** (`:143`) — the numeric depth cap and where it is configured.
*Checked:* `resolveChildDepth` enforces it at `child-agent.ts:49-58`; the header carries `delegationDepth`.
*Would confirm:* `child-agent.ts` in full plus the subagent runtime's config schema.

**✅ Ch 34 · Vendored modifications — RESOLVED.** See §6a.

**❓ Snapshot normalization** (open in `_notes/open-questions.md` Q4, not surfaced as a chapter badge) — the exact substitution rules the snapshot normalizer applies.
*Checked:* located at `packages/test-support/session-snapshot/src/normalize.ts` with specs beside it. Chapter 3 and Chapter 31 therefore label every fixture quotation as normalized and name the placeholders rather than asserting byte-fidelity.
*Would confirm:* reading `normalize.ts`.

---

## 6a. The vendored-changelog audit

`vendor/README.md` logs 19 local modifications to the vendored Cordis framework and asserts the log is exhaustive. The first draft could not verify it. It has now been checked by cloning `cordiverse/cordis` at the pinned commit `56b3d4f725681cf4556c1a8695a709cc3b6eed74` and diffing.

**Verdict: the log is accurate. No contradictions, no omissions found across all 19 items.**

**Thirteen verified against the exact pinned baseline** — items 2, 3, 4, 5, 6, 7, 10, 11, 15, 16, 17, 18, 19. The strongest of these is item 7, which claims the JSDoc enrichment across seven files is "comment-only; no code changes." Stripping comments from `service.ts`, `index.ts`, `context.ts`, `reflect.ts`, `registry.ts`, `logger.ts`, and `utils.ts` leaves **zero functional differences** — every residual is either an import rewrite items 4/10/17 already declare, or whitespace normalization from the repo's own linter (`{}` → `{ }`, `;(` → `; (`, `new (` → `new(`). A claim like that is easy to make and easy to get wrong; it held.

Item 19 is the most consequential and also checks out precisely: upstream classifies the Node module loader by `major >= 24`, the vendored copy probes for `getOrCreateModuleJob` / `getModuleJobForImport`. Since the v2 interface landed in 24.12.0, upstream mistags Node 24.0–24.11.1 — a real bug, fixed here.

**Five checked by presence only** — items 1, 9, 12, 13, 14 target packages sourced from `deepseek-harness/cordis`, which returns *Repository not found* (private or removed). Each was verified to be present and to match its description, but "present here, absent from `cordiverse`" cannot separate a harness modification from a fork modification.

> ⚠️ **Residual caveat.** The attribution of those five to *local* modification is consistent with everything observed and contradicted by nothing, but is not independently separable without access to the fork. This is the one claim in the book that remains unverifiable in this environment.

Item 8's loader half shows divergence in exactly the named files (`loader/src/index.ts` 166 → 202 lines, `config/group.ts` 88 → 129); its `include`/`group` half shares the baseline limitation above.

One process note: the check nearly produced a **false accusation**. A grep for `.i18n(` found one hit in the vendored hmr source and zero expected, appearing to contradict item 1's "removed the `.i18n({...})` call." Opening the file showed the hit was inside a comment documenting the removal. That is the same failure mode as the three errors in §9 — a pattern match mistaken for evidence — caught this time before it reached the page.

---

## 7. Dead, unmounted, or inert code found

Discovered by checking composition rather than trusting package names. None of these is described in the book as if it runs.

| Thing | Status | Evidence |
|---|---|---|
| `dsh-invariants` + ~30 companions | **Mounted nowhere.** Grep of every `.yml`/`.yaml` returns only `pnpm-lock.yaml` entries | [Ch 11](../11-the-reconstruction-invariant.md) |
| `hooks-claude-code`, `hooks-codex`, `hook-protocol` | Never in base, web-app, or the standard preset | [Ch 22](../22-extension-points.md) |
| `dsh-schedule` + `ui-schedule` | Opt-in overlay; `ui-schedule` explicitly `disabled: true` | web-app:266-271 |
| `packages/experimental/**` (106 source files) | Referenced by **no** composition file | grep: zero matches |
| `skill-badge` | `disabled: true` at its own base row | base:285-287 |
| `hmr` | `disabled: true` in base | base:21-25 |
| `tool-str-replace-editor` | Disabled in web-app and **not** re-mounted by the standard preset | preset roster omits it |
| `llm-deepseek` | `disabled: true` in web | web-app:41-42 |
| `session-query-sqlite` | Mounted with `openAt: never` — SQLite never opened | base:129-133 |
| `llm-pi-ai` | Mounted with an empty `providers` dict — zero routes | `config.ts:340-342` |
| `agent/turn-stopping` listeners | Extension point live; **zero** live listeners in the shipped profile | [Ch 22](../22-extension-points.md) |
| `tools/pre-execute` producing `ask` | Seam fully implemented; **no always-on producer** | [Ch 18](../18-approval-and-escalation.md) |
| `PromptSection.complete` | No producer found — possible dead code | §6 |
| `assembler.message()` default source | Unused by the main loop | §5 |

---

## 8. Docs and comments that contradict the code

**⚠️ `packages/runtime-diagnostics/invariants/README.md` contradicts itself.** Its Summary claims "the standard agent composition already mounts it with the four core companions"; its "When to use it" section says "`dsh-base` deliberately omits runtime diagnostics." The composition files settle it — the registry appears in no `.yml` anywhere. The book follows the code. → [Ch 11](../11-the-reconstruction-invariant.md)

**⚠️ `packages/context/**` does not use the prompt-context mechanism.** Despite the directory name, none of `agent-instructions`, `time-context`, `tmux-context`, `session-reference`, or `file-reference-local` calls `systemPrompt.context()`. They inject through `agent/pre-step`, and one registers an ordinary prompt *section*. "Context" there names a product category, not this mechanism. → [Ch 21](../21-runtime-context-injection.md)

**⚠️ "~56× measured on a real DeepSeek session"** (`chunk-rows.ts:1-20`) is a figure in a doc comment, not something this book measured. Quoted as the authors' claim. → [Ch 30](../30-crash-repair-and-chunk-packing.md)

**Preset comment imprecise, though not wrong.** `presets/standard/agent.cordis.yml:2-3` says a preset is "mounted once per process." The code shows it is once per **(preset id, on-disk file generation)**, single-flighted and lazily created, with a live edit forking a generation. The book states the precise version. → [Ch 34](../34-composition-in-full.md)

---

## 9. Three claims that were wrong

Recorded because it is the clearest illustration of why the zero-assumptions rule exists.

On first reading the recorded session, I hypothesized that `reasoning-chunks` was a **snapshot-normalization artifact** — a fixture-only compaction of streamed deltas. It appeared in a test fixture, used an unfamiliar tag, and had no `SessionEventMap` entry.

It is none of those things. It is a **lossless production storage codec** in `packages/core/session/src/chunk-rows.ts`, used by real persistence and by bounded history transport, with exact-shape whitelisting and safe-integer round-trip guards. The name was suggestive and the location misleading; only reading the implementation settled it.

The wrong hypothesis is preserved in `open-questions.md` Q3 beneath the correct answer.

### 9b · "No shipped tool uses the raw `ToolDefinition` path"

Marked 🔶 Inferred in Chapter 15's first draft, on the basis that `bash`, `str_replace_editor`, `tool-fs`'s readers, and `tool-web` all use `defineTool`.

**Wrong.** Two production sites register hand-built definitions:

- `packages/mcp/mcp-client/src/tools.ts:182` — MCP tools are discovered from a remote server, so their schemas arrive over the wire.
- `packages/subagent/subagent-in-process-driver/src/structured.ts:74` — the structured-output tool takes its schema from the caller's requested output shape.

The original grep pattern was `register(defineTool` — which also missed `glob`, `grep`, `tool-skill`, and `cordis-host-runner`, all of which *do* use `defineTool` but assign to a variable first. A pattern matching one call shape was mistaken for evidence about all of them.

The corrected fact is more useful than the claim it replaced: **the raw path exists for tools whose schema is only known at runtime**, and it obliges the author to validate arguments by hand. `structured.ts` does exactly that, with a comment naming the `defineTool` behavior it is replicating.

### 9c · "`PromptSection.complete` may be dead code"

Marked ❓ Unknown in Chapter 19's first draft after a grep of `packages/**/src` found no producer.

**Wrong.** The `minimal` agent preset sets it (`presets/minimal/agent.cordis.yml:13`), and `dsh-persona` passes it through (`packages/preset/persona/src/index.ts:61`). The same preset row sets `includeRuntimeContext: false`, which is **the producer of the runtime-context suppression** the chapter described two steps earlier without knowing where it came from.

The grep was scoped to `src` directories, and the producer is a **YAML preset file**. Composition is code in this repository, and searching only TypeScript was the error — the same lesson the three-layer composition hazard teaches everywhere else in this book.

---

## 10. Things in the engine worth flagging as risky

Beyond the documented limits ([Ch 35](../35-limits-and-fragile-areas.md)), three stand out from an auditor's perspective.

**Compaction's overflow trigger depends on regex-matching another vendor's error prose** (`llm/src/error.ts:80-100`). If a provider rewords its message, `CONTEXT_WINDOW_EXCEEDED` stops being produced, and the symptom is *turns failing where they used to recover* — with nothing in the harness having changed and no error to point at. This is the most fragile behavior-critical coupling found.

**The shipped configuration disables its own correctness checks.** Defensible for hot-path cost, but it means the central guarantee is enforced only in CI. A desync introduced by a future change would reach production undetected until it manifested as a replay discrepancy.

**Cancellation has no watchdog.** A tool ignoring its abort signal blocks `whenIdle()`, which blocks agent disposal, which blocks factory teardown (which `Promise.all`s every live agent). One unresponsive tool can stall process shutdown, cooperatively and indefinitely.

---

## 11. Verdict

37 chapters and 4 appendices, ~70,800 words, 27 diagrams, 84 cited paths all verified present, 0 broken links, and all 15 spot-checked control-flow citations exact.

After the resolution pass (§4a): **0 inferred claims, 1 remaining unknown** — the vendored changelog, which needs an upstream checkout to diff against. Fourteen unmounted or inert features identified and described as such rather than as working behavior. Three documentation-versus-code contradictions recorded.

**Three claims in the first draft were wrong** (§9), and all three failed the same way: a plausible pattern was mistaken for evidence. A suggestive name (`reasoning-chunks`), a grep matching one call shape (`register(defineTool`), and a search scoped to `src` while the producer sat in YAML. None would have been caught by review; each needed someone to open the file.

That is the argument for the ground rules in miniature. The cost of the zero-assumptions discipline is real — it is most of the time this took. What it bought is three errors caught before print, in a book whose whole claim is that it describes what *this* code does.

**The ceiling was raised after the fact.** The book was written entirely from reading the implementation; it was then checked by building and running the suite. **3,373 of 3,383 unit tests pass**, including all 342 covering the engine core, and every failure on this machine traces to a Windows limitation rather than to behavior — symlink creation for the spill tests, and POSIX-recorded fixtures for the snapshot replay.

Nothing in the book was rewritten to fit a test result. The tests were run as a check on prose that was already finished, and they found no contradiction with it.

The one claim that remains unverifiable here is the attribution of five vendored modifications to local authorship rather than to the upstream fork, because that fork is private. Everything else a reader needs to judge the evidence — including three claims that were wrong and how each was caught — is written down above.
