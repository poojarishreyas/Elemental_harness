/** Pure session fixture normalization, prompt/schema snapshots, and refresh helpers.
 * @module @deepseek-ai/dsh-session-snapshot/suite
 */

import { isSurfaceEligibleType } from '@deepseek-ai/dsh-session/surface'
import { type NormalizeContext, extractSnapshotSpillPaths, normalizeSessionLog } from './normalize.ts'

/** Stable session-log token standing in for the sidecar's initial schemas. */
const TOOLS_TOKEN = '{{tools}}'
const PACKED_CHUNK_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])
/** Canonical UUID spelling minted for ordinary message identities. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One harvested session log plus the identifying facts off its header line. */
export interface HarvestedLog {
  /** The recorded session id (header `id`). */
  id: string
  /** Session creation time (header `createdAt`) — the child-ordering key. */
  createdAt: number
  /** The parent session id, if this log is a subagent child (header `parentSession`). */
  parentSession?: string
  /** The full `.jsonl` file content. */
  content: string
}

/** One scenario's generated claim on a shared snapshot file. */
export interface SharedSnapshotClaim {
  /** Scenario that first generated the snapshot in this suite run. */
  scenario: string
  /** Complete generated file content. */
  content: string
}

/** One committed snapshot file and its complete content. */
export interface NamedSnapshotContent {
  /** Diagnostic path of the committed file. */
  path: string
  /** Complete committed file content. */
  content: string
}

/**
 * Record one scenario's generated content for a shared snapshot source.
 * A later claimant must generate identical bytes; otherwise record/refresh
 * would make the final file depend on scenario order.
 *
 * @param claims Claims already made in this suite run, keyed by source path.
 * @param source The shared snapshot path being claimed.
 * @param scenario The scenario generating the content.
 * @param content The complete content the scenario generated.
 * @returns Nothing.
 */
export function claimSharedSnapshot(
  claims: Map<string, SharedSnapshotClaim>,
  source: string,
  scenario: string,
  content: string,
): void {
  const previous = claims.get(source)
  if (previous !== undefined && previous.content !== content) {
    throw new Error(
      `acp-snapshot: shared snapshot ${source} diverged between ${previous.scenario} and ${scenario}`,
    )
  }
  if (previous === undefined) claims.set(source, { scenario, content })
}

/**
 * Reject byte-identical committed snapshots stored under different paths.
 *
 * @param kind Human-readable snapshot kind for the diagnostic.
 * @param snapshots The committed files to compare.
 * @returns Nothing.
 */
export function assertUniqueSnapshotContents(
  kind: string,
  snapshots: readonly NamedSnapshotContent[],
): void {
  const firstPathByContent = new Map<string, string>()
  for (const snapshot of snapshots) {
    const firstPath = firstPathByContent.get(snapshot.content)
    if (firstPath !== undefined) {
      throw new Error(
        `acp-snapshot: identical ${kind} snapshots appear in ${firstPath} and ${snapshot.path}; reuse one source`,
      )
    }
    firstPathByContent.set(snapshot.content, snapshot.path)
  }
}

/**
 * Validate and order a scenario directory's session-fixture filenames.
 *
 * The primary fixture is always `session.jsonl`; child sessions are discovered
 * from contiguous `session.1.jsonl` … filenames. The directory is the source of
 * truth, so scenario tables do not duplicate a child count that can drift from
 * the files. A session-like JSONL with any other suffix fails loud.
 *
 * @param names File names in one scenario directory.
 * @returns The primary and child fixture names in replay/harvest order.
 */
export function sessionFixtureNames(names: readonly string[]): string[] {
  if (!names.includes('session.jsonl')) throw new Error('missing session.jsonl')
  const children: { name: string; index: number }[] = []
  for (const name of names) {
    if (name === 'session.jsonl') continue
    if (!name.startsWith('session.') || !name.endsWith('.jsonl')) continue
    const match = /^session\.([1-9]\d*)\.jsonl$/.exec(name)
    if (match === null) throw new Error(`invalid child session fixture name: ${name}`)
    children.push({ name, index: Number(match[1]) })
  }
  children.sort((a, b) => a.index - b.index)
  for (const [offset, child] of children.entries()) {
    const expected = offset + 1
    if (child.index !== expected) {
      throw new Error(`child session fixtures must be contiguous: expected session.${expected}.jsonl, found ${child.name}`)
    }
  }
  return ['session.jsonl', ...children.map(child => child.name)]
}

