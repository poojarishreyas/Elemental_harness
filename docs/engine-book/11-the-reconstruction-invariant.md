# Chapter 11 · The reconstruction invariant

**What you'll learn:** the code that states this engine's central claim as a runnable assertion — and the more interesting fact that it ships switched off.

**Prerequisites:** [Chapter 7](07-from-log-to-request.md), [Chapter 10](10-building-the-request.md).

---

## 1. The problem

Chapter 1 made a strong claim: every request is a pure function of the session log. Chapters 7 and 10 showed the machinery. But a claim like that decays. Someone adds a field to the request that is not in the header. Someone caches a message array "just for this one path." Someone passes `messages` through a transform before dispatch. Each change is locally reasonable and each quietly breaks resume, fork, and replay — in ways that surface much later, as a session that replays differently than it ran.

A comment saying "must equal the derivation" does not catch that. An assertion does.

## 2. Mental model

**New term — invariant companion.** A small plugin a package ships alongside itself, checking a durable relationship *its own package owns*, at runtime, against live data.

The repository has about thirty of these, one per package, all with the same shape: `src/invariant.ts`, exporting `name`, `inject`, and an `apply` that calls `ctx.invariants.register(PACKAGE_NAME, install)`. The engine's checks one thing: that what goes out matches what the log says should go out.

The design rule for what qualifies is narrow and worth stating, because it explains why there are not more of these:

> "A companion checks an event-stream or mutable-data relationship its package owns; confirming a method, plugin name, injection, or fixed pure result is a type, load, or unit-test concern, never a runtime invariant."
> — `packages/runtime-diagnostics/invariants/README.md`

Checking that a function exists is a compiler's job. Checking that two independently-computed views of live state agree is not.

## 3. Lifecycle

```mermaid
sequenceDiagram
  participant Loop as Agent loop
  participant Inv as Invariant listener
  participant Sess as Session
  participant Ad as Adapter

  Loop->>Inv: llm/stream(options)  [prepended, global]
  Inv->>Inv: isAgentLoopRequest(options)?
  alt not loop-built
    Inv->>Ad: next() — pass through unchecked
  else loop-built
    Inv->>Inv: frozen? sessionId present?
    Inv->>Sess: sessions.get(sessionId) — still live?
    Inv->>Sess: events contain a step/start?
    Inv->>Sess: foldRequestHeader(events)
    Inv->>Sess: deriveMessages()
    Inv->>Inv: JSON.stringify equality
    alt mismatch
      Inv-->>Loop: fail("log-reconstruction desync")
    else match
      Inv->>Ad: next()
    end
  end
```

## 4. Step-by-step walkthrough

The whole check is 35 lines (`packages/core/agent-loop/src/invariant.ts:19-55`).

### Where it attaches

```ts
ctx.on('llm/stream', (options: GenerateOptions, next) => {
  if (!isAgentLoopRequest(options)) return next()
  ...
}, { global: true, prepend: true })
```
— `invariant.ts:21`, `:54`

Two flags carry weight. `global: true` means it sees every stream regardless of scope. **`prepend: true`** puts it at the front of the waterfall — and the comment says why: "Prepend prevents a short-circuiting replay listener from silencing the check." A listener that answers a request without delegating ([Ch 22](22-extension-points.md)) would otherwise skip everything registered behind it, including this. A check that can be bypassed by registration order is not a check.

`isAgentLoopRequest` is the `WeakSet` membership test from [Chapter 10](10-building-the-request.md). One-shot calls — compaction's summarization, session titling — pass straight through.

### The structural checks

```ts
if (!Object.isFrozen(options)) fail('a loop-built request must be frozen')
if (options.sessionId === undefined) fail('a loop-built request must carry a session id')
const session = ctx.sessions.get(options.sessionId)
if (!session) fail(`a loop-built request must carry a live session id, got "..."`)
if (!Object.isFrozen(options.messages)) {
  fail('a loop-built request must carry a frozen messages array')
}
```
— `:23-30`

Frozen, identified, and the identity resolves to a session that is still live. The messages array is checked separately from the request itself — freezing the outer object does not freeze the array.

