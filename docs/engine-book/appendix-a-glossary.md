# Appendix A · Glossary

Every domain and project-specific term the book introduces, with where it is defined in the text.

---

**adapter** — An object that knows how to talk to one or more model providers. Only `stream()` is required; everything else has a default. Registered against provider names, with its retry policy captured at registration. → [Ch 23](23-adapters-and-preparecall.md)

**`adapterDefaults`** — A record of which config fields the *caller* omitted and the *adapter* supplied (`{ reasoningEffort?: true, maxTokens?: true }`). Used to strip those fields from the next request so they get re-resolved rather than inherited across a model change. → [Ch 10](10-building-the-request.md), [Ch 23](23-adapters-and-preparecall.md)

**agent plane** — The set of plugins composing what *one agent* contributes: its tools, prompt sections, and delegation backends. Mounted per preset, in contrast to the host plane. → [Ch 34](34-composition-in-full.md)

**`AgentEventDispatch`** — The fused, agent-scoped wrapper over Cordis's three dispatch modes. Injects the agent into every payload and routes through the agent's scope carrier so identity and routing cannot diverge. → [Ch 22](22-extension-points.md)

**barrier** — An exclusive tool call that runs alone: everything before it has committed, nothing after it starts until it finishes. → [Ch 17](17-scheduling-tool-calls.md)

**`BlockAssembler`** — Accumulates stream chunks into content blocks, keyed by block index. Exposes different views depending on how the stream ended. → [Ch 24](24-streaming-and-assembly.md)

**canonical result** — A tool result already validated and rendered through its tool's output contract; re-normalizing one is a no-op. → [Ch 16](16-the-execution-pipeline.md)

**compaction transaction** — A `compaction/start` event, some work, and a `compaction/end` event. The start event *is* the lock, so it survives a crash and is visible in the log. → [Ch 27](27-pruning-and-compaction.md)

**Cordis** — The vendored dependency-injection and plugin framework everything is built on. Four concepts matter: context, service, fiber, effect. → [Ch 2](02-just-enough-architecture.md), [Ch 34](34-composition-in-full.md)

**context (Cordis)** — The object every plugin receives. Reading an unknown property is a *service lookup* that walks the fiber chain. → [Ch 2](02-just-enough-architecture.md)

**context sections** — Prompt contributions that become a runtime-context *message* rather than part of the system prompt, because they change during a session. Only three producers exist. → [Ch 19](19-prompt-assembly.md), [Ch 21](21-runtime-context-injection.md)

**durable-first** — Committing a change to the session log *before* mutating memory, so synchronous observers see the pre-change state and the change survives a crash. The inbox works this way. → [Ch 12](12-the-inbox.md)

**effect** — `ctx.effect(fn, label)` runs `fn` immediately and collects its return as a teardown handle. Every registration in the codebase is one. → [Ch 2](02-just-enough-architecture.md), [Ch 36](36-design-decisions.md)

**fiber** — One running instance of one plugin, with a lifecycle. Stays `PENDING` until every injected dependency resolves; unloads automatically when one disappears. → [Ch 2](02-just-enough-architecture.md)

**host plane** — Plugins mounted once, visible everywhere: registries, sandbox and approval, persistence, model routes. → [Ch 34](34-composition-in-full.md)

**inbox** — Two ordered queues of pending user messages (`next-turn`, `next-step`), drained at step boundaries, reconstructed by replaying `agent/inbox/spliced` events. → [Ch 12](12-the-inbox.md)

**invariant companion** — A small plugin shipped by a package that checks a durable relationship the package owns, at runtime. About thirty exist; the registry that runs them is mounted nowhere. → [Ch 11](11-the-reconstruction-invariant.md)

**isolate realm** — A Cordis mechanism remapping which symbol a service name resolves to for one entry's subtree, so a per-preset service does not collide process-wide. Visibility is the default; a realm is a narrowing. → [Ch 34](34-composition-in-full.md)

**maintenance** — A phase for work needing the agent to hold still (manual compaction) during which no turn may start, but which reports externally as `idle`. → [Ch 13](13-phases-cancellation-quiescence.md)

**`markAgentLoopRequest`** — A process-local `WeakSet` tag marking a request object as loop-built (frozen, derived from the log) versus a hand-built one-shot call. Never serialized. → [Ch 10](10-building-the-request.md)