/**
 * Derive normalization values from a fixture's own session header. Recorded ids and cwd differ
 * from the live replay run; the non-empty sentinel for missing cwd avoids accidental empty-
 * string replacement.
 *
 * @param fixture The committed `session.jsonl` content.
 * @returns The fixture's own volatile values, ready for {@link normalizeSessionLog}.
 */
export function fixtureContext(fixture: string): NormalizeContext {
  const firstLine = fixture.split('\n').find(line => line.trim().length > 0) ?? '{}'
  const header = JSON.parse(firstLine) as { id?: unknown; cwd?: unknown }
  return {
    sessionIds: typeof header.id === 'string' ? [header.id] : [],
    cwd: typeof header.cwd === 'string' ? header.cwd : '\0no-cwd\0',
  }
}

interface NormalizedHeaderEvent {
  readonly header: unknown
  readonly reason: unknown
}

/** Normalize request-header payloads while retaining the reason that selects a pin revision. */
function normalizedHeaderEvents(rawLog: string, ctx: NormalizeContext): NormalizedHeaderEvent[] {
  return normalizeSessionLog(rawLog, ctx)
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as {
      type?: unknown
      data?: { header?: unknown; reason?: unknown }
    })
    .filter(record => record.type === 'request/header')
    .map(record => ({ header: record.data?.header, reason: record.data?.reason }))
}

/** Extract every string system prompt from a normalized header sequence. */
function systemPromptsFrom(headers: readonly unknown[]): string[] {
  return headers.flatMap((header) => {
    if (header === null || typeof header !== 'object') return []
    const system = (header as { system?: unknown }).system
    return typeof system === 'string' ? [system] : []
  })
}

/** Extract every array-valued tool catalog from a normalized header sequence. */
function toolSchemasFrom(headers: readonly unknown[]): unknown[][] {
  return headers.flatMap((header) => {
    if (header === null || typeof header !== 'object') return []
    const tools = (header as { tools?: unknown }).tools
    return Array.isArray(tools) ? [tools] : []
  })
}

/**
 * The `data.header` payload of every `request/header` event in a session
 * JSONL, in log order, with the log's volatile values scrubbed first
 * ({@link normalizeSessionLog}) so headers harvested from different runs —
 * each embedding its own generated cwd in the composed prompt — compare on equal
 * footing.
 *
 * @param rawLog The session `.jsonl` content to extract headers from.
 * @param ctx The volatile values of the run that produced it.
 * @returns The normalized `data.header` payloads, in log order.
 */
export function normalizedHeaders(rawLog: string, ctx: NormalizeContext): unknown[] {
  return normalizedHeaderEvents(rawLog, ctx).map(event => event.header)
}

/**
 * The normalized string-valued system prompts carried by request headers in a
 * session JSONL, in log order. Headers without a string prompt are omitted so
 * callers can assert one prompt per header explicitly.
 *
 * @param rawLog The session `.jsonl` content to inspect.
 * @param ctx The volatile values of the run that produced it.
 * @returns The normalized system prompts, in header order.
 */
export function normalizedSystemPrompts(rawLog: string, ctx: NormalizeContext): string[] {
  return systemPromptsFrom(normalizedHeaders(rawLog, ctx))
}

/**
 * The normalized tool-schema arrays carried by request headers in a session
 * JSONL, in log order. Headers without an array-valued tools field are omitted
 * so callers can assert one schema set per header explicitly.
 *
 * @param rawLog The session `.jsonl` content to inspect.
 * @param ctx The volatile values of the run that produced it.
 * @returns The normalized initial tool-schema arrays, in header order.
 */
