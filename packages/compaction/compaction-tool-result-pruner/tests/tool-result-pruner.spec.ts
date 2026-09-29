import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId , createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  Session,
  SessionId,
} from '@deepseek-ai/dsh-session'
import type { SurfaceEvent } from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner, {
  codePointLength,
  DEFAULTS,
  PRUNE_MARKER,
  resolveConfig,
  spillMarker,
} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type { ToolResultPruneConfig } from '@deepseek-ai/dsh-compaction-tool-result-pruner'

const MODEL = 'test-model'
/** Tiny budgets with both pressure safeguards off, so each result is judged alone. */
const SMALL: ToolResultPruneConfig = {
  thresholdChars: 50,
  headChars: 4,
  tailChars: 3,
  protectRecentResults: 0,
  minTokensSaved: 0,
}
/** Room for a spill marker naming {@link LOCATOR} beside a small head and tail. */
const ROOMY: ToolResultPruneConfig = { ...SMALL, thresholdChars: 400, headChars: 20, tailChars: 10 }
const LOCATOR = '/spill/session/bash-1.txt'
const HINT = 'Use read with offset/limit, or grep this path to search within it.'

/** In-memory spill backend recording every save; `onSave` runs before the save settles. */
class RecordingSpillStore extends SpillStore {
  readonly saves: SaveTextSpill[] = []
  onSave: (input: SaveTextSpill) => void = () => {}

  override saveText(input: SaveTextSpill): Promise<SpillRef> {
    this.saves.push(input)
    this.onSave(input)
    return Promise.resolve({ locator: SpillLocator(LOCATOR), bytes: input.content.length, retrievalHint: HINT })
  }
}

function context(): Context {
  const ctx = new Context()
  // Service constructors self-register, so `ctx.tokenMeter` resolves for the
  // shadow-price pricing without a full plugin boot.
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  return ctx
}

function service(config: ToolResultPruneConfig = SMALL): ToolResultPruner {
  return new ToolResultPruner(context(), config)
}

function textOfResult(session: Session, seq: number): string {
  const event = session.events[seq]
  if (event?.type !== 'tool/result') throw new Error(`event ${seq} is not a tool/result`)
  return event.data.message.content[0].content
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** Pricing oracle mirroring the service's estimator for expectations. */
const METER_CTX = new Context()
new SessionProjectionRegistry(METER_CTX)
const METER = new TokenMeter(METER_CTX)

function appendToolStep(
  session: Session,
  turn: number,
  call: string,
  content: ContentBlock[],
  extra: Record<string, unknown> = {},
  logCall = true,
): number {
  const callId = ToolCallId(call)
  session.append('turn/start', {
    turn,
  })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
      source: {
        kind: 'model',
        ...{ provider: MODEL, model: MODEL },
      },
    }),
  }, { surfaceOp: 'append' })
  if (logCall) session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{}' })
  const result = session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId, content, isError: false }),
    ...extra,
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return result.seq
}

describe('tool-result pruning configuration', () => {
  it('resolves detached immutable defaults and partial overrides', () => {
    const raw = { thresholdChars: 100, headChars: 20, tailChars: 10, protectRecentResults: 2 }
    const resolved = resolveConfig(raw)
    raw.headChars = 1
    expect(resolved).toEqual({
      thresholdChars: 100,
      headChars: 20,
      tailChars: 10,
      protectRecentResults: 2,
      minTokensSaved: 20_000,
    })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(DEFAULTS).toEqual({
      thresholdChars: 8192,
      headChars: 4096,
      tailChars: 1024,
      protectRecentResults: 5,
      minTokensSaved: 20_000,
    })
    expect(Object.isFrozen(DEFAULTS)).toBe(true)
  })

  it('rejects stale keys, invalid scalars, and an output budget above threshold', () => {
    const bad = [
      [{ thresholdChars: 0 }, /thresholdChars .* positive integer/],
      [{ headChars: -1 }, /headChars .* non-negative integer/],
      [{ tailChars: 1.5 }, /tailChars .* non-negative integer/],
      [{ protectRecentResults: -1 }, /protectRecentResults .* non-negative integer/],
      [{ minTokensSaved: 0.5 }, /minTokensSaved .* non-negative integer/],
      [{ thresholdChars: 50, headChars: 20, tailChars: 20 }, /headChars \+ marker \+ tailChars/],
      [{ threshold: 10 }, /unknown key "threshold"/],
    ] as Array<[unknown, RegExp]>
    for (const [config, pattern] of bad) {
      expect(() => resolveConfig(config as ToolResultPruneConfig)).toThrow(pattern)
    }
  })
})

