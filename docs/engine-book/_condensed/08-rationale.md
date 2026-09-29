# Appendix E · Why each mechanism is more than its minimal version

Every mechanism here has a version you could write in a dozen lines. This appendix is the difference: for each, the minimal form, then **what the real implementation adds and the specific failure each addition prevents**. It is the densest statement of the engine's accumulated hard-won knowledge.

## The log (§5)

```ts
append(type, data) { const e = Object.freeze({type, seq: this.log.length, time: Date.now(), data}); this.log.push(e); return e }
```

| Addition | Failure it prevents |
|---|---|
| Lossless-JSON snapshot | A payload that cannot round-trip becomes corrupt storage discovered much later |
| Freezing | Callers share references; a caller could mutate logged history |
| Reentrancy refusal | A listener appending during dispatch breaks `seq = log.length` |
| Pre-commit surface validation | A bad marker must fail with nothing mutated, not leave a half-valid surface |
| Contained observers | One bad listener must not un-commit history |
| `ignorable` + generated known-type gate | Vocabulary must grow without breaking old readers, and fail loudly when it cannot |
| Cached `events` snapshot | Readers ask constantly; re-copying the array each time is wasteful |

## The surface (§6)

```ts
apply(seq, op) { if (op === 'append') this.nodes.push(seq)
  else { const s = this.nodes.indexOf(op.start), e = this.nodes.indexOf(op.end)
         this.nodes.splice(s, e - s + 1, seq); this.replaceGeneration++ } }
```

| Addition | Failure it prevents |
|---|---|
| Closed eligibility + mandatory intent | An event silently defaulting to "append" corrupts history undetectably |
| Provenance coverage | Without it a replacement's meaning depends on range bounds later rewrites can shift |
| Strictly-earlier source check | Citing a later event makes the log unreplayable in order |
| Narrow `tool/result` rewrite | A general rewrite could change *whether a tool failed*; only its text should shrink |
| Append-origin guards | Human and model transcripts genuinely diverge after a compaction |
| Incremental fold + pure `foldSurface` | The hot path reads this constantly; offline readers must rebuild from nothing |

## Derivation (§7)

```ts
deriveMessages() { return this.surface.nodes.map(s => deriveEventMessage(this.log[s])).filter(Boolean) }
```

| Addition | Failure it prevents |
|---|---|
| Append-only cache + cursor | Every step re-derives; re-walking the whole surface each time is wasted work |
| Generation-guarded invalidation | A replace edits the *middle* of the node list, so an append-only cache is invalid |
| Fresh array, shared frozen messages | Callers must not see each other's mutations; deep-cloning frozen data is pointless |

What is *absent* is the lesson: no reformatting, no framing, no merging of adjacent messages. Each would have baked a decision into replay.

## Projections (§8)

```ts
function project(events, init, apply) { return events.reduce(apply, init) }
```

| Addition | Failure it prevents |
|---|---|
| A registry keyed by name | Consumers each re-walking the log |
| `stateVersion` | A changed fold forward-applying old caches into garbage |
| Refcounted registration | The same package mounts under several presets |
| `Object.is` double debounce | Most events are irrelevant to most folds; notifying on every append floods clients |
| Checkpoint / `restoreFloor` / hydrate | A cold start re-folding a 10,000-event log |
| Separate `state` and `wire` | Host folds often hold more than a browser should see |

## The turn and step loops (§9)

| Addition | Why it exists |
|---|---|
| `null` vs an ending as the step's return | Distinguishes "keep going" from "done" without a second flag |
| Sticky `max-tokens` | A later clean step must not mask a truncated answer |
| `turn-stopping` re-test | Gives plugins a final chance to continue, without letting listener order decide |
| Fresh abort controller per turn | Cancellation should scope to a turn, not kill the agent |
| Structured error endings | Replay and UI need a code, never a bare string |
| Abort check before each boundary append | Prevents an unbalanced `step/start` with no `step/end` |
| Interrupted-message salvage | Cancelling mid-answer should not discard what was already said |
| Retry delegated to a waterfall | Retry policy is deployment-specific; the loop should not own it |

