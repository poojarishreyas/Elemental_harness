# Chapter 35 · Limits and fragile areas

**What you'll learn:** where this engine's guarantees stop, which mechanisms are approximate, and which parts the code itself flags as unfinished.

**Prerequisites:** Part III.

---

Every limit here is grounded in code or in the codebase's own acknowledgements. Nothing is speculation about what *might* go wrong.

---

## 1. The token meter is not a tokenizer

```ts
CHARS_PER_TOKEN = 4
BLOCK_OVERHEAD  = 4
ROLE_OVERHEAD   = 4
```
— `packages/llm/token-meter/src/estimate.ts:13-19`

There is no BPE table and nothing provider-specific. Four characters per token is a rough average for English prose and is wrong in both directions for code, non-Latin scripts, long identifiers, and repetitive whitespace.

**What depends on it.** The compaction threshold ([Ch 27](27-pruning-and-compaction.md)). An under-estimate delays compaction until the provider rejects the request; the overflow path then recovers, but at the cost of a wasted round trip.

**What compensates.** Real provider usage supersedes the estimate as soon as one request succeeds ([Ch 26](26-measuring-and-spilling.md)), and the threshold is 80% rather than 100%, leaving deliberate headroom.

**When it would bite.** A session whose first request is already near the window — a large seeded fork, or a long first prompt — has no usage to anchor on, and CJK text or dense code can be badly mis-priced in exactly that window.

## 2. `maxParallelToolCalls` is deployment-wide

One value, read per group from a settings namespace, applying to every agent in the process ([Ch 17](17-scheduling-tool-calls.md)).

There is no per-agent or per-tool cap. A session running ten parallel file reads and one running ten parallel network fetches get the same budget, though their costs differ by orders of magnitude. A subagent inherits it too, so N concurrent subagents can each run up to the cap.

## 3. Sibling effects tear down concurrently

The nuance most likely to surprise someone reading the Cordis docs:

- disposers **nested inside one `ctx.effect()`** run in strict LIFO;
- but when the **whole fiber** unloads, `_unload()` clears the entire disposables list and runs them all with `Promise.all` (`vendor/cordis/src/fiber.ts:675-696`).

So two top-level `ctx.effect()` calls on the same fiber tear down **in parallel**, with no ordering guarantee between them. `AgentLoop`'s constructor registers exactly two — `ownership.dispose()` and `agents.setFactory()` — and their relative order on unload is undefined.

Any code assuming "my second effect tears down before my first" is relying on something the framework does not promise.

## 4. `ctx.emit()` does not contain listener failures

```ts
emit(...args: any[]) {
  this.dispatch('emit', args).map(cb => cb(...args))
}
```
— `vendor/cordis/src/events.ts:194-196`

A listener that throws synchronously propagates out and **aborts the remaining calls**. Later listeners silently do not run.

The agent dispatcher works around this by resolving the callback list and wrapping each call itself ([Ch 22](22-extension-points.md)), and `AgentLoop.reportConfiguredStartupFailure` does the same manually. But **any code calling `ctx.emit()` directly inherits the hazard**, and the fix is per-call-site rather than central.

## 5. Provider errors are classified by text matching

`isContextWindowExceededError` and `isQuotaExceededError` (`packages/llm/llm/src/error.ts:80-100`) pattern-match the provider's `code`, `type`, and `message` fields with regexes.

**What depends on it.** Compaction's entire overflow-recovery path triggers on `CONTEXT_WINDOW_EXCEEDED` ([Ch 32](32-when-things-go-wrong.md)). A provider rewording its error message could silently stop producing that code — and the symptom would be *turns failing where they used to recover*, with no error in the harness and nothing obviously changed.

This is the most fragile coupling in the system: a behavior-critical branch depending on another vendor's prose.

## 6. Cancellation has no watchdog

Convergence is entirely cooperative ([Ch 13](13-phases-cancellation-quiescence.md)). The loop checks its signal at six points per turn, the scheduler drains rather than abandons, and `whenIdle()` waits for genuine quiescence.

**A tool that ignores its abort signal delays teardown indefinitely.** There is no timeout, no grace period, no forced kill. The timeout-policy plugin bounds individual calls, but the engine itself will wait as long as a tool takes.

Consequence worth knowing: a badly-behaved tool can block agent disposal, which in turn blocks factory teardown, which `Promise.all`s every live agent's disposal ([Ch 14](14-agent-lifecycle.md)).

## 7. `always` retry mode is unbounded

`maxRetries` is enforced only for `mode: 'normal'`. An `always` policy has no code gate and no retry cap — it retries indefinitely until abort or disposal ([Ch 25](25-failures-and-retry.md)).

The engine's step loop is `while (true)` with no iteration cap of its own; bounding is entirely the listener's job.

Also worth flagging: the `always` branch reads as if it returns early when downstream declines, and does not — it falls through into the shared backoff path. If you depend on that behavior, quote the lines rather than paraphrasing.

## 8. Runtime invariants ship switched off

The registry that runs package-owned invariant companions is mounted **nowhere** ([Ch 11](11-the-reconstruction-invariant.md)). The engine's reconstruction check — the executable form of this book's central claim — does not run in the shipped product.