export function normalizedToolSchemas(rawLog: string, ctx: NormalizeContext): unknown[][] {
  return toolSchemasFrom(normalizedHeaders(rawLog, ctx))
}

/** The structured contents of a tool-schema sidecar. */
export interface ToolSchemasSnapshot {
  /** The complete tool schemas from the pinned request header. */
  initial: unknown[]
  /** Complete tool schemas from subsequent changed-header snapshots. */
  changes: unknown[][]
}

/**
 * Render the full tool-schema sequence as canonical, readable JSON.
 *
 * @param initial The pinned request header's complete tool schemas.
 * @param changes Complete tool schemas from later changed headers.
 * @returns A pretty-printed JSON snapshot ending in one newline.
 */
export function formatToolSchemasSnapshot(initial: readonly unknown[], changes: readonly unknown[][] = []): string {
  return `${JSON.stringify({ initial, changes }, null, 2)}\n`
}

/**
 * Parse and validate the stable top-level fields of a tool-schema sidecar.
 *
 * @param snapshot The JSON sidecar text.
 * @returns Its initial and changed-header schema sets.
 */
export function parseToolSchemasSnapshot(snapshot: string): ToolSchemasSnapshot {
  const parsed = JSON.parse(snapshot) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('acp-snapshot: tool-schema snapshot must be an object')
  }
  const { initial, changes } = parsed as { initial?: unknown; changes?: unknown }
  if (!Array.isArray(initial) || !Array.isArray(changes) || !changes.every(Array.isArray)) {
    throw new Error('acp-snapshot: tool-schema snapshot must carry array-valued initial and changes fields')
  }
  return { initial, changes }
}

/**
 * Restore one sidecar schema set into a tokenized pinned header.
 *
 * @param header The parsed request header carrying `tools: "{{tools}}"`.
 * @param schemas The complete schemas for this full header snapshot.
 * @returns A copy of the header with its complete schemas restored.
 */
export function restorePinnedToolSchemas(header: unknown, schemas: readonly unknown[]): unknown {
  if (header === null || typeof header !== 'object' || Array.isArray(header)) {
    throw new Error('acp-snapshot: pinned request header must be an object')
  }
  if ((header as { tools?: unknown }).tools !== TOOLS_TOKEN) {
    throw new Error(`acp-snapshot: pinned request header tools must equal ${TOOLS_TOKEN}`)
  }
  return { ...header, tools: schemas }
}

/**
 * Render a normalized prompt as a repository-friendly Markdown snapshot.
 * Prompt text is unchanged except that a missing terminal newline is added so
 * the committed file follows the repository newline contract.
 *
 * @param prompt The normalized system prompt.
 * @param changes Full normalized prompts from later changed-header snapshots.
 * @returns Markdown snapshot text ending in a newline.
 */
export function formatSystemPromptSnapshot(
  prompt: string,
  changes: readonly string[] = [],
): string {
  let snapshot = prompt.endsWith('\n') ? prompt : `${prompt}\n`
  for (const [index, change] of changes.entries()) {
    snapshot += `\n<!-- request/header change ${index + 1} -->\n\n`
    snapshot += change.endsWith('\n') ? change : `${change}\n`
  }
  return snapshot
}

/**
 * Reject a child prompt sidecar that cannot own distinct, canonical prompt text.
 * @param sidecar - committed child prompt snapshot.
 * @param classPin - initial prompt snapshot owned by the scenario's header class.
 * @param label - repository-relative fixture label for diagnostics.
 */
export function assertChildSystemPromptSnapshot(sidecar: string, classPin: string, label: string): void {
  if (sidecar.trim().length === 0) throw new Error(`${label} must pin a non-empty prompt`)
  if (!sidecar.endsWith('\n')) throw new Error(`${label} must end in a newline`)
  if (sidecar === classPin) throw new Error(`${label} must differ from its class pin`)
}

/**
 * Count changed `request/header` snapshots in a session JSONL.
 *
 * @param rawLog The session `.jsonl` content.
 * @returns How many headers carry reason `change`.
 */
