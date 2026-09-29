# Chapter 33 · Adding a tool

**What you'll learn:** how to build a tool that behaves correctly in this engine, grounded in how the two most complex shipped tools are actually built.

**Prerequisites:** [Chapter 15](15-the-tool-registry.md), [Chapter 16](16-the-execution-pipeline.md), [Chapter 17](17-scheduling-tool-calls.md).

---

## 1. The decisions

Writing the function is the easy part. Six decisions determine whether the tool behaves correctly under replay, cancellation, concurrency, and compaction. Get them wrong and the failures appear weeks later, in sessions nobody can reopen.

| Decision | Wrong answer costs you |
|---|---|
| What is the canonical **value**? | replay cannot re-render; the UI has nothing structured |
| Is it **concurrency-safe**? | data races, or needless serialization |
| Does it need **approval**? | either a security hole or an unusable tool |
| Does it belong on the **host plane** or in a **preset**? | a service collision, or an invisible registry |
| What does it **present**? | a wall of text where a diff belongs |
| Should it **conclude the turn**? | almost always no |

## 2. The skeleton

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'my_tool',
    description: buildDescription(config),
    parameters: { /* schema DSL */ },
    output: {
      schema: { /* what execute returns */ },
      render: (args, value) => [{ type: 'text', text: format(value) }],
    },
    async execute(args, exec) {
      return doTheWork(args, exec)
    },
    isConcurrencySafe: () => true,
  }))
}
```

`register()` returns the disposer and runs inside `ctx.effect` — unmounting the plugin removes the tool with no bookkeeping ([Ch 15](15-the-tool-registry.md)). The `apply()` function is already inside the plugin's effect scope, so both levels unwind together.

## 3. Value, not prose

The single most consequential choice. `execute` returns a **canonical value**; `output.render` projects it into what the model reads.

Compare the two shipped extremes.

**`bash` returns structure.** Its `output.schema` is a `oneOf` of two shapes (`packages/shell/tool-bash/src/index.ts:270-321`):

```
{ kind: 'background', jobId }
{ kind: 'foreground', exitCode, signal, timedOut, aborted, timeoutMs, stdout, stderr, sandbox? }
```

`execute` (`:329-389`) returns one of those; `render` turns it into text. Because the exit code is a *field*, the UI presenter can parse it into a status pill, and replay re-renders identically without re-running anything.

**`str_replace_editor` returns a string.** `output.schema: { type: 'string' }`, and `render` wraps it in one text block (`packages/fs/tool-str-replace-editor/src/index.ts:469`). Simpler, and it gives up the structured affordances.

**The rule:** if any consumer — a UI, a policy, a future presenter — would want to branch on part of the result, that part belongs in the value, not in formatted prose.

And remember from [Chapter 16](16-the-execution-pipeline.md): `value` **never reaches the durable log**. Only the rendered content, `error.info`, and `meta` are persisted. If a presenter needs data at replay time, put it in `meta`.

## 4. Concurrency

```ts
isConcurrencySafe: () => true
```

Declaring it opts into the parallel pool. Omitting it means exclusive — and classification is **fail-closed**: no declaration, a throwing classifier, or any non-`true` return all yield exclusive ([Ch 17](17-scheduling-tool-calls.md)).

Shipped choices:

| Tool | Declares | Reasoning |
|---|---|---|
| `read` (`tool-fs`) | `() => true` | "Observation races fail closed because guarded mutations re-check the version in-lock" |
| `web_search` | `() => true` | "Provider reads do not mutate parent-agent state" |
| `bash` | — | arbitrary commands; unsafe by default |
| `str_replace_editor` | — | **even for its read-only `view` command** |

That last row is a real decision worth weighing. `str_replace_editor` could classify per-argument (`args.command === 'view'`), and the mechanism supports it — but it does not. Two first-party file-reading tools therefore make opposite choices.

The conservative default is right: a wrong "safe" is a data race; a wrong "unsafe" is only slower.

If you do classify per-argument, note that `defineTool` wraps the classifier **softly** — invalid arguments yield `false` rather than throwing ([Ch 15](15-the-tool-registry.md)), because it runs against historical arguments on replay.

## 5. Approval

Two options, and [Chapter 18](18-approval-and-escalation.md) established which one ships.

**The pipeline seam** — a `tools/pre-execute` listener returning `{ kind: 'ask' }` — is fully implemented and has **no always-on producer**. Use it for a deployment-wide policy layer, not for one tool.

**In-body escalation** is what shipped tools do:

```ts
const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
  ? await approveBashEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
  : undefined
