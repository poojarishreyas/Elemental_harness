# Chapter 34 · Composition in full

**What you'll learn:** how ninety-odd plugins become a running system, why no file lists them, and the two unrelated isolation mechanisms that keep one agent's plugins out of another's.

**Prerequisites:** [Chapter 2](02-just-enough-architecture.md). Deferred until now deliberately — this is far more interesting once you know what is being composed.

---

## 1. The problem

The engine is one plugin among many, and which others are present changes what the system *is*. A composition mechanism has to answer four questions at once:

- How does a deployment change one plugin's config without forking the whole list?
- How do two agents in one process have different tools?
- How does a per-agent plugin publish a service without colliding with another agent's copy?
- How does config that depends on runtime facts — the platform, an environment variable, a bound port — get evaluated at the right moment?

## 2. The boot chain

Grounded end to end:

```
apps/server/src/index.ts              — hardcodes profile: 'web' (:16)
  → args.ts:22 parseServerArgs        — rejects --profile (:33-35)
  → profile-boot.ts:208 runProfile
      → composeProfile (:156)         — resolves bundles, collects patch layers
      → prepareProfile (:80-84)       — WRITES cordis.yml = the literal "[]"
  → app-boot/src/index.ts:772 boot
      → new Context()                 (:779)
      → ctx.plugin(Loader)            (:786)
      → mountRootInclude (:789)       — one root entry: cordis:include + all patches
          → Include[Service.init]     — reads the file, applies patches
          → applyEntryPatches         — the patch algebra (§3)
          → EntryGroup.update         — creates every row CONCURRENTLY
              → Entry._start → registry.plugin → new Fiber
                  → new AgentLoop(ctx, config)
```

Two things stand out.

**The root config is empty.** `prepareProfile` writes the literal string `[]` on every boot. The entire plugin graph arrives as *patches* over nothing.

**A profile is not a file.** `PROFILE_TEMPLATES.web` names two bundles:

```ts
web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' }
```
— `packages/boot/app-boot/src/profile.ts:137-142`

and the patch stack is assembled in a fixed order (`profile-boot.ts:136-143`):

1. each bundle's `cordis.patch.yml`, in `bundles` order;
2. the profile's own `cordis.patch.yml` (empty by default, user-editable, hot-reloaded);
3. `$DSH_HOME/cordis.patch.yml` (machine-wide);
4. `--patch` overlays.

**No file in the repository lists the web profile's composition.** It exists only as the result of applying that stack.

## 3. The patch algebra

`applyEntryPatches` (`vendor/include/src/index.ts:58-128`) over an entry array:

| Patch shape | Effect |
|---|---|
| `{ insert: [...] }` with no `id` | append rows to the top level (`:94`) |
| `{ insert: [...] }` with an `id` | append into that id's group `config` array (`:91-92`) |
| `{ id, ...overrides }` | copy each override key onto the matching row (`:121-124`) |

The third is the one with consequences:

```ts
for (const [key, value] of Object.entries(overrides)) target[key] = value
```

**`config` is replaced wholesale, not merged.** A later layer restating `config:` discards every key the earlier layer set. Both bundle files say so in their headers, and the code confirms it. This is why the standard preset restates `thresholdChars`, `headChars`, and `tailChars` identically rather than relying on the base's values ([Ch 27](27-pruning-and-compaction.md)).

Inserted rows are indexed **immediately** (`:101`), so a later patch in the same list can target a row an earlier `insert` just added — a documented local modification to the vendored code.

**Row order is not load order.** Rows appear in array order, but a fiber activates only when its `inject` dependencies resolve, and `EntryGroup.update` creates every row concurrently (`vendor/loader/src/config/group.ts:71`). Startup sequencing is a dependency graph, not a list.

## 4. `!!js`

Config that depends on runtime facts is written as a tagged scalar:

```yaml
disabled: !!js process.platform === 'win32'
mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
root: !!js dshHomePath('sessions')
```

The dialect is defined once:

```ts
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  ...
})
export const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)
```
— `vendor/include/src/index.ts:9-23`

**Why `!!js` and never `!js`.** `!!foo` is YAML's shorthand for the resolved tag `tag:yaml.org,2002:foo`; a single `!foo` is an *application-local* tag that never resolves to that URI. A single-bang `!js` would not match this `Type` at all. The repo's rule is mechanical, not stylistic.

A parsed expression becomes `{ __jsExpr: "<source>" }` — inert data until something evaluates it.