export function headerChangeCount(rawLog: string): number {
  return rawLog.split('\n')
    .filter(line => line.trim().length > 0)
    .filter((line) => {
      const record = JSON.parse(line) as { type?: unknown; data?: { reason?: unknown } }
      return record.type === 'request/header' && record.data?.reason === 'change'
    })
    .length
}

/** A literal replacement from a fresh replay-run volatile to its existing fixture value. */
export interface FixtureReplacement {
  /** The fresh replay run's volatile value. */
  from: string
  /** The existing fixture value retained during write-back. */
  to: string
}

function parseJsonlRecords(text: string): Record<string, unknown>[] {
  return text.split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

/** Narrow one parsed value to the complete identified-message shape retained by fixtures. */
function completeMessage(value: unknown): Record<string, unknown> | undefined {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || !UUID_RE.test(value.id)
    || typeof value.role !== 'string'
    || !Array.isArray(value.content)
    || !isRecord(value.source)
  ) return undefined
  return value
}

/** Return the complete identified message carried by one surface event. */
function surfaceEventMessage(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const type = record.type
  if (typeof type !== 'string' || !isSurfaceEligibleType(type)) return undefined
  const data = record.data
  if (!isRecord(data)) return undefined
  let message: unknown
  switch (type) {
    case 'user/message':
      message = data
      break
    case 'assistant/message':
    case 'tool/result':
      message = data.message
      break
    /* v8 ignore next -- the authoritative predicate must fail loud when a new surface shape lands. */
    default: throw new Error(`acp-snapshot: unsupported surface event type "${type}"`)
  }
  return completeMessage(message)
}

/** Return complete message identities structurally owned by one durable record. */
function recordMessages(record: Record<string, unknown>): Record<string, unknown>[] {
  const surfaceMessage = surfaceEventMessage(record)
  if (surfaceMessage !== undefined) return [surfaceMessage]
  if (record.type !== 'agent/inbox/spliced' || !isRecord(record.data) || !Array.isArray(record.data.inserted)) {
    return []
  }
  return record.data.inserted.flatMap((value) => {
    const message = completeMessage(value)
    return message === undefined ? [] : [message]
  })
}

/** Serialize parsed JSON by value rather than insertion order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Index identity-free message values whose ID and fingerprint are mutually unique. */
function uniqueMessageIds(logs: readonly string[]): Map<string, string> {
  const fingerprintsById = new Map<string, Set<string>>()
  const idsByFingerprint = new Map<string, Set<string>>()
  for (const log of logs) {
    for (const record of parseJsonlRecords(log)) {
      for (const message of recordMessages(record)) {
        const { id, ...withoutId } = message
        const messageId = id as string
        const fingerprint = canonicalJson(withoutId)
        const fingerprints = fingerprintsById.get(messageId)
        if (fingerprints === undefined) fingerprintsById.set(messageId, new Set([fingerprint]))
        else fingerprints.add(fingerprint)
        const ids = idsByFingerprint.get(fingerprint)
        if (ids === undefined) idsByFingerprint.set(fingerprint, new Set([messageId]))
        else ids.add(messageId)
      }
    }
  }

  const unique = new Map<string, string>()
  for (const [id, fingerprints] of fingerprintsById) {
    if (fingerprints.size !== 1) continue
    const fingerprint = fingerprints.values().next().value as string
    if (idsByFingerprint.get(fingerprint)?.size !== 1) continue
    unique.set(fingerprint, id)
  }
  return unique
}

/**
 * Match unchanged complete messages across a scenario's fresh and existing logs.
 * New, changed, duplicate-content, or otherwise ambiguous messages keep their fresh ids.
 */
function fixtureMessageIdReplacements(logs: readonly string[], fixtures: readonly string[]): Map<string, string> {
  const freshIds = uniqueMessageIds(logs)
  const existingIds = uniqueMessageIds(fixtures)
  const replacements = new Map<string, string>()
  for (const [fingerprint, fresh] of freshIds) {
    const existing = existingIds.get(fingerprint)
    if (existing === undefined || fresh === existing) continue
    replacements.set(fresh, existing)
  }
  return replacements
}

