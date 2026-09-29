# Chapter 36 · Design decisions

**What you'll learn:** the reasoning behind six choices that shaped everything else, each as Context → Decision → Alternatives → Tradeoffs.

**Prerequisites:** Part III.

---

A note on evidence. These are **reconstructions**, assembled from the code, its comments, and the repository's own design notes. Where the codebase states a rationale I quote it; where I am inferring from structure I say so. A reader should treat the Context and Decision sections as verified and the Alternatives sections as my analysis.

---

## ADR-1 · The log is the single source of truth

**Context.** An agent needs the conversation to build each request. It also needs to resume after a crash, fork at a known-good point, shrink history that outgrew the window, and replay a session deterministically for tests.

**Decision.** Store an append-only event log. Recompute the message list from it immediately before every dispatch. Never hold a separate transcript.

The rule is repo-wide: *"Model-visible ⟺ logged: anything that reaches a model request must be reconstructable from the session log; a new model-visible input requires a session event"* (`AGENTS.md`). It is stated as an executable assertion in `agent-loop/src/invariant.ts` ([Ch 11](11-the-reconstruction-invariant.md)).

**Alternatives.**
- *In-memory array, persisted periodically.* Simplest. Resume needs a separate serialization; fork needs a deep copy; replay needs a fixture format that can drift from the live shape.
- *Log plus a cached transcript, synchronized.* Faster. Two sources that can disagree — and the disagreement appears as a session that replays differently than it ran.

**Tradeoffs.**
- **Cost:** ~43 events for a single one-word turn ([Ch 31](31-one-real-turn.md)). Every streamed chunk is an event, which is why a compression codec had to be written ([Ch 30](30-crash-repair-and-chunk-packing.md)).
- **Cost:** derivation runs on every request, needing an incremental cache with a generation guard ([Ch 7](07-from-log-to-request.md)).
- **Benefit:** resume, fork, compaction, and replay all become operations on one data structure.
- **Benefit:** the correctness property is *checkable*. Most designs cannot state their central invariant as an assertion.

---

## ADR-2 · Rewrite history by superseding, never by mutating

**Context.** ADR-1 makes the log permanent. Context windows are finite. Something has to shrink.

**Decision.** Add a **surface** — an ordered list of visible log positions — and a `replace` operation that splices a range out of that list and substitutes one new event. The raw events stay where they are.

**Alternatives.**
- *Delete old events.* Contradicts ADR-1 outright; the user's scrollback loses content they saw.
- *Rewrite messages in place.* Same problem, plus it breaks provenance: nothing can say what a summary stands for.
- *Keep a separate "visible" copy.* Two sources again, and compaction becomes a synchronization problem.

**Tradeoffs.**
- **Cost:** an indirection every reader must understand. The log and the surface are different things, and a UI reading the wrong one shows a user their own history disappearing ([Ch 6](06-the-surface.md)).
- **Cost:** provenance rules — complete shadowed-node coverage, the narrow `tool/result` rewrite — are real complexity.
- **Benefit:** compaction is a normal append. No special write path, no locking of history, no risk of losing what was summarized.
- **Benefit:** `replaceGeneration` gives four other mechanisms a precise "history changed" signal ([Ch 7](07-from-log-to-request.md), [Ch 10](10-building-the-request.md), [Ch 21](21-runtime-context-injection.md)).

---

## ADR-3 · Registrations are effects

**Context.** Plugins contribute tools, prompt sections, projections, adapters, and listeners. Plugins unload — on hot reload, on preset teardown, when a dependency disappears. Every contribution must be removable, exactly once, without a bookkeeping registry of what to undo.

**Decision.** Every contribution goes through `ctx.effect()`, and every `register()` returns the disposer that undoes it. Stated as a repo rule: *"Registrations are effects: every contribution goes through `ctx.effect()` / `ctx.on()`; a registry's `register()` returns the disposer."*

**Alternatives.**
- *Explicit `unregister(name)`.* Requires every caller to remember names and call sites, and double-unregister becomes a real bug class.
- *Garbage-collect on plugin unload.* Needs the framework to know every registry — inverting the dependency the plugin system exists to avoid.

**Tradeoffs.**
- **Cost:** a nuance that surprises people — nested disposers are ordered LIFO, but sibling top-level effects tear down concurrently ([Ch 35](35-limits-and-fragile-areas.md)).
- **Benefit:** teardown is structurally correct by default. An agent's whole lifecycle, including its running driver, is disposed by one effect on the owner fiber ([Ch 14](14-agent-lifecycle.md)).
- **Benefit:** the pattern generalizes — `provide()` is an effect, so *un-providing* a service is a synchronization point that awaits every dependent's re-settlement.

---

## ADR-4 · The agent plane moves behind presets

**Context.** One process serves many browser sessions. Different sessions may want different tools, personas, and delegation backends. But registries (`tools`, `skill`, `jobs`, `subagents`) are process singletons that host code and the API layer must reach.

**Decision.** Split into two planes. **Host plane:** registries, sandbox and approval stack, persistence, model routes — mounted once, visible everywhere. **Agent plane:** the tools, prompt sections, and per-agent services a session gets — mounted once per preset under a standing scope, joined by scope parentage.

The test is stated in the composition's own comments: a row that **publishes** a service must sit in an `isolate` realm; a registry something **outside** the preset reads belongs to the host plane.