**phase** — The agent's internal state: `idle`, `maintenance`, or `running`. Collapses to two external statuses. → [Ch 13](13-phases-cancellation-quiescence.md)

**prepared call** — A frozen, single-use object pinning one request's resolved config, retry policy, adapter defaults, and bound dispatch closure. → [Ch 23](23-adapters-and-preparecall.md)

**preset** — A named agent-plane composition. Mounted once per (preset id, file generation) under a standing scope; each agent joins by one `WeakMap` parent link. → [Ch 34](34-composition-in-full.md)

**profile** — Not a file. An empty root config plus an ordered stack of patch layers. The shipped one is `web`. → [Ch 2](02-just-enough-architecture.md), [Ch 34](34-composition-in-full.md)

**projection** — A registered, versioned, pure fold over the session log. The general form of what `deriveMessages` does for messages. → [Ch 8](08-projections.md)

**`PromptAssembly`** — The resolved but still-uninterpolated result of prompt assembly: sections, contexts, tools, and variables. → [Ch 19](19-prompt-assembly.md)

**prompt variable** — A named `(context) => string | undefined` provider, evaluated once per assembly and substituted at render time. The engine registers `provider`, `model`, and `cwd`. → [Ch 20](20-variable-interpolation.md)

**PTC / `run_code`** — A tool-presentation mode where the model writes a program that calls tools, rather than calling them directly. Behind `DSH_TOOLS_MODE`; unset keeps the `native` default. → [Ch 15](15-the-tool-registry.md), [Ch 16](16-the-execution-pipeline.md)

**request header** — The non-message half of a request: config, system prompt, tool schemas, and `adapterDefaults`. Logged only when it changes, with four possible reasons. → [Ch 10](10-building-the-request.md)

**`replaceGeneration`** — A counter incremented once per committed surface replace. The system's "history was rewritten" signal, read by four separate mechanisms. → [Ch 6](06-the-surface.md)

**`seq`** — An event's monotonic sequence number, always equal to its zero-based index in the log. Assigned in one place, verified in four. → [Ch 5](05-the-append-only-log.md)

**`Session`** — A plain class (not a service) holding one conversation's append-only log, its surface, and its immutable header. → [Ch 5](05-the-append-only-log.md)

**`SessionPreparation`** — A `Disposable` wrapper around one *unpublished* session, letting a caller decide whether to publish and cleanly release backend state if not. → [Ch 29](29-persistence.md)

**snapshot message** — The synthetic `user/message` carrying runtime-context sections, injected only when its text differs from the last still-visible one. → [Ch 21](21-runtime-context-injection.md)

**spill** — Writing an oversized plain-text tool result out of line at execution time, leaving a bounded preview plus a retrieval pointer. → [Ch 26](26-measuring-and-spilling.md)

**step** — One model request within a turn. A turn with three tool round-trips has four steps. → [Ch 9](09-the-turn-and-step-loops.md)

**surface** — The ordered list of log positions the model currently sees. The model's view; the log is the record. → [Ch 6](06-the-surface.md)

**`surfaceOp`** — The mandatory declaration on a surface-eligible event: `'append'` or `{ op: 'replace', start, end }`. → [Ch 6](06-the-surface.md)

**subagent** — A genuine nested `Agent` created through the same factory. `spawn` starts empty; `fork` seeds the parent's completed turns. → [Ch 28](28-subagents.md)

**token meter** — A per-session measurement preferring real provider usage and falling back to a fixed 4-characters-per-token heuristic. Not a tokenizer. → [Ch 26](26-measuring-and-spilling.md)

**turn** — One unit of conversation: roughly one user prompt and everything the model does in response. → [Ch 9](09-the-turn-and-step-loops.md)

**turn ending** — A `TurnEndReason` recording why a turn stopped: `completed`, `max-tokens`, `blocked`, `aborted`, `error`, or `interrupted`. Written once, in a `finally`. → [Ch 9](09-the-turn-and-step-loops.md)

**waterfall** — A dispatch mode where listeners form nested continuations. A listener returning without calling `next()` vetoes everything after it, including the caller's default. → [Ch 22](22-extension-points.md)

**wake latch** — A deferred wake recorded when the agent cannot act on it now, replayed at convergence — but never during disposal. → [Ch 13](13-phases-cancellation-quiescence.md)