describe('ToolResultPruner content transform', () => {
  it('measures text code points only and skips content within threshold', () => {
    const prune = service()
    const blocks = [
      { type: 'text', text: 'a😀b' },
      { type: 'reasoning', text: 'not measured' },
    ] satisfies ContentBlock[]
    expect(prune.measureContent(blocks)).toBe(3)
    expect(prune.pruneContent(blocks)).toBeNull()
    expect(codePointLength('a😀b')).toBe(3)
  })

  it('keeps configured head and tail without splitting surrogate pairs', () => {
    const prune = service()
    const result = prune.pruneContent([{ type: 'text', text: '😀'.repeat(60) }])
    expect(result).toEqual([{
      type: 'text',
      text: `${'😀'.repeat(4)}${PRUNE_MARKER}${'😀'.repeat(3)}`,
    }])
    expect(prune.measureContent(result!)).toBeLessThanOrEqual(50)
    expect(result![0]).toMatchObject({ type: 'text' })
    expect((result![0] as { text: string }).text).not.toContain('\uFFFD')
  })

  it('preserves non-text blocks and their relative ordering across removed text', () => {
    const prune = service()
    const reasoning: ContentBlock = { type: 'reasoning', text: 'private-rich-block' }
    const call: ContentBlock = {
      type: 'tool-call',
      id: ToolCallId('nested'),
      name: 'nested',
      arguments: '{}',
    }
    const result = prune.pruneContent([
      { type: 'text', text: 'A'.repeat(40) },
      reasoning,
      { type: 'text', text: 'B'.repeat(30) },
      call,
      { type: 'text', text: 'C'.repeat(30) },
    ])
    expect(result).toEqual([
      { type: 'text', text: `AAAA${PRUNE_MARKER}` },
      reasoning,
      call,
      { type: 'text', text: 'CCC' },
    ])
    expect(prune.measureContent(result!)).toBeLessThanOrEqual(50)
  })

  it('supports zero-sized head and tail while still shrinking', () => {
    const prune = service({
      thresholdChars: codePointLength(PRUNE_MARKER),
      headChars: 0,
      tailChars: 0,
    })
    const result = prune.pruneContent([{ type: 'text', text: 'x'.repeat(100) }])
    expect(result).toEqual([{ type: 'text', text: PRUNE_MARKER }])
    expect(prune.measureContent(result!)).toBe(prune.config.thresholdChars)
  })
})