## Request construction (§10)

| Addition | Why it exists |
|---|---|
| `adapterDefaults` + `requestProposal` | Otherwise one model's defaults silently follow you to another model |
| Three-condition effort restoration | A persisted effort level is only meaningful on the model that had it |
| `agent/request` waterfall | Model switching must not require touching the loop |
| `NO_ADAPTER`-only fallback | Middleware may serve unregistered routes; every other failure is real |
| Change-only header logging | A copy of the tool schemas on every step would dwarf the conversation |
| `series` reason | A byte-identical header can still begin a new series after a rewrite |
| `deepFreeze` + `markAgentLoopRequest` | Lets an observer tell "derived from the log" from "hand-built" — and prevents rewriting the former |

## The invariant (§11)

| Addition | Why it exists |
|---|---|
| A `WeakSet` tag scoping the check | One-shot calls are legitimately different and must not fail |
| `prepend: true` | A short-circuiting listener could otherwise silence it |
| Frozen checks on request *and* messages | Catches mutation-after-build, which equality alone would miss |
| The header half | Messages alone are not the whole request |
| Package-attributed errors | A violation should name its owner without the checker importing product code |
| A registry with filters | On the hot path, this must be switchable per deployment |

## The inbox (§12)

| Addition | Failure it prevents |
|---|---|
| Durable `agent/inbox/spliced` events | A crashed agent losing pending input |
| Append-before-mutate ordering | Observers unable to see the pre-splice state |
| Duplicate-id validation | The same message claimed twice, appearing twice in history |
| `claimed` distinct from `discarded` | "Consumed" and "thrown away" conflated for anything watching |
| Replay from `seedLength` | A fork double-counting inherited history |
| Abort-time retargeting | A message racing a cancellation swallowed by a dying turn |
| Throw on malformed replay | Running on a queue that cannot be reconstructed exactly |

## Phases and cancellation (§13)

| Addition | Why it exists |
|---|---|
| A third phase (`maintenance`) | Some work needs the agent still without looking busy |
| Status collapsed before comparison | A maintenance cycle should not flicker listeners |
| Per-phase, per-turn abort controller | Cancellation should scope to a turn |
| The wake latch | A wake arriving during the aborting window would be lost |
| `disposed` excluded from latching | Otherwise teardown waits on a turn it just cancelled |
| `hasPending` guard on replay | A latch whose message was cleared starting an empty turn |
| Clearing the latch on a new controller | A latch against a dead controller is meaningless |
| `whenIdle`'s re-check loop | A replayed wake installs new activity before old awaiters run |

## Agent lifecycle (§14)

| Addition | Failure it prevents |
|---|---|
| Undo registered before resources exist | An unload mid-construction leaking a running agent |
| Memoized `dispose` | Racing owners starting parallel teardowns of the same agent |
| Three fused abort sources | A caller-cancelled create still running because only the factory was checked |
| `assertLive()` after each announcement | A listener starts teardown and the agent finishes wiring itself anyway |
| Enter both registries before announcing | An observer finding a half-entered agent |
| `releaseAbandoned` on a raced load | A cancelled disk load completing and leaking its preparation |
| Re-check ownership after the load | The factory shut down while the disk spun |
| Factory awaits startup tasks | Teardown completing while an agent is still being created |
| `exists` check before create-fallback | A corrupt session silently replaced by an empty one |

## The tool registry and pipeline (§15–16)