### The log must be able to explain the request

```ts
const events = session.events
if (!events.some(event => event.type === 'step/start')) {
  return fail('a loop-built request with no step/start in its session log')
}
const header = foldRequestHeader(events)
if (header === undefined) {
  return fail('a loop-built request with no request/header event in its session log')
}
```
— `:31-38`

A request being dispatched means a step opened, which means `step/start` is in the log. And [Chapter 10](10-building-the-request.md)'s sparse header series must fold to something. Both are preconditions for the real comparison.

### The central assertion

```ts
const expected = session.deriveMessages()
if (JSON.stringify(options.messages) !== JSON.stringify(expected)) {
  fail(`llm request for session "..." diverges from the dispatch-time durable derivation (log-reconstruction desync)`)
}
```
— `:39-42`

This is Chapter 1's thesis, executable. Not "similar", not "equivalent modulo formatting" — the same JSON. Crucially it re-derives **at dispatch time**, from inside the dispatch path, so it catches drift introduced anywhere between building the request and sending it.

### And the non-message half

```ts
const headerMatches = options.model === header.config.model
  && options.system === header.system
  && options.temperature === header.config.temperature
  && options.maxTokens === header.config.maxTokens
  && JSON.stringify(options.stop) === JSON.stringify(header.config.stop)
  && JSON.stringify(options.tools ?? []) === JSON.stringify(header.tools ?? [])
```
— `:44-49`

Messages come from the surface; everything else comes from the folded header. Together they cover the whole request, which is what makes "reconstructable" a complete statement rather than a partial one.

## 5. Control decisions

| Decision | Condition | Location |
|---|---|---|
| Skip entirely | not a loop-built request | `:22` |
| Fail | request not frozen | `:23` |
| Fail | no session id, or id does not resolve | `:24-26` |
| Fail | messages array not frozen | `:27-29` |
| Fail | no `step/start` in the log | `:32-34` |
| Fail | header fold yields nothing | `:35-38` |
| Fail | messages ≠ derivation | `:39-42` |
| Fail | any header field diverges | `:44-52` |
| Delegate | all checks pass | `:53` |

## 6. It does not run in the shipped system

Here is the part that matters most, and it took direct checking to establish.

**The registry that runs these companions is mounted nowhere.** `dsh-invariants` lives at `packages/runtime-diagnostics/invariants`. Grepping every `.yml` and `.yaml` in the repository for it returns only `pnpm-lock.yaml` dependency entries — **zero plugin rows**, in the base bundle, the web-app bundle, the standard agent preset, or any example overlay. There is no environment-variable seam either.

The package's own documentation is explicit about the intent:

> "`dsh-base` deliberately omits runtime diagnostics. Custom compositions mount the registry and add companions for any other loaded package whose contracts they want checked. Loading the registry alone installs no checks."
> — `packages/runtime-diagnostics/invariants/README.md`

So in the running product, nothing checks this. The code is real, correct, and dormant.

> ⚠️ **Docs contradict themselves here.** The same README's summary paragraph claims "the standard agent composition already mounts it with the four core companions." The composition files say otherwise, and per this book's ground rules the composition files win. Flagged for the evidence report.

### Why this is still worth a chapter

Three reasons, and the first is the most important.

**It is an executable specification.** The clearest statement of what this engine guarantees is not a paragraph of prose — it is 35 lines that would fail if the guarantee broke. Read it as the definition of "reconstructable." Every design decision in Chapters 5 through 10 exists to make this assertion true.

**It is the test oracle.** The check runs wherever a composition mounts it, which includes test compositions — `packages/workflow/workflow-worker-thread/tests/integration.spec.ts:9` imports it directly. So the guarantee *is* enforced during development, just not in production.

🧪 **Verified (run).** The engine ships two suites dedicated to this contract: `packages/core/agent-loop/tests/request-reconstruction.spec.ts` (24 cases) and `tests/invariant.spec.ts` (8 cases). Running `npx vitest run packages/core/agent-loop` on this checkout gives **342 passed, 0 failed, across 18 files**. So the reconstruction guarantee is not merely stated and not merely implemented — it is exercised by 32 dedicated cases on every test run, and they pass. What ships disabled is the *runtime* enforcement, not the verification.