describe('ToolResultPruner session transaction', () => {
  it('prunes a stable snapshot, preserves all data, and cites the replaced result', async () => {
    const session = Session.create(SessionId('preserve'))
    const originalSeq = appendToolStep(session, 1, 'one', [{
      type: 'text',
      text: 'x'.repeat(100),
    }], {
      isError: true,
      error: { name: 'ExitError', code: 'EXIT_1' },
      meta: { diff: ['a', 'b'] },
      futureField: { nested: true },
    })
    session.append('turn/start', {
      turn: 2,
    })

    const result = await service().pruneSession(session, 'pressure')
    expect(result.pruned).toHaveLength(1)
    expect(result.charsRemoved).toBeGreaterThan(0)
    const entry = result.pruned[0]!
    expect(entry).toMatchObject({ originalSeq, callId: ToolCallId('one'), charsBefore: 100 })
    expect(entry.charsAfter).toBeLessThanOrEqual(50)

    const original = session.events[originalSeq]!
    const replacement = session.events[entry.replacementSeq]! as SurfaceEvent
    expect(original).toMatchObject({
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result',
            content: [{ type: 'text', text: 'x'.repeat(100) }],
          }],
        },
      },
    })
    expect(replacement).toMatchObject({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        isError: true,
        message: {
          source: { kind: 'tool', callId: ToolCallId('one') },
        },
        error: { name: 'ExitError', code: 'EXIT_1' },
        meta: { diff: ['a', 'b'] },
        futureField: { nested: true },
      },
      surfaceOp: { op: 'replace', start: originalSeq, end: originalSeq },
      sourceEventSeqs: [originalSeq],
    })
    expect(session.surface.nodes).not.toContain(originalSeq)

    // Shadow-price protocol: the metering event sits directly before the
    // replacement and prices the shadowed node with the shared estimator.
    if (original.type !== 'tool/result') throw new Error('original is not a tool/result')
    expect(session.events[entry.replacementSeq - 1]).toMatchObject({
      type: 'compaction/prune',
      data: {
        shadowedRange: { start: originalSeq, end: originalSeq },
        shadowedSeqs: [originalSeq],
        shadowedTokenCount: METER.estimateMessage(original.data.message),
      },
    })
  })

  it('prunes multiple results, skips short ones, and converges in one pass', async () => {
    const session = Session.create(SessionId('multiple'))
    appendToolStep(session, 1, 'a', [{ type: 'text', text: 'A'.repeat(100) }])
    appendToolStep(session, 2, 'b', [{ type: 'text', text: 'short' }])
    appendToolStep(session, 3, 'c', [{ type: 'text', text: 'C'.repeat(80) }])
    session.append('turn/start', {
      turn: 4,
    })
    const prune = service()
    const first = await prune.pruneSession(session, 'pressure')
    const second = await prune.pruneSession(session, 'pressure')
    expect(first.pruned.map(entry => entry.callId)).toEqual([ToolCallId('a'), ToolCallId('c')])
    expect(first.charsRemoved).toBe(
      first.pruned.reduce((sum, entry) => sum + entry.charsBefore - entry.charsAfter, 0),
    )
    expect(second).toEqual({ pruned: [], charsRemoved: 0 })
  })

  it('replays to the identical pruned model messages', async () => {
    const session = Session.create(SessionId('replay'))
    appendToolStep(session, 1, 'a', [{ type: 'text', text: 'A'.repeat(100) }])
    session.append('turn/start', {
      turn: 2,
    })
    await service().pruneSession(session, 'pressure')
    const replay = Session.create(session.id, [...session.events])
    expect(replay.deriveMessages()).toEqual(session.deriveMessages())
    expect(replay.surface.replaceGeneration).toBe(session.surface.replaceGeneration)
  })

  it('runs under real invariants between closed steps but not outside a turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(SessionInvariant)
    await ctx.plugin(TokenMeter)
    const prune = new ToolResultPruner(ctx, SMALL)
    const session = ctx.sessions.create(SessionId('invariants'))
    appendToolStep(session, 1, 'a', [{ type: 'text', text: 'A'.repeat(100) }])
    await expect(prune.pruneSession(session, 'pressure')).rejects.toThrow(/outside any open turn/)
    session.append('turn/start', {
      turn: 2,
    })
    await expect(prune.pruneSession(session, 'pressure')).resolves.toMatchObject({ pruned: [expect.anything()] })
  })
})