| Addition | Why it exists |
|---|---|
| `ScopedLayers` instead of a Map | One registry must serve many agents with different tool sets |
| Mandatory `output` schema + `render` | Replay and UI need structured data, not prose |
| Strict `execute`, lenient presenters | Bad args must not run; old args must still render |
| Snapshotted `finalizeContent` | A hot reload mid-call applying the wrong tool's finalizer |
| Four separable stages | The scheduler must overlap dispatch while keeping policy and commits ordered |
| Collapse check before any listener | Never ask a human to approve a call that cannot run |
| Two cancellation checks in `prepare` | Cancellation can land before *or during* the policy await |
| `ABORTED` vs `ABORTED_BEFORE_DISPATCH` | Whether the body ran changes whether a retry is safe |
| Signal re-fusing | A wrapper must not be able to detach caller cancellation |
| Canonical-result marking | A result crossing several wrappers being re-validated each time |
| `needsPost` by producing stage | Denials deserve post-processing; impossible calls do not |

## Tool scheduling (§17)

| Addition | Why it exists |
|---|---|
| Per-call classification | A shell command and a file read have different safety properties |
| Barrier grouping | An exclusive call must see the effects of everything before it |
| Bounded pool | Unbounded parallelism exhausts file handles and provider limits |
| Contiguous ordered commit | Completion order is not model order; history must be model order |
| Live reclassification | The registry can change mid-group |
| Per-group cap read | A settings change must not disturb a batch in flight |
| Synthetic results on abort | An unbalanced call/result pair breaks the next request |
| Drain-don't-abandon | Started work must settle before the turn unwinds |
| **No** synthetic results on scheduler failure | Inventing results would hide a bug |

## Approval (§18)

| Addition | Why it exists |
|---|---|
| Both halves logged with a shared id | "Did someone approve this?" is asked later, about a resumed session |
| Refusal outside an open turn | An audit event belonging to no turn is unreadable |
| `never` checked inline, not as a listener | No registration order may leak a grant |
| Deterministic degradation to `deny` | An unanswerable question must never become an allow |
| Strictly-wider check before prompting | Prompting for a no-op trains people to click yes |
| Escalation as tool arguments | The request and its justification become durable log content |
| Conditional schema advertisement | Don't tell the model about a capability that cannot apply |
| Policy stated in the prompt | Enforcement and instruction must agree, or the model wastes turns |

## Prompt assembly and interpolation (§19–20)

| Addition | Why it exists |
|---|---|
| Scope-chain shadowing | Two agents in one process need different prompts |
| Centrally-assigned orders, ≥10 apart | Contributors cannot negotiate; gaps allow later insertion |
| Code-unit tie-breaking | Locale-aware sorting would reorder prompts per machine and break caching |
| Sections vs contexts | Volatile content must not sit in the cache-sensitive prefix |
| Accumulating tool providers | Every tool package contributes; none should shadow another |
| Empty-render dropping | Conditional guidance without a conditional mechanism |
| Cursor advancing past each value | A `{{` inside a substituted value becoming an instruction — template injection |
| Lone `{{` tolerated | Prompt text legitimately discusses braces |
| Unknown vs valueless as separate errors | A typo and an absent provider need different fixes |
| `Object.hasOwn` | `{{constructor}}` resolving to a stringified function |

## Runtime context (§21)

| Addition | Why it exists |
|---|---|
| Reconstruct from the log on construction | A resumed agent re-announcing what the model already knows |
| Three states, not two | "Never said" and "said but compacted away" need different handling |
| Watch replacement events | Compaction silently removing the snapshot the model relies on |
| The `CLEARED` sentinel | Going quiet leaves the model holding a stale snapshot |
| `sections` on the message source | Attribution for UIs, and a diff showing *why* it changed |
| Injection as the waterfall's innermost default | Listeners inherit it by delegating and suppress it by not |

## Extension points (§22)

| Addition | Why it exists |
|---|---|
| Three distinct modes | Observation, participation, and transformation need different guarantees |
| Scope-filtered delivery | One process runs many agents; listeners must not cross-talk |
| Agent fused into the payload | A caller dispatching about another agent |
| Per-listener containment in `emit` | Raw `ctx.emit` lets one throw abort the rest |
| `prepend` | Some checks must run before anything that could short-circuit |
| Dispatcher built once per agent | The hot path dispatches several times per step |