/** Apply literal fixture replacements without changing any other fresh value. */
function applyFixtureReplacements(content: string, replacements: readonly FixtureReplacement[]): string {
  let stable = content
  for (const { from, to } of replacements) stable = stable.split(from).join(to)
  return stable
}

/** Rewrite only validated durable-message ID fields, leaving every other occurrence untouched. */
function applyFixtureMessageIds(content: string, replacements: ReadonlyMap<string, string>): string {
  return content.split('\n').map((line) => {
    if (line.trim().length === 0) return line
    const record = JSON.parse(line) as Record<string, unknown>
    let changed = false
    for (const message of recordMessages(record)) {
      const replacement = replacements.get(message.id as string)
      if (replacement === undefined) continue
      message.id = replacement
      changed = true
    }
    return changed ? JSON.stringify(record) : line
  }).join('\n')
}

/**
 * Carry committed UUIDs into unchanged, unambiguous messages in fresh session fixtures.
 *
 * @param logs Fresh fixture-ready session JSONL contents for one scenario.
 * @param fixtures Existing fixture contents in matching order; missing fixtures may be empty strings.
 * @returns The fresh contents with only reusable message UUIDs replaced.
 */
export function stabilizeFixtureMessageIds(logs: readonly string[], fixtures: readonly string[]): string[] {
  const replacements = fixtureMessageIdReplacements(logs, fixtures)
  return logs.map(log => applyFixtureMessageIds(log, replacements))
}

/** One packed row's member times, or `undefined` for an ordinary record. */
function packedTimes(record: Record<string, unknown>): number[] | undefined {
  if (!PACKED_CHUNK_ROW_TYPES.has(record.type as string)) return undefined
  const row = record as unknown as { time0?: number; data: { dt: number[] } }
  const times = [row.time0 ?? 0]
  for (const gap of row.data.dt) times.push((times[times.length - 1] as number) + gap)
  return times
}

/** Expand packed timing envelopes so refresh alignment follows logical events, not physical lines. */
function logicalRecords(records: Record<string, unknown>[]): Record<string, unknown>[] {
  return records.flatMap((record) => {
    const times = packedTimes(record)
    return times === undefined ? [record] : times.map(time => ({ type: 'assistant/chunk', time }))
  })
}

/**
 * Find tool calls whose structured result reports `UNKNOWN_TOOL`.
 *
 * Snapshot refresh must not turn a missing registration into accepted behavior;
 * intentional unknown-tool behavior belongs in a focused unit or e2e test.
 *
 * @param rawLog The session JSONL to inspect.
 * @returns The failing call ids in log order, using a diagnostic placeholder when absent.
 */
export function unknownToolCallIds(rawLog: string): string[] {
  return parseJsonlRecords(rawLog).flatMap((record) => {
    if (record.type !== 'tool/result') return []
    const data = record.data
    if (data === null || typeof data !== 'object') return []
    const { message, error } = data as { message?: unknown; error?: unknown }
    if (error === null || typeof error !== 'object') return []
    if ((error as { code?: unknown }).code !== 'UNKNOWN_TOOL') return []
    const source = typeof message === 'object' && message !== null
      ? (message as { source?: unknown }).source
      : undefined
    const callId = typeof source === 'object' && source !== null
      ? (source as { callId?: unknown }).callId
      : undefined
    return [typeof callId === 'string' ? callId : '<missing callId>']
  })
}

/**
 * Build refresh write-back replacements for per-log session ids, cwd values,
 * and spill paths. Durable message ids have a later structural owner.
 *
 * @param logs The freshly harvested logs, in fixture order.
 * @param fixtures The existing fixture contents, in matching order.
 * @returns Literal replacements from fresh values to the fixture's existing values.
 */