Two further limits stated by the package itself:

- **Filters are fixed for the service lifetime.** `enabled`, `package_allowlist`, and `package_blocklist` compile once at startup; changing them needs a plugin reload.
- **Live-only companions miss pre-reload operations.** A companion that observes only live operations cannot reconstruct ones that began before its own reload.

And a documentation defect: the package's README contradicts itself, claiming in its summary that "the standard agent composition already mounts it" while its usage section says `dsh-base` "deliberately omits runtime diagnostics." The composition files settle it.

## 9. `agent/turn-stopping` has no live listeners

Defined, typed, dispatched on every qualifying turn — to nobody ([Ch 22](22-extension-points.md)). Its only implementations are the two hook bridges, which are mounted in no composition layer.

Not a bug. But a reader should know that the turn-stopping seam is untested in production conditions, and the first plugin to use it will be exercising a path nothing currently exercises.

## 10. There is no working install out of the box

The native adapter is disabled in the web layer and the generic one mounts dormant, so a fresh install has **zero registered provider routes**. The first turn fails `NO_ADAPTER`, nothing retries it, and the fix is a settings write ([Ch 32](32-when-things-go-wrong.md)).

Defensible as a design — the Web surface exposes only what the Models page declares — but it means the failure a new user sees first is one the engine cannot handle.

## 11. The session format has no migration path

`SESSION_FORMAT_VERSION = 0`, and the doc comment is blunt: while unreleased, "no compatibility is implied, incompatible logs are rejected, and no migration is provided" (`packages/core/session/src/types.ts:28-50`).

Version mismatches are refused in both directions. The `ignorable` flag plus the generated known-type set lets *vocabulary* grow safely ([Ch 5](05-the-append-only-log.md)), but a structural change would strand every existing session.

## 12. Acknowledged in-source unfinished work

Three the code flags itself:

**`TODO(call-config-shape)`** — `LlmCallConfig`'s shape is explicitly unsettled: "Revisit which fields are epoch-level for cache reuse and where provider-specific request options belong" (`packages/llm/llm/src/call-config.ts:15-16`). Since this type is the request header's `config`, changing it touches log compatibility.

**`DSH_TOOLS_MODE` is a temporary seam.** The web bundle calls it a "TEMPORARY workaround… while per-session tool-presentation selection is being designed. Remove the env seam once the web UI owns the choice per session" (`packages/bundle/web-app/cordis.patch.yml:33-37`). A process-wide env var stands in for what should be per-session.

**Continuable fork invalidates the cache it exists to preserve.** Fork seeds a child with the parent's history so the shared prefix stays KV-cache eligible — but a continuable child's `report` tool and prompt section precede that history and invalidate the same prefix. The standard preset accepts the cost, with an issue tracking cache-preserving continuable fork ([Ch 28](28-subagents.md)).

## 13. Smaller sharp edges

| Edge | Consequence |
|---|---|
| `str_replace_editor` is exclusive even for `view` | Read-only views serialize with mutations; `tool-fs`'s `read` does not |
| A live-edited preset forks a generation | Existing sessions keep the old plugin instances; only new ones get the edit |
| `JSON.stringify` comparison in the invariant | Key-order sensitive — stricter than deep equality, and the safe direction |
| The first `deriveMessages()` after compaction | The one non-incremental case; rebuilds the whole cache |
| Raw `ToolDefinition` gets no argument validation | Only `defineTool` validates; a hand-built tool receives whatever `parseArguments` produced |
| Spill files are swept by age | A resumed session may reference a locator whose file was cleaned up — see below |

**Confirmed:** a session resumed after `cleanupPeriodDays` (default 30) **cannot** resolve spill locators in its history. The sweep deletes any file whose `mtime` is strictly older than the cutoff and knows nothing about which sessions are live or referenced (`spill-local/src/index.ts:40-46`). The model is told to `read` a path that is gone and gets a file-not-found error. Setting `cleanupPeriodDays: 0` disables cleanup entirely. → [Ch 26](26-measuring-and-spilling.md)

---

## Key takeaways

- The token meter is a character heuristic; the 80% threshold and real-usage preference are what make it workable.
- `maxParallelToolCalls` is process-wide, with no per-agent or per-tool refinement.
- Sibling top-level effects tear down concurrently; only nested disposers are ordered.
- Raw `ctx.emit()` lets one listener's throw suppress the rest.
- Compaction's overflow trigger depends on regex-matching another vendor's error text — the most fragile coupling here.
- Cancellation is cooperative with no watchdog; an unresponsive tool blocks teardown.
- Runtime invariants, the turn-stopping seam, and a working default provider are all absent from the shipped configuration.

## Exercises

1. Pick the limit you consider most likely to cause a production incident. Justify it against the others, then design the smallest change that would detect it early.
2. §3 says sibling effects tear down concurrently. Write the `AgentLoop` teardown bug that would require an ordering guarantee, and say whether the current code has it.
3. §5 depends on matching provider error text. Design a fallback that degrades safely when the pattern stops matching, without a false positive whenever a request fails.

**Next:** [Chapter 36 · Design decisions](36-design-decisions.md)