## Model I/O (§23–25)

| Addition | Why it exists |
|---|---|
| Resolve before dispatch | The header must be logged from the same resolution that is sent |
| Frozen, single-use prepared call | A retry silently reusing a stale resolution |
| Config equality at dispatch | Prepare-with-one, dispatch-with-another would make the log lie |
| Closure captured at prepare | A settings change mid-request mixing generations |
| Validated model metadata | A bad `contextWindow` silently breaking compaction's threshold |
| Registration-time retry capture | Policy is a property of the route, not of a request |
| Index-keyed partials | Blocks interleave; arrival order is not identity |
| `block-end` authoritative | The provider's structured close beats reconstructed deltas |
| Dropping tool calls on `max-tokens` | A truncated call's arguments are incomplete JSON |
| Throwing on an open unknown block | Guessing at an unfinished plugin block fabricates content |
| Normalization at the adapter boundary | Downstream seeing a raw thrown value |
| Property-descriptor reads | An error object's getter throwing *during error handling* |
| `UNKNOWN` for foreign codes | Another library's taxonomy treated as this one's |
| Durable retry counting | A budget in memory resets on restart |
| Append-before-wait | A crash during backoff leaving no evidence |

## Context management (§26–27)

| Addition | Why it exists |
|---|---|
| Prefer real usage over the estimate | The provider's count is authoritative once one call succeeds |
| The ≥-anchor guard | A smaller reported usage under-reporting and compacting too late |
| Spill as seam + backend + policy | Storage location, retention, and the decision are independent concerns |
| Retrieval hint naming existing tools | A bespoke retrieval tool the model must learn |
| Plain-text-only | Spilling an image reference breaks it |
| The `read` exclusion | read → spill → read loops |
| Best-effort degradation | A failed save losing the tool's output |
| Prune before summarizing | The cheap deterministic fix often suffices |
| Tool-pair-balanced boundary | Splitting a call from its result invalidates the next request |
| Durable `compaction/start` lock | A mutex does not survive a crash or appear in a log |
| Prefix reuse for summarization | Keeps the provider's KV cache warm |
| Refusing a non-shrinking compaction | A terse session compacting repeatedly for nothing |
| `replaceGeneration` check before claiming retry | Claiming a retry when nothing changed |
| `compaction/end` even on failure | A wedged lock freezing the session |

## Delegation and durability (§28–30)

| Addition | Why it exists |
|---|---|
| Named providers | `spawn` and `fork` differ only in seeding; more backends can register |
| Depth cap floored by persisted depth | A resumed parent forgetting how deep it is |
| Preset composition via `composeFrom` | A child with no tools is useless |
| Stop-reason mapping | "It stopped" is not enough; the parent needs to know why |
| Host-plane registry | Cross-session queries and unique provider names |
| Backend / coordinator split | Every backend reimplementing crash handling, differently |
| `link()` over `rename()` | A second process silently destroying the first's file |
| fsync + truncate rollback | A half-written line breaking every future load |
| Reservation with mutation check | Serving a stale prepared session to the next caller |
| Rejecting an already-live id | Two live sessions diverging under one identity |
| Live-prefix adoption | Crash-repairing a turn that is still running |
| Fork rejecting an open turn | A child whose first request is invalid |
| Per-call result synthesis (repair) | A dangling tool call making the next request invalid |
| Two distinct repair codes | Retrying a call that may have run is dangerous |
| Reusing the last real time | Inventing a future timestamp corrupts ordering |
| Exact-shape whitelisting (packing) | An unrecognized variant losing data rather than compression |
| Safe-integer gap check | A rounded gap decoding to a different timestamp |
| Throwing on a malformed row | Silently dropping a whole run |
| Slash-less row tags | A reader mistaking a storage row for an event |