export function refreshFixtureReplacements(logs: HarvestedLog[], fixtures: string[]): FixtureReplacement[] {
  const replacements: FixtureReplacement[] = []
  for (let i = 0; i < logs.length; i++) {
    const fresh = parseJsonlRecords((logs[i] as HarvestedLog).content)[0]
    const existing = parseJsonlRecords(fixtures[i] ?? '')[0]
    for (const field of ['id', 'cwd'] as const) {
      const from = fresh?.[field]
      const to = existing?.[field]
      if (typeof from === 'string' && typeof to === 'string' && from.length > 0 && from !== to) {
        replacements.push({ from, to })
      }
    }
    // Stabilize snapshot spill paths: match by filename suffix so the raw
    // fixture does not churn on every refresh from a different session run.
    const freshSpills = extractSnapshotSpillPaths((logs[i] as HarvestedLog).content)
    const existingSpills = extractSnapshotSpillPaths(fixtures[i] ?? '')
    for (const [name, existingPath] of existingSpills) {
      const freshPath = freshSpills.get(name)
      if (freshPath !== undefined && freshPath !== existingPath) {
        replacements.push({ from: freshPath, to: existingPath })
      }
    }
  }
  return replacements
}

function preserveFixtureVolatiles(record: Record<string, unknown>, existing: Record<string, unknown> | undefined): void {
  if (existing === undefined || existing.type !== record.type) return
  if (record.type === 'session') {
    for (const field of ['id', 'createdAt', 'cwd', 'parentSession'] as const) {
      if (field in record && field in existing) record[field] = existing[field]
    }
    return
  }
  if ('time' in record && 'time' in existing) record.time = existing.time
  if (record.type !== 'hook/result') return
  const data = record.data
  const existingData = existing.data
  if (
    data !== null && typeof data === 'object'
    && existingData !== null && typeof existingData === 'object'
    && 'durationMs' in data && 'durationMs' in existingData
  ) {
    (data as Record<string, unknown>).durationMs = (existingData as Record<string, unknown>).durationMs
  }
}

/** Carry logical member times into a fresh packed row while leaving its fragment arrays untouched. */
function preservePackedMemberTimes(
  record: Record<string, unknown>,
  existingMembers: Record<string, unknown>[],
): void {
  if (!PACKED_CHUNK_ROW_TYPES.has(record.type as string)) return
  const row = record as unknown as { time0: number; data: { dt: number[] } }
  const firstTime = existingMembers[0]?.time
  if (!Number.isSafeInteger(firstTime)) return
  row.time0 = firstTime as number
  if (existingMembers.length !== row.data.dt.length + 1) return
  const times = existingMembers.map(member => Number.isSafeInteger(member.time) ? member.time as number : undefined)
  if (times.some(time => time === undefined)) return
  const memberTimes = times as number[]
  const gaps = memberTimes.slice(1).map((time, index) => time - (memberTimes[index] as number))
  if (gaps.some(gap => !Number.isSafeInteger(gap))) return
  row.data.dt = gaps
}

/** Whether a parsed JSON value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Reuse existing leaves whose normalized values equal the fresh values.
 * Objects merge by key; arrays merge only when their positions still align.
 */
function preserveNormalizedVolatiles(
  fresh: unknown,
  existing: unknown,
  normalizedFresh: unknown,
  normalizedExisting: unknown,
  stringMappings: ReadonlyMap<string, string>,
): unknown {
  if (
    Array.isArray(fresh)
    && Array.isArray(existing)
    && Array.isArray(normalizedFresh)
    && Array.isArray(normalizedExisting)
  ) {
    if (
      fresh.length !== existing.length
      || fresh.length !== normalizedFresh.length
      || fresh.length !== normalizedExisting.length
    ) return fresh
    return fresh.map((value, index) => preserveNormalizedVolatiles(
      value,
      existing[index],
      normalizedFresh[index],
      normalizedExisting[index],
      stringMappings,
    ))
  }
  if (
    isRecord(fresh)
    && isRecord(existing)
    && isRecord(normalizedFresh)
    && isRecord(normalizedExisting)
  ) {
    return Object.fromEntries(Object.entries(fresh).map(([key, value]) => [
      key,
      Object.hasOwn(existing, key)
        && Object.hasOwn(normalizedFresh, key)
        && Object.hasOwn(normalizedExisting, key)
        ? preserveNormalizedVolatiles(
          value,
          existing[key],
          normalizedFresh[key],
          normalizedExisting[key],
          stringMappings,
        )
        : value,
    ]))
  }
  if (
    typeof fresh === 'string'
    && typeof existing === 'string'
    && typeof normalizedFresh === 'string'
    && normalizedFresh === normalizedExisting
  ) {
    return stringMappings.get(JSON.stringify([normalizedFresh, fresh])) === existing
      ? existing
      : fresh
  }
  return Object.is(normalizedFresh, normalizedExisting) ? existing : fresh
}