**Switching it off is a defensible choice, and worth understanding.** The check calls `deriveMessages()` and two `JSON.stringify` passes over the entire history, on every request. On a long conversation that is real work on the hot path, to verify something that CI already covers. The registry exists precisely so a deployment debugging a suspected desync can turn it on.

## 7. Edge cases and limitations

**One-shot calls are outside the contract.** The package states it plainly: "Request reconstruction covers loop-built requests only — the `dsh-agent-loop` companion reconstructs requests explicitly built by the loop; direct one-shot LLM calls remain outside that contract even when callers freeze them or attach a session id." Compaction's summarization request ([Ch 27](27-pruning-and-compaction.md)) is exactly such a call: it carries a session id and is frozen, and it is deliberately *not* checked, because it is not meant to equal the derivation — it is a different prompt entirely.

**`JSON.stringify` compares key order.** Two structurally equal objects with different insertion order would fail. In practice both sides come from the same frozen event data, so ordering is stable — but it makes the check stricter than deep equality, which is the safe direction.

**A failure is attributed, not anonymous.** An `InvariantError` carries the code `INVARIANT` and the owning package's full npm name, with the message prefixed `invariant violated by "<package>": …` — so a violation names who owns the broken relationship without the registry importing any product code.

## 8. Configuration knobs

Only meaningful in a composition that mounts the registry:

| Setting | Default | Effect |
|---|---|---|
| `enabled` | `true` | Global switch |
| `package_allowlist` | `[]` | Regex sources; empty admits all |
| `package_blocklist` | `[]` | Applied after the allowlist; a blocklist match wins |

Filters are compiled once at startup — changing them needs a plugin reload.

## 9. Interactions

- **[Ch 7](07-from-log-to-request.md)** — calls `deriveMessages()` as the expected value.
- **[Ch 10](10-building-the-request.md)** — supplies both the `WeakSet` tag and the header series this folds.
- **[Ch 22](22-extension-points.md)** — `prepend: true` exists because of waterfall short-circuit semantics.
- **[Ch 27](27-pruning-and-compaction.md)** — the main producer of requests this deliberately ignores.

## 10. Build it yourself

Minimal version — put it right before dispatch:

```ts
if (JSON.stringify(request.messages) !== JSON.stringify(session.deriveMessages())) {
  throw new Error('log-reconstruction desync')
}
```

Two lines will catch the majority of real regressions. What the real one adds:

| Addition | Why it exists |
|---|---|
| A `WeakSet` tag to scope the check | One-shot calls are legitimately different and must not fail |
| `prepend: true` | A short-circuiting listener could otherwise silence it |
| Frozen checks on request and messages | Catches mutation-after-build, which equality alone would miss |
| The header half | Messages alone are not the whole request |
| Package-attributed errors | A violation should name its owner without the checker importing product code |
| A registry with filters | On the hot path, this must be switchable per deployment |

---

## Key takeaways

- 35 lines assert that an outgoing request's messages equal a fresh derivation from the log, plus that every header field matches the folded header.
- It runs prepended and globally, so no listener can short-circuit past it.
- **It is mounted nowhere in the shipped configuration** — the registry that runs companions is deliberately absent from the base composition.
- It remains the clearest available definition of the engine's central guarantee, and it runs in test compositions.
- Only loop-built requests are in scope; one-shot calls such as compaction's are excluded by design.

## Exercises

1. The check re-derives messages *inside* the dispatch path rather than comparing against a value captured at build time. Name a bug the first catches and the second would not.
2. Suppose you removed `prepend: true`. Describe a listener that would then hide a genuine desync, and say whether it would look malicious or ordinary.
3. The engine's guarantee holds for loop-built requests only. Design a second invariant covering compaction's one-shot summarization call — what relationship does *it* own that could be checked at runtime? (Re-read §2's rule for what qualifies before answering.)

**Next:** [Chapter 12 · The inbox](12-the-inbox.md)
