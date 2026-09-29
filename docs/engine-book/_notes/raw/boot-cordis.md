# Raw notes: boot path and Cordis composition (Lynx Harness)

Scope: `apps/server/**`, `packages/boot/**`, `packages/bundle/**`, `packages/preset/agent-presets/**`,
every `cordis.yml`/`cordis.patch.yml` in the repo, and the vendored Cordis framework in `vendor/**`.

Citation format: `path/file.ts:LINE → functionName()`. All line numbers are from the files as read
during this research pass (2026-09-21); re-check before quoting verbatim in the book if the repo has
moved on.

---

## 1. Actual boot path, process entry to `AgentLoop` construction

Ordered call chain, each hop grounded in the file that makes the call:

1. **Process entry** — `apps/server/src/index.ts:1-20`. Reads `package.json` for the version, calls
   `parseServerArgs(process.argv.slice(2), manifest.version)` (`apps/server/src/index.ts:7`), then
   either `runDumpConfig()` or `runProfile()`.
   - `apps/server/src/index.ts:16` hardcodes `profile: 'web'` in the `runProfile()` call — the profile
     name is a source-code literal, not something argv chooses.

2. **Argument parsing / `--profile` rejection** — `apps/server/src/args.ts:22-47 → parseServerArgs()`.
   Line 33-35:
   ```ts
   if (argv.some(arg => arg === '--profile' || arg.startsWith('--profile='))) {
     program.error('error: this application serves the Web GUI only; --profile is not supported')
   }
   ```
   Commander's `program.error()` prints and calls `process.exit(1)` (verified by contract of
   `commander`; not re-read here — INFERRED behavior of the library, not verified in vendor since
   commander is an ordinary npm dependency, not vendored). This is the concrete code backing the
   AGENTS.md claim "`--profile` is rejected". CONFIRMED.

3. **`runProfile()`** — `apps/server/src/profile-boot.ts:208-306 → runProfile()`.
   - `profile-boot.ts:209 → composeProfile('web', patchFiles)` resolves and composes the patch stack.
   - `composeProfile()` (`profile-boot.ts:156-173`) calls `prepareProfile(name)` (line 160), which calls
     `loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer })` from
     `packages/boot/app-boot/src/profile.ts:781-820 → loadProfile()`, then
     `writeFileSync(profile.dir/cordis.yml, PROFILE_ROOT_CONFIG)` where `PROFILE_ROOT_CONFIG` is the
     **literal string `"[]"`** (`profile-boot.ts:80-84`). So the on-disk `cordis.yml` the Loader
     ultimately mounts is an **empty entry list**; the entire plugin set is injected as *patches* over
     it (see §5).
   - `composeProfile()` then calls `healProfilesModuleFallback()` (module-resolution healing, not
     plugin composition) and assembles `bundlePatches` from `profile.layers` (each layer's
     `cordis.patch.yml` content, parsed by `loadOverlayPatches`).
   - `runProfile()` line 250: `const ctx = await boot(NAME, rootConfig, structuredClone(allPatches(composed)), (hostCtx) => {...})`
     — calls into `packages/boot/app-boot/src/index.ts:772-819 → boot()`.

4. **`boot()`** — `packages/boot/app-boot/src/index.ts:772-819`.
   - Line 779: `const ctx = new Context()` — creates the Cordis root context (see §3).
   - Line 786: `await ctx.plugin(Loader)` — mounts the vendored Loader service
     (`vendor/loader/src/index.ts`) as a Cordis plugin on the root context.
   - Line 787: `await prepare?.(ctx)` — runs the `runProfile()` callback that does
     `hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, ...)` and `provideCmdline(hostCtx, ...)`
     (`profile-boot.ts:250-262`).
   - Line 789: `await mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl)` →
     `packages/boot/app-boot/src/index.ts:501-544 → mountRootInclude()`.
   - Line 797-799: awaits `ctx.get('loader')?.await()` then `assertEntriesActivated(ctx, binName)`
     (`app-boot/src/index.ts:707-740`), which throws if any enabled Loader entry never reached
     `FiberState.ACTIVE`.

5. **`mountRootInclude()`** — `app-boot/src/index.ts:501-544`.
   - Registers the vendored `Include` class (`vendor/include/src/index.ts`) as the `cordis:include`
     loader builtin (line 507-519) and `Group` as `cordis:group` (line 525).
   - Line 533-538: constructs one root Loader entry `{ id: 'include', name: 'cordis:include', config: { path: <cordis.yml file:// URL>, patches: [...structuredClone(allPatches)] } }` and calls
     `ctx.loader.create(rootInclude)` — this is a `Loader`/`EntryTree.create()` call
     (`vendor/loader/src/config/tree.ts:97-104 → create()`), which resolves the root `EntryGroup` and
     calls `group.create(options)` (`vendor/loader/src/config/group.ts:20-40 → create()`), which
     constructs an `Entry` (`vendor/loader/src/config/entry.ts:52-303`) and calls `entry.update(options, true, true)`.

6. **`Entry.update()` → `Entry._start()`** — `vendor/loader/src/config/entry.ts:142-303`.
   For the fresh `include` entry this resolves to `_init()` (line 277-289) → imports the `cordis:include`
   builtin (the vendored `Include` class) → `_start(plugin)` (line 291-302) → line 296:
   `fiber = this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack)`.
   This is `RegistryService.plugin()` (`vendor/cordis/src/registry.ts:316-336`), which constructs a
   `Fiber` (`vendor/cordis/src/fiber.ts:222-333`) — the concrete Cordis plugin-instantiation call for
   the `Include` (root config-file) plugin.

7. **`Include` constructor and `[Service.init]`** — `vendor/include/src/index.ts:194-289`.
   - Constructor (line 194-214) resolves `this.filename` from `config.path` and `ctx.baseUrl`
     (line 197), rewrites `ctx.baseUrl` to the file's directory (line 204), and registers an
     `internal/update` listener for live patch-list reapplication (line 206-213).
   - `async*[Service.init]()` (line 273-289) reads the file (`this.read(true)`), and if it does not
     exist (`ENOENT`) writes `config.initial` first — not the path taken for the `web` profile, since
     `prepareProfile()` always writes `cordis.yml` before boot (§1 step 3). Then `await this.apply(candidate)`
     (line 288) → `_apply()` (line 315-321) → `data = this.applyPatches(candidate.data, this.config.patches)`
     (calls the exported pure function `applyEntryPatches`, `vendor/include/src/index.ts:58-128`) →
     `await this.root.update(data)` — this is `EntryGroup.update()` (`vendor/loader/src/config/group.ts:59-106`),
     which calls `this.create(options)` (→ `Entry` construction, §6) **concurrently for every row** via
     `Promise.allSettled(config.map(options => this.create(options)))` (`group.ts:71`).