/** Normalize one aligned record with the same contract used by fixture comparison. */
function normalizedRefreshRecord(
  record: Record<string, unknown>,
  context: NormalizeContext,
): Record<string, unknown> {
  return JSON.parse(normalizeSessionLog(`${JSON.stringify(record)}\n`, context)) as Record<string, unknown>
}

/**
 * Add normalized-equivalent string replacements to a bijection.
 * Structural differences are fresh-owned and therefore contribute no mapping.
 */
function collectNormalizedStringMappings(
  fresh: unknown,
  existing: unknown,
  normalizedFresh: unknown,
  normalizedExisting: unknown,
  excludedStrings: ReadonlySet<string>,
  forward: Map<string, string>,
  reverse: Map<string, string>,
): boolean {
  if (
    Array.isArray(fresh)
    && Array.isArray(existing)
    && Array.isArray(normalizedFresh)
    && Array.isArray(normalizedExisting)
  ) {
    if (
      fresh.length !== existing.length
      || fresh.length !== normalizedFresh.length
      || fresh.length !== normalizedExisting.length
    ) return true
    return fresh.every((value, index) => collectNormalizedStringMappings(
      value,
      existing[index],
      normalizedFresh[index],
      normalizedExisting[index],
      excludedStrings,
      forward,
      reverse,
    ))
  }
  if (
    isRecord(fresh)
    && isRecord(existing)
    && isRecord(normalizedFresh)
    && isRecord(normalizedExisting)
  ) {
    return Object.entries(fresh).every(([key, value]) =>
      !Object.hasOwn(existing, key)
      || !Object.hasOwn(normalizedFresh, key)
      || !Object.hasOwn(normalizedExisting, key)
      || collectNormalizedStringMappings(
        value,
        existing[key],
        normalizedFresh[key],
        normalizedExisting[key],
        excludedStrings,
        forward,
        reverse,
      ))
  }
  if (
    typeof fresh !== 'string'
    || typeof existing !== 'string'
    || typeof normalizedFresh !== 'string'
    || normalizedFresh !== normalizedExisting
    || fresh === existing
    || excludedStrings.has(fresh)
    || excludedStrings.has(existing)
  ) return true
  const freshKey = JSON.stringify([normalizedFresh, fresh])
  const existingKey = JSON.stringify([normalizedFresh, existing])
  const mappedExisting = forward.get(freshKey)
  const mappedFresh = reverse.get(existingKey)
  if (
    mappedExisting !== undefined && mappedExisting !== existing
    || mappedFresh !== undefined && mappedFresh !== fresh
  ) return false
  forward.set(freshKey, existing)
  reverse.set(existingKey, fresh)
  return true
}

/**
 * Build a log-wide bijection for normalized-equivalent strings.
 * Any unexplained record mismatch or conflicting replacement disables reuse.
 */