describe('ToolResultPruner pressure safeguards', () => {
  function twoOversizedResults(id: string): { session: Session; older: number; newer: number } {
    const session = Session.create(SessionId(id))
    const older = appendToolStep(session, 1, 'older', [{ type: 'text', text: 'O'.repeat(100) }])
    const newer = appendToolStep(session, 2, 'newer', [{ type: 'text', text: 'N'.repeat(100) }])
    session.append('turn/start', { turn: 3 })
    return { session, older, newer }
  }

  it('leaves the newest results intact under pressure but not on overflow', async () => {
    const protect = service({ ...SMALL, protectRecentResults: 1 })
    const pressured = twoOversizedResults('protect-pressure')
    const pressure = await protect.pruneSession(pressured.session, 'pressure')
    expect(pressure.pruned.map(entry => entry.originalSeq)).toEqual([pressured.older])
    expect(pressured.session.surface.nodes).toContain(pressured.newer)

    const overflowed = twoOversizedResults('protect-overflow')
    const overflow = await protect.pruneSession(overflowed.session, 'context-overflow')
    expect(overflow.pruned.map(entry => entry.originalSeq)).toEqual([overflowed.older, overflowed.newer])
  })

  it('counts every recent result, not only oversized ones, toward protection', async () => {
    const session = Session.create(SessionId('protect-counts-all'))
    const big = appendToolStep(session, 1, 'big', [{ type: 'text', text: 'B'.repeat(100) }])
    appendToolStep(session, 2, 'small', [{ type: 'text', text: 'ok' }])
    session.append('turn/start', { turn: 3 })
    const result = await service({ ...SMALL, protectRecentResults: 1 }).pruneSession(session, 'pressure')
    expect(result.pruned.map(entry => entry.originalSeq)).toEqual([big])
  })

  it('prunes nothing under pressure when the estimated gain is below minTokensSaved', async () => {
    const gated = service({ ...SMALL, minTokensSaved: 1_000_000 })
    const pressured = twoOversizedResults('gain-pressure')
    const eventsBefore = pressured.session.events.length
    expect(await gated.pruneSession(pressured.session, 'pressure')).toEqual({ pruned: [], charsRemoved: 0 })
    expect(pressured.session.events).toHaveLength(eventsBefore)

    const overflowed = twoOversizedResults('gain-overflow')
    expect((await gated.pruneSession(overflowed.session, 'context-overflow')).pruned).toHaveLength(2)
  })
})