```
— `tool-bash/src/index.ts:329-338`

Three properties worth copying:

1. **The request is part of the call.** `sandbox_permissions` and `justification` are ordinary parameters, so both are logged in the `tool/call` event. The model's stated reason is durable.
2. **The parameters are conditionally advertised.** They appear in the schema only when something actually confines the tool (`escalationModes.length > 0`, `:192`). Never tell the model about a capability that cannot apply.
3. **A denial is just an error.** `approveEscalation` throws; `dispatchToolBody` catches it; the model reads `Error: the user rejected...` and can react in the same turn.

## 6. Host plane or preset

A composition question with a concrete test, stated in the standard preset's own comments:

> A row that **publishes a service** must sit inside an `isolate` realm, or it becomes process-global and collides with another preset's copy.

> A **registry that something outside the preset reads** belongs to the host plane.

Worked examples from the shipped composition:

| Row | Plane | Why |
|---|---|---|
| `tools`, `skill` registries | host | preset rows register *into* them |
| `jobs` registry | host | `tool-bash` (a preset row) resolves it with `ctx.get`; a realm would make it invisible |
| `subagents` registry | host | process singleton; the API serves cross-session queries from it |
| `token-meter` | host | owns projection units the browser reads for every session |
| `tool-bash`, `tool-fs`, `tool-web` | preset | register into the host registry, publish nothing → need no realm |
| `compaction-basic` + `tool-result-pruner` | preset, **shared realm** | the engine reads the pruner via `ctx.get`, so they must share one |
| `plan-mode` | preset, own realm | plan state is per-agent by nature |

**The default for a new tool is a preset row that registers into the host registry and publishes nothing.** That needs no realm at all.

## 7. Presentation

Two optional pure functions, both run against possibly-historical arguments:

```ts
presentCall?(args): ToolCallView | undefined
presentResult?(args, result): ToolResultView | undefined
```

`bash` renders a terminal view, parsing its `[exit code: N]` marker into a pill. `str_replace_editor` returns a `DiffCallView` with `oldText`/`newText` for `create` and `str_replace`, and a generic view for `view` and `insert` (`:376-423`) — so the UI shows a diff for edits without the tool knowing anything about rendering.

They must be **pure functions of their inputs**. A presenter reading external state produces different output on replay than it did live.

## 8. A worked example

A tool reporting the current git branch.

```ts
ctx.tools.register(defineTool({
  name: 'git_branch',
  description: 'Report the current git branch and whether the working tree is clean.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  // Structured: a consumer may want to branch on `clean`.
  output: {
    schema: {
      type: 'object',
      properties: { branch: { type: 'string' }, clean: { type: 'boolean' }, ahead: { type: 'number' } },
      required: ['branch', 'clean', 'ahead'],
    },
    render: (_args, value) =>
      [{ type: 'text', text: `${value.branch}${value.clean ? '' : ' (dirty)'}, ${value.ahead} ahead` }],
  },

  // A read. No parent-agent state mutated.
  isConcurrencySafe: () => true,

  async execute(_args, exec) {
    const result = await ctx.shell.run({ command: 'git status --porcelain -b', signal: exec.signal })
    return parseStatus(result.stdout)
  },
}))
```

Checked against §1:

- **Value** — structured, so a UI can style `clean` and replay re-renders without running git.
- **Concurrency** — safe; it reads.
- **Approval** — none; it is non-mutating and inside the existing sandbox.
- **Plane** — a preset row registering into the host `tools` registry, publishing nothing. No realm.
- **Presentation** — the default render is adequate; a `presentResult` could add a branch chip later without touching `execute`.
- **`concludesTurn`** — no. Almost nothing should ([Ch 17](17-scheduling-tool-calls.md)).

Note `exec.signal` is passed through. A tool that ignores it delays cancellation with no watchdog to save it ([Ch 13](13-phases-cancellation-quiescence.md)).

## 9. What else you can reach

| Need | Mechanism |
|---|---|
| Inject a message into the **next** step | `exec.deferContext(message)` → `additionalContexts` ([Ch 17](17-scheduling-tool-calls.md)) |
| End the turn after this result | `exec.concludeTurn()` — only for a genuine terminal answer |
| Persist replay-time presentation data | `meta` on the result |
| Content even when the pipeline bypasses post-execute | `finalizeContent` — snapshotted at call creation |
| Bound the call's duration | `timeoutMs` — cooperative, enforced by a policy plugin, never shown to the model |

## 10. The checklist

Before registering:

- [ ] Does `execute` return a **value**, with `render` doing the formatting?
- [ ] Would any consumer want to branch on part of the result? Then it is a field, not prose.
- [ ] Is `isConcurrencySafe` declared only if genuinely true for **every** argument shape?
- [ ] Is `exec.signal` threaded into everything that can block?
- [ ] Are presenters pure functions of their arguments?
- [ ] Does the description tell the model when *not* to use it? (Every shipped description does.)
- [ ] Does it publish a service? If so, it needs an `isolate` realm.
- [ ] Does anything outside a preset need to read it? If so, it belongs on the host plane.
- [ ] Have you resisted `concludeTurn()`?

---

## Key takeaways

- `execute` returns a canonical value; `render` produces what the model reads. That split is what makes replay and UI presentation possible.
- `value` is never persisted — use `meta` for replay-time data.
- Concurrency classification is fail-closed; declare safe only if it is true for every argument shape.
- Shipped tools gate themselves in-body, with the escalation request as ordinary logged parameters.
- The default placement is a preset row that registers into a host registry and publishes nothing.
- Presenters must be pure; they run against historical arguments.

## Exercises

1. Rewrite the `git_branch` example to return a formatted string instead of a value. List everything that breaks, citing the chapter for each.
2. `str_replace_editor` is exclusive even for `view`. Write the per-argument classifier that would fix it, then give two reasons the authors might still decline it.
3. Design a tool that must ask the user before running. Write it both ways — pipeline seam and in-body — and say which you would ship here, and why.

**Next:** [Chapter 34 · Composition in full](34-composition-in-full.md)