function normalizedStringMappings(
  records: Record<string, unknown>[],
  freshRecords: Record<string, unknown>[],
  existingRecords: Record<string, unknown>[],
  freshContext: NormalizeContext,
  existingContext: NormalizeContext,
): Map<string, string> | undefined {
  const excludedStrings = new Set<string>()
  for (const record of [...freshRecords, ...existingRecords]) {
    for (const message of recordMessages(record)) excludedStrings.add(message.id as string)
  }
  const forward = new Map<string, string>()
  const reverse = new Map<string, string>()
  let existingIndex = 0
  for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
    const record = records[recordIndex] as Record<string, unknown>
    const existingRecord = existingRecords[existingIndex]
    const memberCount = packedTimes(record)?.length ?? 1
    if (record.type === 'session/title' && existingRecord?.type !== 'session/title') continue
    if (memberCount > 1) {
      const existingMembers = existingRecords.slice(existingIndex, existingIndex + memberCount)
      if (
        existingMembers.length !== memberCount
        || existingMembers.some(member => member.type !== 'assistant/chunk')
      ) return undefined
    } else {
      if (existingRecord === undefined || existingRecord.type !== record.type) return undefined
      if (!collectNormalizedStringMappings(
        record,
        existingRecord,
        normalizedRefreshRecord(freshRecords[recordIndex] as Record<string, unknown>, freshContext),
        normalizedRefreshRecord(existingRecord, existingContext),
        excludedStrings,
        forward,
        reverse,
      )) return undefined
    }
    existingIndex += memberCount
  }
  return existingIndex === existingRecords.length ? forward : undefined
}

/**
 * Rewrite a fresh replay-produced log so repeated refreshes do not churn
 * volatile fixture fields. Meaningful event payloads come from `fresh`; the
 * existing fixture lends normalized-equivalent values, including non-message ids, paths,
 * creation/event times, spill locators, and hook durations, only when the
 * complete record layout aligns and volatile strings form a consistent
 * bijection. Complete durable-message ids are excluded because the later
 * fixture-ready structural pass owns them. Ambiguous layouts or mappings
 * keep fresh strings. Packed timing gaps expand from zero when a projected
 * fixture omits `time0`, so packing does not shift later records;
 * fresh semantic values and fragment arrays remain authoritative.
 *
 * @param fresh The newly harvested session JSONL.
 * @param existing The committed fixture JSONL being refreshed.
 * @param replacements Cross-log literal replacements from {@link refreshFixtureReplacements}.
 * @param freshContext The harvested run's ids, cwd, and every cwd alias.
 * @returns The stabilized JSONL content to write back.
 */
export function stabilizeRefreshLog(
  fresh: string,
  existing: string,
  replacements: FixtureReplacement[],
  freshContext: NormalizeContext,
): string {
  const freshRecords = parseJsonlRecords(fresh)
  const stable = applyFixtureReplacements(fresh, replacements)
  const existingRecords = logicalRecords(parseJsonlRecords(existing))
  const records = parseJsonlRecords(stable)
  const existingContext = fixtureContext(existing)
  const stringMappings = normalizedStringMappings(
    records,
    freshRecords,
    existingRecords,
    freshContext,
    existingContext,
  )
  let existingIndex = 0
  let previousEventTime: unknown
  for (let i = 0; i < records.length; i++) {
    let record = records[i] as Record<string, unknown>
    const existingRecord = existingRecords[existingIndex]
    const memberCount = packedTimes(record)?.length ?? 1
    const insertedTitle = record.type === 'session/title' && existingRecord?.type !== 'session/title'
    if (insertedTitle) {
      /* v8 ignore next -- a title is turn-enclosed, so a preceding event time exists in every valid fixture. */
      if (typeof previousEventTime !== 'number') throw new Error('acp-snapshot: inserted title has no preceding event time')
      record.time = previousEventTime
    } else {
      if (
        stringMappings !== undefined
        && memberCount === 1
        && existingRecord !== undefined
        && existingRecord.type === record.type
      ) {
        record = preserveNormalizedVolatiles(
          record,
          existingRecord,
          normalizedRefreshRecord(freshRecords[i] as Record<string, unknown>, freshContext),
          normalizedRefreshRecord(existingRecord, existingContext),
          stringMappings,
        ) as Record<string, unknown>
        records[i] = record
      }
      preservePackedMemberTimes(record, existingRecords.slice(existingIndex, existingIndex + memberCount))
      preserveFixtureVolatiles(record, existingRecord)
      existingIndex += memberCount
    }
    if (typeof record.time === 'number') previousEventTime = record.time
  }
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}