describe('ToolResultPruner stored originals', () => {
  function storeAndService(config: ToolResultPruneConfig = ROOMY): {
    store: RecordingSpillStore
    prune: ToolResultPruner
    warnings: string[]
  } {
    const ctx = context()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    const store = new RecordingSpillStore(ctx)
    return { store, prune: new ToolResultPruner(ctx, config), warnings }
  }

  it('saves the full original and names it in the marker', async () => {
    const { store, prune } = storeAndService()
    const session = Session.create(SessionId('stored'))
    const original = `${'head '.repeat(20)}MIDDLE${' tail'.repeat(80)}`
    appendToolStep(session, 1, 'one', [{ type: 'text', text: original }])
    session.append('turn/start', { turn: 2 })

    const entry = (await prune.pruneSession(session, 'pressure')).pruned[0]!
    expect(entry.spillLocator).toBe(LOCATOR)
    expect(store.saves).toEqual([{
      owner: { sessionId: SessionId('stored') },
      source: { toolName: 'bash', callId: ToolCallId('one'), label: 'pruned-result' },
      suggestedName: 'bash.txt',
      content: original,
    }])
    const marker = spillMarker({ locator: SpillLocator(LOCATOR), bytes: original.length, retrievalHint: HINT })
    expect(marker).toBe(`\n\n[... tool result middle pruned. Full result stored at: ${LOCATOR}. ${HINT} ...]\n\n`)
    const text = textOfResult(session, entry.replacementSeq)
    expect(text).toBe(`${original.slice(0, 20)}${marker}${original.slice(-10)}`)
    expect(text).not.toContain('MIDDLE')
    expect(entry.charsAfter).toBeLessThanOrEqual(400)
  })

  it('falls back to the plain marker when the stored-copy marker exceeds the budget', async () => {
    const { store, prune } = storeAndService(SMALL)
    const session = Session.create(SessionId('stored-too-long'))
    appendToolStep(session, 1, 'one', [{ type: 'text', text: 'x'.repeat(100) }])
    session.append('turn/start', { turn: 2 })

    const entry = (await prune.pruneSession(session, 'pressure')).pruned[0]!
    expect(store.saves).toHaveLength(1)
    expect(entry.spillLocator).toBeUndefined()
    expect(textOfResult(session, entry.replacementSeq)).toBe(`xxxx${PRUNE_MARKER}xxx`)
  })

  it('prunes with the plain marker and warns when saving fails', async () => {
    const { store, prune, warnings } = storeAndService()
    store.saveText = () => Promise.reject(new Error('disk full'))
    const session = Session.create(SessionId('stored-failure'))
    appendToolStep(session, 1, 'one', [{ type: 'text', text: 'y'.repeat(500) }])
    session.append('turn/start', { turn: 2 })

    const entry = (await prune.pruneSession(session, 'pressure')).pruned[0]!
    expect(entry.spillLocator).toBeUndefined()
    expect(textOfResult(session, entry.replacementSeq)).toBe(`${'y'.repeat(20)}${PRUNE_MARKER}${'y'.repeat(10)}`)
    expect(warnings).toContainEqual(expect.stringMatching(/saving bash result one failed: Error: disk full/))
  })

  it('skips a result that left the surface while its original was being saved', async () => {
    const { store, prune } = storeAndService()
    const session = Session.create(SessionId('stored-race'))
    const raced = appendToolStep(session, 1, 'raced', [{ type: 'text', text: 'r'.repeat(500) }])
    const kept = appendToolStep(session, 2, 'kept', [{ type: 'text', text: 'k'.repeat(500) }])
    session.append('turn/start', { turn: 3 })
    store.onSave = (input) => {
      if (input.source.callId !== ToolCallId('raced')) return
      const event = session.events[raced]
      if (event?.type !== 'tool/result') throw new Error('raced result missing')
      session.append('tool/result', { ...event.data }, {
        surfaceOp: { op: 'replace', start: raced, end: raced },
        sourceEventSeqs: [raced],
      })
    }

    const result = await prune.pruneSession(session, 'pressure')
    expect(result.pruned.map(entry => entry.originalSeq)).toEqual([kept])
  })

  it('stores only the text of a result that mixes in non-text blocks', async () => {
    const { store, prune } = storeAndService()
    const session = Session.create(SessionId('stored-mixed'))
    const reasoning: ContentBlock = { type: 'reasoning', text: 'kept in place, not stored' }
    appendToolStep(session, 1, 'mixed', [
      { type: 'text', text: 'a'.repeat(300) },
      reasoning,
      { type: 'text', text: 'b'.repeat(300) },
    ])
    session.append('turn/start', { turn: 2 })

    const entry = (await prune.pruneSession(session, 'pressure')).pruned[0]!
    expect(store.saves[0]!.content).toBe(`${'a'.repeat(300)}${'b'.repeat(300)}`)
    const replacement = session.events[entry.replacementSeq]
    if (replacement?.type !== 'tool/result') throw new Error('replacement is not a tool/result')
    expect(replacement.data.message.content[0].content).toContainEqual(reasoning)
  })

  it('names the tool generically when the call event is absent', async () => {
    const { store, prune } = storeAndService()
    const session = Session.create(SessionId('stored-no-call'))
    appendToolStep(session, 1, 'orphan', [{ type: 'text', text: 'z'.repeat(500) }], {}, false)
    session.append('turn/start', { turn: 2 })

    await prune.pruneSession(session, 'pressure')
    expect(store.saves[0]).toMatchObject({ source: { toolName: 'tool' }, suggestedName: 'tool.txt' })
  })
})