8. **Individual entry activation, e.g. `agent-loop`** — one of the rows the applied patch list
   inserts (see §2/§5) is `{ id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } }`
   (`packages/bundle/base/cordis.patch.yml:486-489`). Its `EntryGroup.create()` → `Entry.update()` →
   `Entry._init()` → `Entry._start()` path is identical to step 6, but importing the
   `@deepseek-ai/dsh-agent-loop` package instead of the `cordis:include` builtin. The imported plugin is
   the default export of `packages/core/agent-loop/src/index.ts:776 → export default AgentLoop`, a
   `Service` subclass (`class AgentLoop extends Service implements AgentFactory`,
   `packages/core/agent-loop/src/index.ts:352`). Because `RegistryService.plugin()`
   (`vendor/cordis/src/registry.ts:330`) detects a class via `isConstructor(runtime.callback)`
   (`vendor/cordis/src/fiber.ts:251-257`), the fiber's `execute()` does
   `new runtime.callback(this.ctx, this.config)` — i.e. Cordis literally does `new AgentLoop(ctx, config)`
   once the fiber's dependencies (`static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']`,
   `agent-loop/src/index.ts:353`) are all present (see §4). The `AgentLoop` constructor
   (`agent-loop/src/index.ts:376-445`) is therefore the concrete point "the agent-loop plugin is
   constructed."

**Summary chain** (file:function → file:function):
`apps/server/src/index.ts` (top-level) → `apps/server/src/args.ts:22 parseServerArgs()` →
`apps/server/src/profile-boot.ts:208 runProfile()` → `profile-boot.ts:156 composeProfile()` +
`packages/boot/app-boot/src/profile.ts:781 loadProfile()` → `profile-boot.ts:250` calls
`packages/boot/app-boot/src/index.ts:772 boot()` → `boot()` line 786 `ctx.plugin(Loader)` (vendor) →
`boot()` line 789 → `app-boot/src/index.ts:501 mountRootInclude()` → `ctx.loader.create()` →
`vendor/loader/src/config/tree.ts:97 create()` → `vendor/loader/src/config/group.ts:20 create()` →
`vendor/loader/src/config/entry.ts:277 _init()` → `entry.ts:291 _start()` →
`vendor/cordis/src/registry.ts:316 plugin()` → `vendor/cordis/src/fiber.ts:222 constructor` (executes
`Include`'s `[Service.init]`) → `vendor/include/src/index.ts:288 apply()` → `_apply()` (line 315) →
`applyEntryPatches()` (line 58) → `EntryGroup.update()` (`group.ts:59`) → per-row `create()` →
`Entry._start()` (`entry.ts:291`) → `RegistryService.plugin()` (`registry.ts:316`) →
`new Fiber(...)` → for the `agent-loop` row, `new AgentLoop(ctx, config)`
(`packages/core/agent-loop/src/index.ts:376`).

---

## 2. The `web` profile

**Definition**: `packages/boot/app-boot/src/profile.ts:137-142`:
```ts
export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  web: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    patchReload: 'live',
  },
}
```
This is the **only** place the string `'web'` names a profile template in `packages/boot`. `apps/server/src/index.ts:16`
hardcodes `profile: 'web'` as the value passed to `runProfile()`.

**What "profile" means mechanically**: a profile is *not* a checked-in `cordis.yml` tree. It is:
- an on-disk directory `$DSH_HOME/profiles/web/` holding a `package.json` with a `dsh.profile.bundles`
  array and a user `cordis.patch.yml` (auto-created by `initProfile()`,
  `packages/boot/app-boot/src/profile.ts:176-196`, from the `PROFILE_TEMPLATES.web` template on first
  run via `loadProfile()` line 786-793);
- a literal **empty root config** `cordis.yml` = `[]`, rewritten on every boot
  (`profile-boot.ts:80-84,118-122 → prepareProfile()`);
- a **stack of patch layers** applied over that empty root, in this fixed order
  (`profile-boot.ts:136-143 → allPatches()`):
  1. `bundlePatches` — each bundle's `cordis.patch.yml`, concatenated in `dsh.profile.bundles` order:
     first `packages/bundle/base/cordis.patch.yml` (Layer 1), then
     `packages/bundle/web-app/cordis.patch.yml` (Layer 2);
  2. `profile.patches` — the profile's own `cordis.patch.yml` (empty `[]` by default, user-editable,
     hot-reloaded because `patchReload: 'live'`);
  3. `homePatches` — `$DSH_HOME/cordis.patch.yml` (machine-wide user overrides, also live-reloaded);
  4. `overlays` — any `--patch <file>` CLI overlays, plus a synthesized telemetry-disable patch if
     `DSH_TELEMETRY_DISABLED` is set (`profile-boot.ts:100-103, 170-171`).

**Patch semantics** (verified in `vendor/include/src/index.ts:58-128 → applyEntryPatches()`): a patch
list is applied over the (initially empty) entry array. An `insert` patch with no `id` **appends** rows
to the top-level array (`entry.ts... `data.push(...insert)`, `include/src/index.ts:94`); an `insert`
with an `id` appends into that id's group's `config` array (line 91-92); a non-insert patch with an `id`
**replaces individual keys** on the matching row via `Object.assign`-like key copy (line 121-124) — so
`config:` in a later layer's patch **replaces the whole `config` object** of the targeted row, not a
deep merge (confirmed by the loop `for (const [key, value] of Object.entries(overrides)) target[key] = value`,
which sets `target.config = <new config>` wholesale when `config` is one of the override keys). This
matches the comment header of both bundle patch files ("A patch replaces the targeted row's whole
`config`... rather than merging into it").

**Order of plugins mounted**: because `applyEntryPatches` processes patches **in list order** and each
`insert` indexes its own new rows immediately (`include/src/index.ts:101 buildMap(insert)` — a
documented local modification, see §7 item 11), a bundle's own `insert` block establishes an ordered
list, and a later layer's `insert`/id-patches can extend or override any earlier row by `id`. Concretely
for `web`:
- `packages/bundle/base/cordis.patch.yml:15-502` is **one single `insert:` block** (no `id`) containing
  ~90 ordered rows (timer, hmr, llm, session, ..., `tools`, `system-prompt`, `agent-loop`, `fs-sandbox`,
  `llm-deepseek` — the last five rows are explicitly commented "rows every mode mounts", lines 470-502).
- `packages/bundle/web-app/cordis.patch.yml` (Layer 2) **does not re-insert** most base rows; it
  patches several by `id` (`system-prompt`, `session-query-sqlite`, `tools`, `llm-deepseek: disabled: true`
  lines 16-42), then has its own large `insert:` block (lines 48-451) adding the web-only host/transport
  rows (`webserver`, `web-runtime`, `client-hmr`, the `ui-*` browser roster) and **disables** roughly 20
  base rows that move "behind agent presets" (`tool-bash`, `tool-pwsh`, `tool-jobs`, `tool-fs`,
  `tool-fs-search`, `tool-str-replace-editor`, `skill-filesystem`, `tool-skill`, `command-goal`,
  `tool-goal`, `plan-mode`, `compaction-basic`, `command-compact`, `tool-result-pruner`,
  `tool-subagent-control`, `tool-subagent-list-agents`, `tool-subagent`, `tool-subagent-fork`,
  `workflow-worker-thread`, `tool-workflow`, `tool-ralph`, `agent-instructions`, `tool-todo`, `tool-web`
  — `packages/bundle/web-app/cordis.patch.yml:330-442`), then finally inserts the `agent-presets` roster
  row (lines 451-456).
- Row *order* in the composed entry array is therefore: all base rows (base insertion order, with the
  disabled-in-web-app ones flagged `disabled: true` in place, not removed) followed by the web-app
  insert block's rows appended at the end. **Activation order is not the same as array order** — Cordis
  activates a fiber only once its `inject` dependencies resolve (§4), so mount order in the file is
  cosmetic; dependency graph order is what actually governs startup sequencing.

**No literal "`web` `cordis.yml`" file exists** naming this composition — the profile's tree is entirely
synthesized from patch layers over an empty array written at boot time. The various checked-in
`apps/server/config/examples/*/cordis.yml` files (e.g. `apps/server/config/examples/cordis/cordis.yml`)
are `--patch` overlay files demonstrating additional inserts (confirmed by their own header comments,
e.g. "This file is a PATCH OVERLAY over the web profile ... not a tree"), not profile definitions.

**`--profile` rejection**: confirmed in §1 step 2. `apps/server/src/args.ts:33-35`.

---

## 3. Cordis core model (read from `vendor/cordis/src/*.ts`)

### `Context`
`vendor/cordis/src/context.ts:42-146`. A `Context` instance is **immediately wrapped in a `Proxy`**
(`constructor`, line 74: `const self = new Proxy<this>(this, ReflectService.handler)`), and `this.root = self`
— so every context object handed to plugin code is a proxy, not the raw class instance. The proxy's
`get`/`set`/`has` traps are `ReflectService.handler` (`vendor/cordis/src/reflect.ts:135-206`): a property
read for a name not already an own/inherited property is treated as a **service lookup** — it walks
`ctx.fiber` → `ctx.fiber.parent.fiber` → ... looking for a store entry for that name, throwing
`"cannot get property ... without inject"` if none is found and none of the ancestor fibers' isolate
label matches (`reflect.ts:152-166`).

A `Context` owns: `events` (`EventsService`), `logger` (`LoggerService`), `reflect` (`ReflectService`),
`registry` (`RegistryService`), and (declared via module augmentation in `fiber.ts:9-14`) `fiber`
(`Fiber`). `Context.extend(meta)` (`context.ts:99-107`) creates a **child context via
`Object.create(getTraceable(this, this))`** carrying extra own properties from `meta` — this is the
primitive every nested context (fiber contexts, `Include`/`Group` subtrees, `dsh-scope`'s `createScope`)
is built from. `Context.isolate(name, label?)` (`context.ts:121-125`) and `Context.intercept(name, config)`
(`context.ts:139-145`) are both implemented as `extend()` calls that shadow the `[symbols.isolate]` /
`[symbols.intercept]` own property with a new object whose prototype is the parent's map — i.e.
isolation and intercept config are **inherited, shadowable dictionaries**, not global mutable state.

### `Service`
`vendor/cordis/src/service.ts:11-115`. Abstract base class; `constructor(ctx, name)`
(line 42-59) immediately calls `self.ctx.reflect.provide(name, self, this[symbols.check])` (line 57) —
**construction *is* registration**: a `Service` subclass is "live" (registered under `ctx[name]`,
visible to dependents) the instant its constructor body finishes running `super(ctx, name)`, before any
subclass-specific constructor code after the `super()` call executes for OTHER instances, but the
provided value is only resolvable by dependents once the *providing fiber* is `ACTIVE` (strict lookups
check `impl.fiber.state !== FiberState.ACTIVE`, `reflect.ts:241`). `Service.check` /
`[symbols.check]` is an optional availability predicate consulted before a dependent may treat the
service as present (used e.g. by `Loader`'s own `[Service.check]()`, `vendor/loader/src/index.ts:166-170`,
to keep dependents pending while `config: { await: true }` and Loader tasks remain outstanding).

### `Fiber`
`vendor/cordis/src/fiber.ts:184-754`. One `Fiber` = one running instance of one plugin application
(`ctx.plugin()` call). Key fields: `uid` (registry-unique id; `null` once disposed, `0` for the root),
`ctx` (the child context the plugin body runs in, from `parent.extend({ fiber: this })`, line 236),
`config`/`_config` (validated / raw), `state` (`FiberState`), `inject` (the resolved dependency map),
`store` (a snapshot `Dict<Impl>` of currently-satisfied injected services, only defined while
`ACTIVE`/mid-transition), `_disposables` (the effect-cleanup stack).

`FiberState` (`vendor/cordis/src/fiber.ts:147-154`, a `const enum`):
```ts
export const enum FiberState {
  PENDING,    // 0 — waiting for required services
  LOADING,    // 1 — the plugin callback is running
  ACTIVE,     // 2 — loaded and providing
  FAILED,     // 3 — the callback or its config threw
  DISPOSED,   // 4 — removed, cannot restart
  UNLOADING,  // 5 — disposers are running
}
```
(App code mirrors these as runtime values because the enum has no emitted object — see
`packages/boot/app-boot/src/index.ts:686-688`: `FIBER_PENDING = 0`, `FIBER_ACTIVE = 2`, `FIBER_FAILED = 3`,
with a comment cross-referencing `packages/extensions/tool-cordis/src/fiber-state.ts` and
`packages/client/web/src/loader-status.ts` for parallel constants that must stay aligned by hand.)

State transitions are driven by `_setEpoch()` (`fiber.ts:625-639`): a fiber's `_runner.epoch` becomes
the sentinel `INACTIVE` when any injected service is missing (`_refresh()`, line 611-623 — computed by
walking `Object.keys(this.inject)` and checking `this._store[name]`); going from `INACTIVE` to a real
epoch value triggers `_reload()` (→ `LOADING` then `ACTIVE`/`FAILED`), and the reverse triggers
`_unload()` (→ `UNLOADING` then back to `PENDING`, or immediately `_reload()` again if a new epoch is
already ready — line 688-695).

`ctx.fiber.assertActive()` (`fiber.ts:346-354`) is the one-line guard used throughout the codebase
(e.g. `agent-loop/src/index.ts:524, 756`) to fail fast (`CordisError('INACTIVE_EFFECT')`) if the fiber's
`uid` has already been cleared by disposal — i.e. "is this context still alive enough to register more
effects/services on."

### `ctx.effect(fn, label)`
See §8 (dedicated question) — implemented at `vendor/cordis/src/fiber.ts:402-561`.

### `ctx.inject(deps, callback)`
Declared in `vendor/cordis/src/registry.ts:164-187` (interface augmentation) and implemented as
`RegistryService.inject()` (`registry.ts:294-302`): **`ctx.inject(inject, callback)` is sugar for
`ctx.plugin({ inject, apply: callback, name: callback.name })`** — it is not a separate mechanism, it
is `ctx.plugin()` with an object-literal plugin whose only distinguishing feature is the `inject` map.
The returned value is a `Fiber` wrapped so it is also a thenable (`registry.ts:331-335`), letting callers
`await ctx.inject(...)` to know when the callback ran (or rejected). `agent-loop/src/index.ts:393` uses
exactly this form: `ctx.inject(['settings'], (settingsCtx) => { ... })` — the callback runs (and re-runs
on `settings` service churn) only while `settings` is resolvable.

### `ctx.provide(name, value)`
Declared `vendor/cordis/src/reflect.ts:44-46`, implemented `ReflectService.provide()`
(`reflect.ts:277-305`). Wraps the whole registration in `this.ctx.fiber.effect(...)` (line 278) — so
`provide()` **is** an effect: it throws `service "..." has been registered at <fiber>` if the isolate-
scoped symbol slot is already occupied (line 289-291), stores the `Impl` record keyed by a
per-isolate-label `Symbol`, and its own effect-teardown (returned closure, line 297-303) deletes the
store slot and **awaits every dependent fiber's re-settlement** (`await Promise.allSettled(fibers.map(fiber => fiber.await()))`,
line 300) before finishing — i.e. un-providing a service is a synchronization point, not fire-and-forget.

### `ctx.get(name, strict?)`
`reflect.ts:233-243 → ReflectService.get()/`_getImpl()`. Bypasses the `inject` requirement entirely:
looks up the isolate-scoped symbol and returns `impl.value` (traced), or `undefined` if absent or (when
`strict` — the default `true`) if the providing fiber is not currently `ACTIVE`. This is the mechanism
behind every `ctx.get('foo')` call seen throughout the harness for **optional** dependencies (e.g.
`agent-loop/src/index.ts:422 ctx.get('sessionPersistence')`, `717`), contrasted with `static inject`
which makes a service **mandatory** for the whole fiber's activation (§4).

### `ctx.extend(meta)`
Covered above under `Context`. Also worth noting: `Context.extend()` explicitly re-attaches a
"shadow" own property if present (`context.ts:100,105-106`) — `getTraceable`/shadow machinery
(`vendor/cordis/src/utils.ts`, not fully read in this pass — UNKNOWN in depth) is what lets a
context minted from inside a `Service` method (e.g. `AgentPresets`'s `selfCtx`,
`packages/preset/agent-presets/src/index.ts:159-165`) still resolve services through the *caller's*
effective fiber rather than the service's own declaring fiber; the `AgentPresets` comment explicitly
calls out that its own traced `this.ctx` would break standing-mount composition for exactly this reason,
which is corroborating (not independently verified against `utils.ts`) evidence that `extend()`/tracing
interacts with which fiber a proxied context ultimately reads from.

---

## 4. `static inject` and dependency resolution/ordering

`static inject = [...]` (as on `AgentLoop`, `agent-loop/src/index.ts:353`) is read by
`RegistryService.plugin()` via `Inject.resolve(plugin.inject)` (`vendor/cordis/src/registry.ts:330`,
using the `Inject` namespace's `resolve()` at `registry.ts:71-89`), which normalizes the array (or
object-with-per-service-config) form into a plain `Dict` of `serviceName -> interceptConfigOrNull`. That
map becomes `Fiber.inject` (constructor param, `fiber.ts:225`).

**Resolution/ordering mechanics** (`fiber.ts`):
- On construction, for each `name` in `inject`, `this._checkImpl(name)` is called (`fiber.ts:315-317`,
  guarded to skip only during a reentrant parent-unload race) — this looks up
  `ctx.reflect._getImpl(name, true)` (strict: providing fiber must be `ACTIVE`) and stores it in
  `this._store[name]` if found and passing its optional `check()` (`fiber.ts:597-609`).
- `this._refresh()` (`fiber.ts:611-623`) then computes a synthetic `epoch` string by concatenating each
  injected service's providing-fiber `uid` (`epoch += ':' + impl.fiber.uid`); if **any** injected name
  has no `_store` entry, `epoch` becomes the `INACTIVE` sentinel instead. `_setEpoch(epoch)`
  (`fiber.ts:625-639`) compares this to the previous epoch and drives the `LOADING`/`UNLOADING` state
  transition described in §3.
- **A fiber whose `inject` map is not fully satisfied stays in `PENDING` and never runs its plugin
  body.** This is exactly what `assertEntriesActivated()` reports for a hung boot
  (`packages/boot/app-boot/src/index.ts:725-728`): `missing = Object.keys(fiber.inject).filter(service => fiber.ctx.get(service) === undefined)`,
  surfaced as `"<name>: pending (waiting for services: <missing>)"`.
- **When a dependency unloads** (its providing fiber disposes or its `provide()` effect is torn down),
  `ReflectService.provide()`'s teardown closure calls `this.notify([name])` (`reflect.ts:298-299`) →
  `ReflectService.notify()` (`reflect.ts:314-336`) walks every registered runtime's live fibers, and for
  each fiber whose `inject` includes that name, calls `fiber._checkImpl(name)` then `fiber._refresh()`
  (`reflect.ts:320-327`) — this is the live re-evaluation that can flip a currently-`ACTIVE` dependent
  fiber's epoch back to `INACTIVE`, triggering its own `_unload()` (teardown, in reverse effect-registration
  order per `_disposables.clear()`, `fiber.ts:676-696`). So **losing a dependency automatically and
  immediately unloads every dependent fiber**, cascading through the same mechanism (each unloaded
  fiber's own `provide()`s, if any, trigger further `notify()` calls up the graph).
- Ordering is therefore **not** declared or topologically pre-sorted; it emerges from event-driven
  re-evaluation triggered by `provide()`/dispose effects. Multiple independent fibers can and do settle
  concurrently (`EntryGroup.update()`'s `Promise.allSettled(config.map(...))`, `vendor/loader/src/config/group.ts:71`).

**`AgentLoop`'s injected services** (`agent-loop/src/index.ts:353`): `['agents', 'sessions', 'llm',
'tools', 'systemPrompt', 'sessionProjections']` — array form, so no per-service intercept config; all six
must be `ACTIVE`-and-providing before the `AgentLoop` constructor runs at all.

---

## 5. Loader reading `cordis.yml`; config file structure; `!!js`

**Reading mechanism**: covered mechanically in §1 steps 5-7. The class doing the actual file I/O and
patch application is the vendored `Include` (`vendor/include/src/index.ts`), mounted as the
`cordis:include` Loader builtin. `Include.constructor` resolves `this.filename` from
`fileURLToPath(new URL(this.config.path, this.ctx.baseUrl))` (line 197) and only accepts `.json`,
`.yaml`, `.yml` extensions (`writable` map, line 27-33; unsupported extension throws, line 199-201).
`[Service.init]()` (line 273-289) reads the file, and `refresh()`/`_apply()` (line 301-321) is the
live-reload path used by `internal/update` config-swap or HMR-driven file-watch refresh.

**File format** (`EntryOptions`, `vendor/loader/src/config/entry.ts:9-22`): a top-level YAML/JSON array
where each row is
```ts
{ id: string, name: string, config?: any, group?: boolean|null, disabled?: boolean|null, inject?: Inject|null }
```
plus, via the `isolate` Loader plugin's module augmentation (`vendor/loader/src/config/isolate.ts:5-14`),
optional `intercept?: Dict|null` and `isolate?: Dict<true|string>|null`. A row with `group: true` is
mounted through the `cordis:group` builtin (`Group` class, `vendor/group/src/index.ts:116-129`), whose
`config` is itself a nested `EntryOptions[]` array — this is what lets `agent.cordis.yml`'s `planning`,
`compaction`, and `delegation` rows be sub-lists (§ addendum 2).

**Patch-list format** (`PatchOptions`, `vendor/include/src/index.ts:145-156`):
```ts
{ id?: string, insert?: EntryOptions[], name?: string, config?: any, group?: boolean|null,
  disabled?: boolean|null, inject?: any, intercept?: any, isolate?: any, [key: string]: any }
```
— structurally a sparse `EntryOptions` plus the `insert` list-append field. Every `packages/bundle/*/cordis.patch.yml`
and `packages/preset/agent-presets/presets/standard/agent.cordis.yml` is parsed under this schema (the
latter is a full `EntryOptions[]` document, not a patch list, per the discovery/mount code path — see
§ addendum 1).

**`!!js` verification**: the YAML dialect is defined once, in `vendor/include/src/index.ts:9-23`:
```ts
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data) => data['__jsExpr'],
})
export const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)
```
`tag:yaml.org,2002:js` is the *resolved* tag that YAML's `!!` shorthand-tag-handle syntax (`!!js`)
expands to (standard YAML: `!!foo` = `tag:yaml.org,2002:foo` via the default `!!` handle, whereas a
single `!foo` is an *application-local* tag with no resolution to that canonical URI) — this is why
AGENTS.md's "`!!js` (never `!js`)" distinction is real and not cosmetic: a single-bang `!js` would
never match this custom `Type`'s tag and would either fail to parse or resolve to a generic scalar,
not an expression node. A round-tripped `!!js` scalar becomes the plain object `{ __jsExpr: "<source>" }`
at parse time; `isJsExpr` (`vendor/loader/src/config/utils.ts:25`, grep-confirmed) is the predicate
used both by the YAML type and by consumers (e.g. `Entry.disabledOf()`,
`vendor/loader/src/config/entry.ts:100-108`, and `evaluate()`,
`vendor/loader/src/config/entry.ts:110-112` calling into `vendor/loader/src/config/utils.ts`'s
`evaluate(ctx, expr)`, not fully read in this pass — UNKNOWN exact eval mechanism, likely a scoped
`with`/`Function` construction given `AgentPresets.compositionInventory()`'s comment
"An identifier this scope cannot resolve throws under `with`", `packages/preset/agent-presets/src/index.ts:296-299`
— INFERRED, not directly read).

`!!js` is documented (AGENTS.md, `vendor/README.md` item 18) to be evaluated **lazily**, per-row, against
that row's own fiber context, not eagerly against the Loader's context — confirmed structurally by
`vendor/loader/src/index.ts:92-101`'s `internal/config` listener, which calls `interpolate(this.ctx, config)`
for every entry **except** tree-carrier plugins (`Include`, `Group`, marked via `static readonly [EntryGroup.key] = true`,
e.g. `vendor/include/src/index.ts:182`) — this is exactly vendor/README.md modification #15's claimed
behavior ("Lazy Loader config resolution... resolving it through internal/config only after declared
injections are active... Include declares the EntryGroup.key tree-carrier marker... its config is entry
and patch lists, so interpolation keeps it literal"). CONFIRMED by direct source reading (not merely
trusted from the README), satisfying the "verify against actual source" instruction.

**`disabled: !!js` interpolation** (vendor/README.md item 18) is independently confirmed at
`vendor/loader/src/config/entry.ts:100-108 → Entry.disabledOf()`:
```ts
private disabledOf(options: EntryOptions): boolean {
  return isJsExpr(options.disabled)
    ? Boolean(this.evaluate(options.disabled.__jsExpr))
    : Boolean(options.disabled)
}
```
Every bundle patch file uses this for platform gating, e.g.
`packages/bundle/base/cordis.patch.yml:222 disabled: !!js process.platform === 'win32'` (bash sandbox)
and `:228 disabled: !!js process.platform !== 'win32'` (pwsh sandbox).

**Actual `cordis.yml` / `cordis.patch.yml` files found in the repo** (via glob):
- `apps/server/config/examples/{cordis,github-review,schedule}/cordis.yml` — demo **patch overlays**
  (own header comments confirm), applied via `--patch`, not tree definitions. E.g.
  `apps/server/config/examples/cordis/cordis.yml` inserts `dsh-cordis-host-runner` +
  `dsh-tool-cordis` (self-inspection tools) and repoints the webserver port to 3081.
- `apps/server/tests/fixtures/{dsh-badge,github-webhook}/cordis.yml` and
  `packages/shell/tool-pwsh/tests/fixtures/loader/cordis.yml` — test fixtures, not read in this pass.
- `snapshots/session/*/cordis.yml` (~30 files) — recorded-session test fixtures, not read in this pass.
- **No file literally named `cordis.yml` defines the shipped `web` profile's tree** — it is synthesized
  at boot from `packages/bundle/base/cordis.patch.yml` + `packages/bundle/web-app/cordis.patch.yml`
  (+ user/home/`--patch` layers) applied over the runtime-written empty `[]` (§2).
- `packages/preset/agent-presets/presets/standard/agent.cordis.yml` — the per-agent composition file
  mounted by the preset layer (§ addendum).

---

## 6. Waterfall event semantics (`ctx.events.dispatch`, `next()`)

Implemented in `vendor/cordis/src/events.ts`. `EventsService.dispatch(type, args)` (line 165-175) is the
shared listener-resolution step for every dispatch mode: it optionally shifts a `thisArg` off `args[0]`,
shifts the event name, emits a **diagnostic** `internal/dispatch` event for non-`internal/*` names (line
169), then filters `this._hooks[name]` by the `thisArg`'s `Context.filter` (if any) and returns bound
callbacks (line 172-174). `internal/*` events skip the diagnostic emission — a normal Cordis convention,
not something specific to this fork.

**`waterfall()`** (`events.ts:234-243`):
```ts
waterfall(...args: any[]) {
  const cbs = this.dispatch('waterfall', args)
  const inner = args.pop()          // the innermost/"default" continuation
  const next = () => {
    const cb = cbs.shift() ?? inner // shift takes the NEXT outer-to-inner listener, or the innermost fallback
    return cb(...args)
  }
  args.push(next)
  return next()
}
```
Listeners are collected in registration order (`cbs`), then invoked as **nested continuations**: calling
`waterfall()` immediately invokes `next()` once, which pops the *first registered* listener and calls it
with the original args plus a fresh `next` closure appended. That listener may:
- call `next()` (invoking the *next* listener in registration order, or finally the original `inner`
  callback once all registered listeners are exhausted) — "delegating", per AGENTS.md's
  "Waterfall listeners MUST call `next()` to delegate";
- return without calling `next()` — this **short-circuits the whole chain**: no later listener nor the
  built-in/default behavior (`inner`) ever runs. This matches AGENTS.md's "returning without it
  short-circuits the chain" verbatim, and is now grounded directly in `waterfall()`'s implementation:
  since `next` is a plain closure invoked by the listener body itself (not by the dispatcher), skipping
  the call is simply skipping a function call — there is no framework-level enforcement.

Concrete first-party consumers seen in this pass:
- `ReflectService`'s property-get trap wraps every "service read through the context proxy" in
  `ctx.events.waterfall('internal/get', ctx, prop, error, () => { ...actual lookup... })`
  (`reflect.ts:153-167`) — so any plugin can intercept/veto/rewrite a `ctx.<service>` read.
- `Fiber._resolveConfig()` calls `this.context.waterfall(this, 'internal/config', config, () => config)`
  (`fiber.ts:642`) — the mechanism the Loader's own `internal/config` listener
  (`vendor/loader/src/index.ts:92-101`) hooks to interpolate `!!js` expressions lazily (§5).
- `Fiber.update()` calls `this.context.waterfall(this, 'internal/update', config, noSave, () => {...restart...})`
  (`fiber.ts:748-752`) — what lets `Loader`'s and `Include`'s own `internal/update` listeners
  (`vendor/loader/src/index.ts:103-115`, `vendor/include/src/index.ts:206-213`) intercept/persist
  config changes before the actual restart runs.
- `EventsService`'s own constructor installs a **self-referential** `internal/update` waterfall handler
  (`events.ts:148-155`) that threads a per-fiber list of `internal/update`-specific hooks
  (`fiber._hooks['internal/update']`) through the *same* `next()` composition pattern one level down —
  a waterfall-of-a-waterfall used to let individual fiber-scoped listeners (registered via the
  `internal/listener` bail hook, `events.ts:140-146`) participate without being globally registered.

`ctx.events.dispatch()` (the literal method the task calls out) is used directly (not through
`waterfall`/`emit`/etc. sugar) in exactly the places that need raw callback handles with custom
try/catch semantics — e.g. `Fiber`'s `emitPluginDisposed()` (`fiber.ts:120-137`) and
`agent-loop/src/index.ts:457 for (const callback of this.ctx.events.dispatch('emit', args))` inside
`AgentLoop.reportConfiguredStartupFailure()`, which manually iterates and independently try/catches each
listener so one listener's synchronous throw or async rejection cannot suppress delivery to the others —
a stronger isolation guarantee than `ctx.emit()`'s own `dispatch('emit', args).map(cb => cb(...args))`
(`events.ts:194-196`), which has no isolation of listener failures at all (an exception from one listener
callback would propagate up through `.map()` and abort remaining calls) — worth flagging: **`ctx.emit()`
does NOT protect later listeners from an earlier listener's synchronous throw**; callers wanting that
must use `dispatch()` directly and iterate with their own try/catch, exactly as `AgentLoop` does.

---

## 7. Vendored Cordis version and local modifications

**Version** (`vendor/README.md:17`): `cordis/` is npm-scoped `@deepseek-ai/cordis`, upstream `cordis`
**4.0.0-rc.7**, from `https://github.com/cordiverse/cordis` (`packages/core`), commit
`56b3d4f725681cf4556c1a8695a709cc3b6eed74`. Companion packages (`loader`, `include`, `group`, `timer`,
`hmr`, `logger-console`) are separately versioned per `vendor/README.md`'s manifest table — notably
`include`, `group`, `timer`, `hmr`, `logger-console` are sourced from a **fork**,
`https://github.com/deepseek-harness/cordis`, not upstream `cordiverse/cordis`, at a different commit
(`abb0a307cb1d3b0947f455d590cf5ba922d4caa4`) — only `cordis` core and `loader` come from the
`cordiverse/cordis` commit `56b3d4f7...`.

**Local modifications** — `vendor/README.md` lists 19 items (§"Local modifications", lines 29-51). Per
the ground rule "do not trust vendor/README.md — verify against source," I independently confirmed the
following against the actual vendored source in this pass:
- **Item 6** (fiber lifecycle hardening — reentrant disposal gaps, effect registered before setup runs,
  `Fiber.update()` returning its waterfall result): the described behavior is visible in
  `vendor/cordis/src/fiber.ts:504-561` (`effect()`'s `removeWrapper = this._disposables.push(wrapper)`
  happens at line 520, *before* `task = this._execute(runner)` at line 522) and
  `fiber.ts:736-753` (`update()`'s final line **is** `return this.context.waterfall(...)`, i.e. the
  waterfall's return value, itself a promise for the async `restart()` case, is returned to the caller).
  CONFIRMED — matches the log's description.
- **Item 11** (`applyEntryPatches` exported, `entryListSchema` exported, insert-then-index-immediately
  so a later patch in the same list can target an earlier `insert`'s row): directly read and confirmed
  at `vendor/include/src/index.ts:23` (`export const entryListSchema = ...`), `:58` (`export function
  applyEntryPatches`), and `:94-101` (`data.push(...insert); ...; buildMap(insert)` — the inserted rows
  are added to `entryMap` immediately after insertion, inside the same patch-list loop). CONFIRMED.
- **Item 15** (lazy `!!js`/`internal/config` resolution, tree-carrier literal-config exemption): directly
  confirmed at `vendor/loader/src/index.ts:92-101` and `vendor/include/src/index.ts:182`
  (`static readonly [EntryGroup.key] = true`). CONFIRMED — see §5.
- **Item 18** (`disabled: !!js` interpolation): directly confirmed at
  `vendor/loader/src/config/entry.ts:100-108`. CONFIRMED — see §5.
- **Item 19** (`ModuleLoader.fromInternal()` capability-detection instead of Node-major-version check):
  **not independently read** in this pass (`vendor/loader/src/internal.ts` was globbed but not opened) —
  UNKNOWN, would need to open `vendor/loader/src/internal.ts` and check for `getOrCreateModuleJob` /
  `getModuleJobForImport` capability probing rather than a `process.version` branch.
- Items 1-5, 7-10, 12-14, 16-17: **not independently verified against source** in this pass (time-boxed);
  flagged UNKNOWN — checked only that the referenced files exist, would need a line-by-line diff against
  an upstream `cordis@4.0.0-rc.7` / `cordiverse/cordis@abb0a30...` checkout to fully confirm each claim
  (no upstream checkout available in this environment).

**Ground-rule note on vendor/README.md itself**: the file's prose is a first-party changelog authored by
the same team, and its individual entries proved accurate wherever spot-checked (5 of 19 items, all
CONFIRMED, none contradicted) — but per the task's instruction it is cited here only as a claim, with
the corroborating file:line evidence given separately for each spot-checked item.

---

## 8. `ctx.effect(fn, label)` — return value and teardown ordering

`vendor/cordis/src/fiber.ts:402-561 → Fiber.effect()`. Two call signatures (sync/async, lines 415-417),
same implementation. Mechanics:
- `execute` runs **synchronously, immediately**, inside `this._execute(runner)` (line 522) — a fiber
  cannot register a "lazy" effect; the body always runs at the point `ctx.effect(...)` is called (subject
  to `assertActive()`/`UNLOADING` guards at lines 419-422 throwing `CordisError('INACTIVE_EFFECT')`).
- The **shape of the return value from `execute`** determines what gets collected as a disposer
  (`_execute()`, lines 356-400): a function is collected directly; `null`/`undefined` collects nothing;
  a `Promise` has its resolved disposer collected once it settles; a sync `Iterable` has **every yielded
  disposer** collected as it's produced (used for `async*[Service.init]()`-style generator effects, e.g.
  `Include`'s `yield () => this.stop()` before `await this.apply(...)`, `vendor/include/src/index.ts:287-288`);
  an `AsyncIterable` collects yields as they resolve, aborting early if `runner.epoch` has changed underneath it (a stale-reload guard, line 390). Anything else (a non-function, non-nullable, non-thenable, non-iterable object) throws `TypeError('Invalid effect')`.
- **Return value of `ctx.effect()` itself**: a `wrapper` function (`fiber.ts:504-514`) tagged with
  `Object.defineProperty(wrapper, symbols.effect, meta)` where `meta = { label, children: [] }`
  (line 444) — this is the `Disposable<Promise<void>>` / `AsyncDisposable<Promise<void>>` documented in
  the public type signatures (lines 415-417). Calling `wrapper()` tears the effect down: it flips
  `runner.epoch = false` (marking it "already disposed" so a second call is a no-op, returning the same
  in-flight/settled disposal task — line 508-513) and invokes `finalizeDisposal(() => dispose())`. The
  wrapper is **also thenable** (`wrapper.then = ...`, lines 555-559): `await`-ing the return value of
  `ctx.effect()` waits for the effect's own setup (`task`) to settle and then resolves to the disposer
  function itself — i.e. `const dispose = await ctx.effect(...)` is a legal, documented pattern for "wait
  for setup, then get the teardown handle."
- **Teardown ordering**: `dispose()` (`fiber.ts:427-442`) runs collected disposables via
  `disposables.splice(0).reverse()` — **strict LIFO**, matching the public doc comment "Disposers run in
  reverse registration order when the owning fiber unloads" (line 71-72, `Disposable<T>` type doc). If
  any disposer's return value is thenable, subsequent disposers are chained with `.then()` so **later
  (earlier-registered) disposers wait for all already-started later-registered ones to finish** — i.e.
  even async cleanup is serialized strictly in reverse order, not run concurrently.
- **Fiber-level unload** (`_unload()`, `fiber.ts:675-696`) is different: it clears the *entire*
  `_disposables` list at once via `this._disposables.clear()` and runs **all of them concurrently**
  (`Promise.all(...map(...))`, line 676) with per-disposer error containment (`ctx.logger.error(reason)`,
  each disposer's failure is independently caught and logged, never aborting sibling teardown) — so the
  ordering guarantee **within one `ctx.effect()` call's own nested disposers is strict LIFO**, but
  **teardown of *distinct* top-level effects registered directly on a fiber (via `_disposables`) is
  concurrent, not ordered**, when the *whole fiber* unloads. This is an important nuance for the book:
  "reverse registration order" is guaranteed for effects nested inside one `ctx.effect()`'s own returned
  generator/disposer chain, but sibling top-level `ctx.effect()` registrations on the same fiber tear
  down in parallel when the fiber itself is disposed.

**Concrete harness usage illustrating both the return-value contract and manual multi-owner teardown
composition**: `AgentLoop.prepare()` (`agent-loop/src/index.ts:522-641`) builds a `dispose()` closure
memoized via `disposing ??= (async () => {...})()` (line 560) — this is the harness's own idiom for "make
an arbitrary teardown idempotent and awaitable by every racing caller," layered *on top of* (not
replacing) Cordis's own effect-disposer idempotency; it then registers that composite disposer as a
plain `ctx.effect(() => () => {... return dispose(true) ...}, 'agentLoop.lifecycle(${id})')` on the
*owner* context (line 587-593) so that **if the owner fiber unloads, the agent's whole lifecycle
(machine cancellation, registry detachment, scope disposal) is torn down as an ordinary Cordis effect**,
while independently also being torn down if the `AgentLoop` factory itself shuts down
(`FactoryOwnership.dispose()`, lines 137-146, which `Promise.all`s every tracked live agent's `dispose()`
alongside outstanding startup tasks) — two independent teardown triggers converging on one memoized
async closure. `AgentLoop`'s own top-level constructor registers two sibling effects directly on its own
fiber: `ctx.effect(() => () => this.ownership.dispose(), 'agentLoop.transactions()')` (line 412) and
`ctx.effect(() => ctx.agents.setFactory(this), 'agentLoop.setFactory()')` (line 413) — per the ordering
rule above, if `AgentLoop`'s own fiber unloads, these two run **concurrently**, not in a guaranteed order
relative to each other (though `agents.setFactory()`'s own disposer, whatever it does internally, is
opaque here — UNKNOWN without reading `dsh-agent`'s `setFactory()`).

---

## Addendum: the third composition layer — agent presets (mounted by coordinator's own tracing)

### A1. How and when the preset layer mounts (verified against `mount.ts`, `discovery.ts`, `index.ts`, `session.ts`)

**Claim to verify**: the preset file's header comment
(`packages/preset/agent-presets/presets/standard/agent.cordis.yml:2-3`) says "mounted once per process
under a standing scope; every session naming it joins by scope parentage." `packages/preset/agent-presets/src/index.ts:2-3`
says the same thing.

**Verified mechanism** — `AgentPresets.ensureStanding()` (`packages/preset/agent-presets/src/index.ts:747-795`)
is the single gate: a `private readonly standing = new Map<string, Promise<StandingMount>>()` keyed by
**preset id** (line 391, restated 747). `ensureStanding(preset)`:
1. If a `Promise<StandingMount>` for this id already exists (line 748-767), it is **reused** rather than
   remounting — this is the literal "once" guarantee, implemented as an in-memory single-flight cache,
   **not** a Cordis-level singleton constraint. It additionally checks the composition **file's
   mtime/size stamp** (`compositionStamp()`, lines 806-816) on every call; if the file changed since the
   cached mount, the cached entry is evicted and a **new generation** is created (recursive call, line
   767) — so "once per process" is more precisely **"once per (preset id, on-disk file generation)"**;
   a live-edited preset file does get remounted for *new* sessions while existing sessions keep running
   on their original generation's plugin instances (comment, lines 759-763: "Sessions already joined
   keep the generation they run on... reclaimed only by whole-tree teardown").
2. On a cache miss, it does `const key: ScopeKey = { agentPreset: preset.id }` (line 770 — a **fresh
   plain object** used purely for identity comparison, per `packages/core/scope/src/index.ts:15
   export type ScopeKey = object`), `const scope = createScope(this.selfCtx, key)` (line 771,
   `packages/core/scope/src/index.ts:137-147 createScope()` — mints a no-op Cordis plugin fiber via
   `ctx.plugin(scope)` where `scope(){}` is a literal empty function, then `.extend({ [kScope]: key })`),
   then `await mountPreset(scope.ctx, preset)` (line 785).
3. `mountPreset()` (`packages/preset/agent-presets/src/mount.ts:378-433`) does
   `const handle = agentCtx.plugin(PresetTree, config)` (line 396) — `PresetTree extends Include` (an
   ordinary Cordis plugin mount, one call, directly plugged rather than routed through a Loader `Entry`)
   — awaits it, checks every row activated (`inactiveRows()`) and that no row leaked a service into the
   **root** isolate realm (`leakedServices()`, lines 210-224 — walks `ctx.reflect.store`'s own symbols
   and flags any whose isolate key equals the literal root's isolate symbol for that name), then records
   `mounts.add({ presetId, fiber, tree, key: scopeOf(agentCtx) })` (line 414) in a **module-level**
   `const mounts = new Set<PresetMount>()` (line 138) — this set, not `ensureStanding`'s map, is what
   `standingMountFor()`/`livePresetMounts()` read.

**When relative to session/agent creation**: `AgentPresets.mount(agentCtx, id?)`
(`packages/preset/agent-presets/src/index.ts:414-427`) is the entry point an agent factory's `setup()`
hook calls (per the module doc comment, `index.ts:17-20`: "the agent factory's `setup(agentCtx)` hook is
the one supported call site"). It does `const standing = await this.ensureStanding(preset)` (line 420)
— i.e. **the standing composition is created lazily, on the *first* agent that ever requests that preset
id**, not eagerly at process boot — then `this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))`
(line 425), which is `packages/core/scope/src/index.ts:72-82 bindScopeParent()`: writes a `WeakMap<ScopeKey, ScopeKey>`
parent-pointer entry (`scopeParents`, line 39) from the **agent's own scope key** to the **standing
mount's scope key**, with a cycle check (`linkScopeParent()`, lines 54-59). This is the concrete "joins
by scope parentage" — **no new Cordis fiber, no new plugin instance, no re-import of any module** is
created for the second, third, ... agent joining the same preset; only a WeakMap entry is added.

**Verdict**: the file/module comment is **CONFIRMED**, with the refinement that "once per process" is
actually "once per (preset id, composition-file generation), single-flighted and lazily created on first
use, cached until the file changes or the whole tree tears down" — a materially more precise statement
than the comment's plain "once per process," worth stating precisely in the book.

### A2. `isolate:` on a `cordis:group` row — the realm mechanism

Source: `vendor/loader/src/config/isolate.ts` (the `isolate` Loader plugin, mounted unconditionally by
`Loader`'s own constructor, `vendor/loader/src/index.ts:159 ctx.plugin(isolate)`).

**Data model**: `Realm` (abstract, lines 26-46) holds a `Dict<symbol>` map from service name to a
per-realm `Symbol`. Two concrete subclasses:
- `LocalRealm` (lines 49-57): one per `Entry`, suffix `'#' + entry.options.id` — this is what
  `isolate: { compaction: true }` (a boolean `true` value) selects (`access()`, lines 75-89: `if (label
  === true) realm = entry.realm ??= new LocalRealm(entry)`).
- `GlobalRealm` (lines 60-68): one per **string label**, suffix `'@' + label`, shared across every entry
  that names the same label string — this is the "labels join REALMS" case the `agent.cordis.yml`
  comment (lines 16-18) explicitly calls out as different from `true`: `provide()` throws on a *second*
  registration under the same realm symbol (`ReflectService.provide()`, `reflect.ts:289-291`), so a
  shared label is for **multiple entries agreeing to resolve the same instance**, not for pooling
  multiple instances.

**Effect on service publication/resolution** — `ctx.on('loader/patch-context', ...)`
(`isolate.ts:96-153`), run for every entry via `Entry._patchContext()` (`entry.ts:114-122`, itself called
from `_start()`/`update()`): builds a `newMap` of `Context.isolate` overrides for every name the entry's
`options.isolate` declares (step 1, lines 98-101: `newMap[name] = access(entry, name, true)`), computes
which names actually **changed** relative to the entry's current isolate map (step 2, "generate service
diff," lines 103-120 — this is the part that lets an *existing, already-`ACTIVE`* implementation
**migrate** to the new symbol slot rather than being torn down and recreated, when the label churns but
an implementation already exists), then **replaces the entry context's own `[Context.isolate]` map**
via `Object.setPrototypeOf` + `swap()` (step 3, lines 123-126) so that `entry.ctx[Context.isolate][name]`
now points at the realm-private symbol instead of inheriting the parent's (typically root) symbol for
that name — **before** reloading the fiber (`await next()`, step 4, line 129).

Concretely: `ReflectService.provide()` looks up `this.ctx.root[symbols.isolate][name] ??= Symbol(name)`
then `const key = this.ctx[symbols.isolate][name]` (`reflect.ts:286-287`) and stores the `Impl` at
`this.store[key]`. **Because an entry inside an `isolate: { compaction: true }` group has had its own
`ctx[Context.isolate]['compaction']` remapped to a realm-private symbol**, any `provide('compaction', ...)`
call made by a plugin running under that context stores its `Impl` under that **private** symbol, not
under whatever symbol the root (or any sibling realm) uses for `'compaction'`. A **read** (`ctx.get`/the
proxy trap) resolves `name` by looking up `ctx[symbols.isolate][name]` first (`reflect.ts:238`,
`reflect.ts:154` in the proxy trap) — so a context *outside* the realm (no override in its own
`[Context.isolate]` chain) still resolves the **root's** symbol for `'compaction'`, which the realm's
private implementation never registered under. **This is precisely why an entry-local realm is
invisible outside the group that declares it, and why a service published with no `isolate:` at all is
visible process-wide**: with no isolate declaration, an entry's `ctx[Context.isolate]` is *inherited
unchanged* from its parent all the way to the root's shared symbol table, so `provide()` stores under the
one root-wide symbol every unscoped reader also resolves.

This confirms the `agent.cordis.yml` and `mount.ts` comments' claims about realms with, in this case,
independent verification of the actual isolate-map-swap mechanism in `vendor/loader/src/config/isolate.ts`
rather than trusting the comments alone.

**Distinct from `dsh-scope`**: it is worth flagging explicitly for the book that there are **two
unrelated isolation mechanisms** layered here: (a) Cordis/Loader's `isolate:` realm system just described
— pure service-symbol remapping, framework-level, config-declared per entry; and (b) the harness's own
`packages/core/scope` package (`ScopeKey`, `createScope`, `bindScopeParent`, `scopeOf`) — an
**application-level** context-tagging and event-routing convention built entirely from ordinary
`ctx.extend()` + a private `WeakMap` parent-chain + Cordis's pre-existing `Context.filter` waterfall-
listener-filtering hook (`carrierKeys`/`scopeTarget()`, `packages/core/scope/src/index.ts:170-185`). The
preset system uses **both**, for different purposes: `dsh-scope` for "which standing mount does this
agent belong to" (A1, A3), and Loader `isolate:` realms for "keep this preset's own `compaction`/
`workflowEngine` service instances from colliding with another preset's" (this section).

### A3. Scope parentage, host-plane registry visibility, and `packages/core/scope`

Two separate readability directions, both confirmed by source:

**(a) Host-plane registries (`tools`, `skill`) ARE visible to preset rows** — not because of any
`dsh-scope` mechanism, but because of the **ordinary Cordis context-proxy walk** (§3, `reflect.ts:152-166`):
a preset row's fiber context is `agentCtx.plugin(PresetTree, ...)`'s child context
(`Context.extend({ fiber: this })`, `fiber.ts:236`), whose ancestor chain leads back through the standing
scope's `createScope()`-minted context, through `AgentLoop`'s own context, up to the Loader/root context
where `tools` (`@deepseek-ai/dsh-tools`) was originally `provide()`d with **no `isolate:`** — so its
implementation sits under the root's own symbol for `'tools'`. Since *nothing* in the preset's own
ancestry remaps `ctx[Context.isolate]['tools']` (only `compaction`/`toolResultPruner`/`workflowEngine`/
`planMode` are remapped, per `agent.cordis.yml`'s three `isolate:`-bearing groups), a preset row that
does `static inject = ['tools']` or reads `ctx.tools` resolves the *same* root symbol the host row
registered under, walking up via the `while (true) { ... fiber = fiber.parent.fiber }` loop in
`reflect.ts:155-166` until it finds the root's `Impl`. This is why the comment "Both register into the
host `tools` registry and provide nothing, so they need no realm" (`agent.cordis.yml:54-55`) is
mechanically accurate: **absence of an isolate override, not presence of any explicit "grant," is what
makes a host service visible** — visibility is the *default*, and an `isolate:` realm is an opt-in
*narrowing*, never a widening.

**(b) A preset-published service stays invisible to host rows** — the inverse of §A2: the host's own
context never had its `[Context.isolate]` map touched by the preset's `isolate:` declaration (that
mutation happened only on the preset entry's own descendant context, per `isolate.ts`'s step 3), so a
host-plane row reading `ctx.get('compaction')` resolves whatever symbol the **host's own** isolate chain
maps `'compaction'` to — normally nothing (no host-plane `compaction` provider exists once
`web-app/cordis.patch.yml` disables the host-plane `compaction-basic` row, line 392-393) — never the
realm-private implementation the preset's `compaction` group registered. This is exactly what
`leakedServices()`/`serviceForAgent()` in `mount.ts` (lines 199-224, 259-293) exist to police/exploit:
`leakedServices` catches a row that *forgot* an isolate wrapper (its `Impl` would be stored at the
**root**'s symbol, made detectable by comparing `rootIsolate[impl.name] === key`, line 221);
`serviceForAgent` is the deliberate **backdoor** for host code that needs to read *inside* a specific
agent's realm-private service anyway (a browser RPC "about" a session) — it does not use the isolate map
at all, instead walking `ctx.reflect.store`'s own symbols directly and testing **fiber membership**
(`withinFiber()`, lines 189-197, plain object-identity walk up `fiber.parent.fiber`) against the specific
mount's root fiber — i.e. it deliberately bypasses the very invisibility the realm exists to enforce, by
using a different addressing scheme (fiber-tree membership) than the one dependents normally use
(isolate-symbol lookup).

**`packages/core/scope`'s role**: distinct from the above (see A2's closing note). It provides:
- `scopeOf(ctx)` (`packages/core/scope/src/index.ts:154-156`) — reads a `Symbol('dsh.scope')`-tagged own
  property set by `createScope()`'s `.extend({ [kScope]: key })` (line 140).
- `ScopedLayers<L>` (`packages/core/scope/src/store.ts:159-267`) — a **registry-side** (not Cordis-side)
  per-scope overlay store used by things like the `tools`/`skill` registries (not opened in this pass —
  UNKNOWN exact call sites, INFERRED from the `agent.cordis.yml` comments describing "layered per
  scope") to let a preset's `skill-filesystem` row register into "this preset's layer" while a host
  `skill-filesystem` row (if any) registers into the "global" layer, and `merge()` (`store.ts:208-217`)
  composes `global` + `chainLayers(scope)` (farthest ancestor first, nearest scope last so it wins name
  collisions) into one effective map — this is the concrete "merged catalog" the `agent.cordis.yml`
  skills comment describes. This is a **harness-authored** layering convention built *on top of*
  ordinary Cordis effects (`ScopedLayers.effect()`, lines 226-266, itself implemented as one
  `ctx.effect(...)` call) — it does not touch Cordis's `Context.isolate`/realm machinery at all. It is
  therefore a **third**, independent mechanism from both (§A2's realms and) plain Cordis context
  inheritance: realms hide/rename symbols framework-wide; `ScopedLayers` is an application-level
  Map-per-scope-key data structure that happens to use `scopeOf(ctx)` (from the same `dsh-scope` package
  as the standing-mount parentage in A1) to decide which overlay a given registration lands in, and
  `scopeChainOf()` (`packages/core/scope/src/index.ts:98-102`, walking the same `scopeParents` WeakMap
  A1 populates via `bindScopeParent`) to decide which overlays a given *read* sees — so the **same**
  parent-link A1 installs to join an agent to its standing preset mount is *also* what makes that
  agent's registry reads see the preset's own `ScopedLayers` overlay layered under the global one. One
  relation (`scopeParents`), two consumers (event routing via `scopeTarget()`, and registry layering via
  `ScopedLayers.chainLayers()`).

### A4. `preset.yml` — display metadata only?

`packages/preset/agent-presets/presets/standard/preset.yml` (full contents, 3 lines):
```yaml
name: 标准模式
description: 功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。
order: 1
```
**CONFIRMED** — exactly 3 lines, Chinese display name + description + a numeric `order` field, no
plugin rows, no config, nothing else. (Note: the actual filename on disk is `preset.yml`; discovery code
calls it `METADATA_FILE`, read via `readPresetMetadata()` in `packages/preset/agent-presets/src/metadata.ts`,
not opened in this pass — UNKNOWN exact schema/field list beyond what these 3 lines show, but
`discovery.ts:311 const metadata = await readPresetMetadata(directory)` treats a broken/missing metadata
file as non-fatal ("Display text only, and never fatal: a preset with unreadable metadata still mounts,
it just shows its id," `discovery.ts:309-310`), corroborating that this file carries no composition-
relevant data.)

---

## Open UNKNOWNs from this pass (for follow-up if the book needs them)

- Exact `evaluate(ctx, expr)` implementation for `!!js` (`vendor/loader/src/config/utils.ts`) — not
  opened; only its call sites and the `isJsExpr` predicate were confirmed.
- `vendor/loader/src/internal.ts`'s `ModuleLoader.fromInternal()` — vendor/README.md item 19's exact
  capability-detection logic not independently read.
- `vendor/cordis/src/utils.ts`'s `getTraceable`/shadow mechanism — referenced by `Context.extend()` and
  `AgentPresets`'s `selfCtx` comment, but not opened; the "traced `this.ctx` resolves through the
  caller's fiber" behavior is corroborated only by application-code comments, not by reading `utils.ts`
  directly.
- `packages/preset/agent-presets/src/metadata.ts`, `preset.ts`, `types.ts`, `authoring.ts`,
  `specifier.ts`, `composition-inventory.ts` — globbed but not opened; the `AgentPreset`/`PresetRoot`
  type shapes and `classifyRowSpecifier()` logic are known only by their call-site usage in
  `mount.ts`/`discovery.ts`/`index.ts`.
- vendor/README.md local-modification items 1-5, 7-10, 12-14, 16-17 — not independently verified against
  source in this pass (no upstream checkout available to diff against); treat as claims pending
  verification, not as confirmed findings, despite the 5/5 spot-check hit rate on the items that
  mattered most for this brief (6, 11, 15, 18, plus the version/manifest table itself).
- `AgentLoop`'s `ctx.agents.setFactory(this)` disposer internals (`packages/core/agent-loop` depends on
  `@deepseek-ai/dsh-agent`'s `AgentFactory`/registry, not opened in this pass).