**Evaluation is lazy and per row.** The Loader's `internal/config` listener interpolates each entry's config (`vendor/loader/src/index.ts:92-101`) — but **skips tree-carrier plugins** (`Include`, `Group`, marked by `static readonly [EntryGroup.key] = true`, `include:182`), whose config is entry and patch lists that must stay literal.

So an expression referencing a service is resolved only after that row's declared injections are active. That is what lets the web bundle write:

```yaml
- id: webserver
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
```

`disabled` gets the same treatment separately (`Entry.disabledOf`, `vendor/loader/src/config/entry.ts:100-108`), which is how platform gating works.

The evaluator itself is four lines:

```js
export const evaluate = new Function('ctx', 'expr', `
  with (ctx) {
    ...
```
— `vendor/loader/src/config/utils.ts:5-6`

A `Function` constructor wrapping a `with (ctx)` block. So an expression's free identifiers resolve against the row's own context — which is exactly why `ctx.webStartup.host` works in a row that injects `webStartup`, and why an identifier the scope cannot resolve throws rather than silently yielding `undefined`.

It also means **`!!js` is arbitrary code execution at config-load time**. That is a deliberate property of a composition format meant to be edited by the deployment operator, and it puts `cordis.patch.yml` in the same trust class as the code it composes — the same reasoning the preset system applies to `$DSH_HOME/.agent-presets`, which "carries the same trust as shell access because a preset IS a composition."

## 5. Isolate realms

The first of two isolation mechanisms, and it is pure Cordis.

Normally a service registers under a process-wide symbol: `provide()` looks up `ctx.root[symbols.isolate][name] ??= Symbol(name)`, then stores the implementation at `this.store[ctx[symbols.isolate][name]]` (`vendor/cordis/src/reflect.ts:286-287`). Every reader resolves the same symbol, so the service is global.

An `isolate:` declaration changes which symbol that row's context maps a name to. The `isolate` Loader plugin (`vendor/loader/src/config/isolate.ts`) builds a new map for the declared names and **replaces the entry context's own isolate map** via `Object.setPrototypeOf` + swap (`:123-126`) before reloading the fiber.

Two realm kinds:

| Declaration | Realm | Suffix |
|---|---|---|
| `isolate: { compaction: true }` | `LocalRealm` — this entry's private instance | `'#' + entry.options.id` |
| `isolate: { compaction: 'shared-label' }` | `GlobalRealm` — shared by every entry naming that label | `'@' + label` |

A shared label does **not** pool instances: `provide()` throws on a second registration under the same realm symbol. Labels *join* realms — they let several entries agree to resolve one instance.

**The key property, stated precisely:** a service published with no `isolate:` is visible process-wide because its context inherits the root's symbol table unchanged. **Visibility is the default; a realm is an opt-in narrowing, never a widening.**

That is exactly why the standard preset's comments read as they do:

- "Both register into the host `tools` registry and provide nothing, so they need no realm" — a row that *publishes* nothing cannot collide.
- `compaction-basic` and `tool-result-pruner` share one realm because the former reads the latter via `ctx.get`.
- `plan-mode` gets its own realm because "plan state is per-agent by nature — an entry-local realm is not a workaround here, it is the correct lifetime."

And `mountPreset` **enforces** it: `leakedServices()` (`mount.ts:210-224`) walks the reflect store and flags any implementation whose isolate key equals the root's symbol for that name — a row that forgot its realm. A misconfigured preset fails session creation loudly rather than silently sharing one agent's service with every other.

## 6. Scope parentage — the second mechanism

Completely separate, and application-level. `packages/core/scope` is built from ordinary `ctx.extend()`, a private `WeakMap`, and Cordis's listener-filter hook. It touches `Context.isolate` not at all.

It provides two things:

**Event routing.** `scopeTarget()` (`scope/src/index.ts:170-185`) builds the dispatch filter: a listener registered under scope `T` receives events dispatched to scope `K` iff `T` is `K` or one of `K`'s ancestors ([Ch 22](22-extension-points.md)).

**Registry layering.** `ScopedLayers` (`store.ts:159-267`) holds a global layer plus one per scope key. `merge()` composes `global` + `chainLayers(scope)` — farthest ancestor first, nearest last so it wins name collisions (`:192-217`). This is what makes a preset's prompt sections and tools per-agent ([Ch 19](19-prompt-assembly.md), [Ch 15](15-the-tool-registry.md)).

One relation, `scopeParents`, with two consumers: event delivery and registry layering.

## 7. Agent presets

Now the pieces combine.

The web bundle mounts the roster:

```yaml
- id: agent-presets
  name: '@deepseek-ai/dsh-agent-presets'
  config:
    default: standard
```
— `packages/bundle/web-app/cordis.patch.yml:451-456`

and disables ~24 agent-plane rows, moving them behind presets.

### Mounting, verified

The preset file's own comment claims it is "mounted once per process under a standing scope; every session naming it joins by scope parentage." The code says something **more precise**.

`ensureStanding(preset)` (`packages/preset/agent-presets/src/index.ts:747-795`) keys a `Map<string, Promise<StandingMount>>` by preset id:

1. A cached promise is **reused** — the "once" guarantee, implemented as an in-memory single-flight cache, not a Cordis-level singleton.
2. It also checks the composition **file's mtime/size stamp** on every call (`compositionStamp`, `:806-816`). If the file changed, the cached entry is evicted and a **new generation** created (`:767`). Sessions already joined keep running on their original generation's plugin instances (`:759-763`).
3. On a miss: mint a `ScopeKey` (a fresh plain object used purely for identity), `createScope(this.selfCtx, key)`, then `await mountPreset(scope.ctx, preset)`.

So the accurate statement is **"once per (preset id, on-disk file generation), single-flighted and created lazily on first use."** A live-edited preset forks a generation for new sessions.

`mountPreset` (`mount.ts:378-433`) does `agentCtx.plugin(PresetTree, config)` where `PresetTree extends Include` — the preset's entry tree plugged directly as one Cordis plugin, not routed through a Loader entry. It then verifies **every row reached a usable state** (`inactiveRows`, `:304-322`) and **no row leaked a service** (`leakedServices`, §5) before recording the mount.

### Joining

`AgentPresets.mount(agentCtx, id?)` (`:414-427`) is called from the agent factory's `setup` hook ([Ch 14](14-agent-lifecycle.md)) — the module names it "the one supported call site." It resolves the standing mount, then:

```ts
this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))
```
— `:425`

`bindScopeParent` (`scope/src/index.ts:72-82`) writes **one `WeakMap` entry** from the agent's scope key to the standing mount's, with a cycle check.

**No new fiber. No new plugin instance. No module re-import.** The second, third, and hundredth agent on a preset each cost one `WeakMap` entry. And because that same parent link drives both event routing and `ScopedLayers`, the agent immediately sees the preset's tools, prompt sections, and scoped services.

### The deliberate backdoor

Host code sometimes must read *inside* a specific agent's realm-private service — a browser RPC about a session. `serviceForAgent` (`mount.ts:259-293`) does it by walking the reflect store's own symbols and testing **fiber-tree membership** (`withinFiber`, `:189-197`) rather than using the isolate map at all.

It deliberately bypasses the invisibility realms enforce, by using a different addressing scheme than dependents use. Worth knowing that the escape hatch exists and is narrow.

### `preset.yml`

Display metadata only — three lines of name, description, and sort order. Discovery treats unreadable metadata as non-fatal: "a preset with unreadable metadata still mounts, it just shows its id" (`discovery.ts:309-310`).

## 8. Reading a composition correctly

The practical procedure this book has used throughout:

1. **Start at `packages/bundle/base/cordis.patch.yml`** — what exists at all.
2. **Apply `packages/bundle/web-app/cordis.patch.yml`** — `disabled: true` rows, and note that any `config:` replaces the base's wholesale.
3. **Check the preset** — `presets/standard/agent.cordis.yml` re-mounts most of what layer 2 disabled, sometimes with *different* config.
4. **Check for `!!js`** — the value may depend on the platform or environment.
5. **Check `openAt`-style dormancy** — a mounted row can still do nothing (`session-query-sqlite`, `llm-pi-ai`).

Skipping step 3 produces confident wrong answers: compaction, subagents, skills, plan mode, and most tools all look disabled after step 2.

## 9. The vendored framework

`vendor/cordis` is `cordis` **4.0.0-rc.7** from `cordiverse/cordis` at commit `56b3d4f7…`; the companions (`include`, `group`, `timer`, `hmr`, `logger-console`) come from a **fork**, `deepseek-harness/cordis`, at a different commit. `vendor/README.md` lists 19 local modifications.

Spot-checking those against the source (rather than trusting the changelog) confirmed four: fiber lifecycle hardening, `applyEntryPatches`' export and insert-then-index behavior, lazy `!!js` resolution with the tree-carrier exemption, and `disabled: !!js` interpolation.

**All 19 were subsequently verified** by cloning `cordiverse/cordis` at the pinned commit `56b3d4f7…` and diffing. The result is worth stating plainly: **the log is accurate — no contradictions, no omissions found.**

Thirteen were checked against the exact pinned baseline:

| Item | Verification |
|---|---|
| 2, 3 | `package.json` gains `private`, precise `files`, `lib/types/**` declarations; `tsconfig` extends `../../tsconfig.base.json` rather than upstream's own base |
| 4 | `'./events'` → `'./events.ts'` throughout |
| 5 | Both `tsdown.config.ts` files exist here and **nowhere** upstream — "ours, not upstream files" is exactly right |
| 6 | Effect wrapper registered before setup (`fiber.ts:520` before `:522`); `update()` returns its waterfall result |
| **7** | **"Comment-only; no code changes" — confirmed.** Stripping comments from `service.ts`, `index.ts`, `context.ts`, `reflect.ts`, `registry.ts`, `logger.ts`, and `utils.ts` leaves **zero functional differences**; every residual is either an import rewrite items 4/10/17 already declare, or whitespace from the repo's own linter (`{}` → `{ }`, `;(` → `; (`) |
| 10 | `import { Dict }` → `import type { Dict }`; `InjectKey` → `type InjectKey` |
| 11 | `applyEntryPatches` exported; inserted rows indexed inside the patch loop |
| 15 | Lazy `internal/config` resolution; `Include` carries the tree-carrier marker |
| 16 | Upstream `files: ["lib", "bin.js"]`; vendored adds `"src"` |
| 17 | `cordis` → `@deepseek-ai/cordis`, `cosmokit` → `@deepseek-ai/cosmokit` |
| 18 | `disabledOf()` interpolates a `!!js` node |
| **19** | Upstream branches on `major >= 24`; vendored probes for `getOrCreateModuleJob` / `getModuleJobForImport`. A genuine bug fix — the v2 interface landed in 24.12.0, so Node 24.0–24.11.1 are mistagged by a major-version test |

Five more (items 1, 9, 12, 13, 14) target packages sourced from `deepseek-harness/cordis`, which is **not public** — so they were checked for *presence of the described change* rather than diffed against their own baseline. All five are present and match their descriptions: the hmr locales directory and its `.i18n()` call are gone (with an inline marker comment left behind), `registerConfig` exists, the main watcher takes `ignoreInitial: true` while `registerConfig`'s own takes `false`, `writeTask` is widened to `| undefined`, and the `EACCES`/`EBUSY`/`EPERM` retry is there.

Item 8's loader half shows real divergence in exactly the named files (`loader/src/index.ts` 166 → 202 lines, `config/group.ts` 88 → 129); its `include`/`group` half shares item 1's baseline limitation.

> ⚠️ **One caveat on attribution.** For the five fork-sourced items, "present here and absent from `cordiverse`" cannot distinguish a change the harness made from one the fork made. The changelog attributes them to local modification; nothing contradicts that, but it is not independently separable without access to the fork.

## 10. Key takeaways

- A profile is an empty root config plus an ordered patch stack; no file lists the composition.
- A patch **replaces** a row's whole `config` rather than merging.
- Row order is cosmetic; activation is dependency-driven and concurrent.
- `!!js` is a tagged scalar evaluated lazily per row, after that row's injections resolve — `!js` would not match at all.
- Isolate realms remap which symbol a name resolves to; visibility is the default and a realm is a narrowing.
- `dsh-scope` is a separate, application-level mechanism: one `WeakMap` parent link driving both event routing and registry layering.
- A preset is mounted once per (id, file generation) and joined by writing one `WeakMap` entry per agent.

## Exercises

1. A deployment wants `maxParallelToolCalls: 4`. Write the patch, say which layer it belongs in, and explain what happens if it is placed in a layer the standard preset later restates.
2. A new per-agent plugin publishes `ctx.myService`. Where does it go, and what does `mountPreset` do if you forget the realm?
3. `serviceForAgent` bypasses realm invisibility using fiber membership. Name one legitimate use and one way it could be abused.

**Next:** [Chapter 35 · Limits and fragile areas](35-limits-and-fragile-areas.md)