**Alternatives.**
- *One global composition.* Simple, and every session gets identical tools. Rules out per-session presets entirely.
- *A full plugin tree per session.* Maximum isolation, and a fresh import and fiber graph per session — plus every process singleton would be duplicated and collide.

**Tradeoffs.**
- **Cost:** the hardest thing in this codebase to read correctly. Three layers, last-write-wins, `config` replaced rather than merged. A reader checking two layers concludes compaction and most tools are disabled ([Ch 34](34-composition-in-full.md)).
- **Cost:** two unrelated isolation mechanisms coexist — Cordis realms and `dsh-scope` layering — with similar-sounding names and different jobs.
- **Benefit:** the marginal cost of a session joining a preset is **one `WeakMap` entry**. No fiber, no instance, no import.
- **Benefit:** `mountPreset` mechanically rejects a row that leaked a service, so the hazard fails loudly at mount rather than silently at runtime.

---

## ADR-5 · Retry is an extension point, not a loop feature

**Context.** Requests fail transiently. Retrying is standard. But the right policy is deployment-specific: a flaky network wants aggressive retries, an interactive product may prefer failing fast, and *some* failures need a different response entirely — an oversized context needs compaction, not repetition.

**Decision.** The loop offers `agent/request-error` with a terminal default. It contains no retry logic. A listener returning `{ kind: 'retry' }` causes the request to be rebuilt and re-sent; anything else ends the step.

**Alternatives.**
- *Retry in the loop, configured.* Every deployment gets one policy shape. Compaction-on-overflow would need a separate hook anyway, or would be special-cased into the loop.
- *Retry in the adapter.* Invisible to the session log, so a retry budget could not be durable, and compaction could not participate at all.

**Tradeoffs.**
- **Cost:** no retries unless something is mounted. A request with no prepared call carries no policy and is never retried — which is exactly the unconfigured-install path ([Ch 32](32-when-things-go-wrong.md)).
- **Cost:** the loop cannot bound retries. An `always` policy retries forever ([Ch 35](35-limits-and-fragile-areas.md)).
- **Benefit:** compaction and retry compose on one seam without knowing about each other. Compaction claims overflow; retry handles the rest.
- **Benefit:** because a retry rebuilds from the log, a listener can *change history* and have the rebuilt request pick it up. That is what makes compact-then-retry work at all, and it falls out of ADR-1 rather than being designed separately.

---

## ADR-6 · `policy: 'never'` is not delegatable

**Context.** A deployment can set approval to `never`, meaning actions requiring approval are auto-rejected. Approval requests are answered through a waterfall, and waterfall listeners are ordered, with `prepend` available ([Ch 22](22-extension-points.md)).

**Decision.** Check the policy **inline, before the waterfall runs at all**:

```ts
if (policy === 'never') return 'rejected'
```
— `packages/interaction/user-approval/src/index.ts:277`

**Alternatives.**
- *A prepended listener enforcing the policy.* Reads more uniformly — every decision through one mechanism. But "prepended" is only a position in a list, and another listener can also prepend. Correctness would depend on registration order, which depends on mount order, which depends on composition.

**Tradeoffs.**
- **Cost:** an asymmetry. One decision is special-cased while the rest go through the extension point, which a reader must notice.
- **Benefit:** the guarantee is structural rather than configurational. No plugin, in any composition, in any order, can turn `never` into a grant.
- **Benefit:** it pairs with the opposite use of the same insight — the reconstruction invariant uses `prepend: true` precisely *because* a short-circuiting listener could otherwise silence it ([Ch 11](11-the-reconstruction-invariant.md)). The codebase knows ordering is unreliable and reasons about it in both directions.

---

## What the six have in common

Two principles recur.

**Make the correctness property checkable.** ADR-1 produces an assertion. ADR-4 produces `leakedServices()`. ADR-6 produces a guarantee no configuration can defeat. Where a rule could be stated as code that fails, it was.

**Prefer a mechanism that fails loudly over one that degrades quietly.** Unknown event types refuse a session rather than being skipped. A malformed chunk row throws rather than dropping a run. A preset that leaks a service fails session creation. An approval that cannot be answered is denied, never allowed.

The exceptions are deliberate and narrow: spill degrades to keeping the original content, presenters swallow invalid historical arguments, and `emit` listener failures are contained. Each is a case where failing loudly would cost more than the failure itself.

---

## Key takeaways

- The log-as-truth decision is the root; ADRs 2 and 5 are consequences of making it work.
- Superseding instead of mutating buys safe compaction at the cost of an indirection every reader must learn.
- Registrations-as-effects makes teardown correct by default, with one concurrency nuance.
- The preset split costs real readability and buys near-zero marginal cost per session.
- Retry lives outside the loop so compaction can share the same seam.
- One security decision is deliberately *not* delegatable, because listener order is not a guarantee.

## Exercises

1. Pick an ADR and argue the alternative. What would this codebase look like if it had gone the other way, and which chapters would disappear?
2. ADR-5's benefit — a listener can change history and have the retry pick it up — is a consequence of ADR-1, not a designed feature. Find another such consequence elsewhere in the book.
3. §"What the six have in common" claims failures are loud except in three narrow cases. Find a fourth, and decide whether it belongs with the exceptions or is an oversight.

**Next:** [Chapter 37 · Rebuild it](37-rebuild-it.md)
