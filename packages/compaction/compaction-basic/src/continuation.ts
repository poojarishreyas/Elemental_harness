/**
 * Recovery context appended to a compaction checkpoint: where the condensed
 * conversation's full text is stored, and the current content of files the
 * model read in the condensed span.
 *
 * @module @deepseek-ai/dsh-compaction-basic/continuation
 */

import type { Context } from '@deepseek-ai/cordis'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: the optional `ctx.fs` and `ctx.spillStore` Context merges.
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-spill'
// Type-only: the `tool/code-dispatch` SessionEventMap merge.
import type {} from '@deepseek-ai/dsh-tools'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'

/** Limits on the files re-attached after a checkpoint. */
export interface RestoreLimits {
  /** Most recently read files to re-attach; `0` disables re-attachment. */
  readonly restoreFileCount: number
  /** Estimated-token cap for one re-attached file's content. */
  readonly restoreFileTokens: number
  /** Estimated-token cap for all re-attached files together. */
  readonly restoreTotalTokens: number
}

/** What one checkpoint's recovery context is built from. */
export interface ContinuationInput {
  readonly session: Session
  /** The condensed span's messages, in surface order. */
  readonly messages: readonly Message[]
  /** Seq of the last condensed surface node; reads after it are still in context. */
  readonly endSeq: number
  readonly compactionId: string
  /** Estimated tokens the returned blocks may cost in total. */
  readonly budgetTokens: number
  readonly signal?: AbortSignal
}

const READ_TOOL = 'read'

/**
 * Build the recovery blocks for one checkpoint. Best-effort: a missing spill
 * store or filesystem, a failed save, or an unreadable file drops only that
 * piece, and pieces that would exceed the budget are left out. Each block is
 * priced as its own message, so the summed prices include one role overhead
 * per block and bound the blocks' price inside the checkpoint from above.
 * @param ctx - context supplying the optional `spillStore` and `fs` services.
 * @param meter - estimator pricing each block against the budget.
 * @param limits - file re-attachment limits.
 * @param input - the condensed span and its budget.
 * @returns text blocks to append after the framed summary; empty when nothing fits.
 */
export async function buildContinuation(
  ctx: Context,
  meter: TokenMeter,
  limits: RestoreLimits,
  input: ContinuationInput,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = []
  let remaining = input.budgetTokens

  const transcript = await storeTranscript(ctx, input)
  if (transcript !== undefined) {
    const cost = estimateText(meter, transcript)
    if (cost < remaining) {
      blocks.push({ type: 'text', text: transcript })
      remaining -= cost
    }
  }

  const fs = ctx.get('fs')
  if (fs === undefined || limits.restoreFileCount === 0) return blocks
  const restored: string[] = []
  for (const path of recentlyReadFiles(input.session, input.endSeq).slice(0, limits.restoreFileCount)) {
    let content: string
    try {
      content = await readCurrent(fs, path, input.session.header.cwd, input.signal)
    } catch (error: unknown) {
      input.signal?.throwIfAborted()
      ctx.logger.debug(`compaction-basic: not re-attaching ${path}: ${String(error)}`)
      continue
    }
    const file = fileBlock(path, truncateToTokens(meter, content, limits.restoreFileTokens))
    // Price the whole files block, heading included, so the limits bound what is actually sent.
    const cost = estimateText(meter, filesText([...restored, file]))
    if (cost > limits.restoreTotalTokens || cost >= remaining) continue
    restored.push(file)
  }
  if (restored.length > 0) blocks.push({ type: 'text', text: filesText(restored) })
  return blocks
}

function filesText(files: readonly string[]): string {
  return [RESTORED_FILES_HEADER, ...files].join('\n\n')
}

/** Resolve `path` against the session directory and read its current text. */
async function readCurrent(fs: FileSystem, path: string, cwd: string | undefined, signal: AbortSignal | undefined): Promise<string> {
  const target = await fs.resolve(path, {
    ...cwd === undefined ? {} : { cwd },
    ...signal === undefined ? {} : { signal },
  })
  return fs.readText(target, signal)
}

/** Heading placed before re-attached files. */
export const RESTORED_FILES_HEADER =
  'Files read before this checkpoint, re-read from disk now (current content; it may differ from what was read earlier):'

/** Heading of the transcript list; later checkpoints find earlier locators by it. */
export const TRANSCRIPTS_HEADER =
  'The full text of the conversation condensed so far is stored in these files, oldest first. Read them when you need exact details from before this checkpoint.'

/**
 * Save the condensed span as plain text, then list its locator after every
 * transcript earlier checkpoints in the span already listed, so one checkpoint
 * names every stored transcript. `undefined` when there is nothing to list.
 */
async function storeTranscript(ctx: Context, input: ContinuationInput): Promise<string | undefined> {
  const store = ctx.get('spillStore')
  if (store === undefined) return undefined
  const locators = earlierTranscripts(input.messages)
  let hint = ''
  try {
    const ref = await store.saveText({
      owner: { sessionId: input.session.id },
      // Spill sources name a tool call; a transcript has none, so the
      // compaction id stands in as a descriptive, never-parsed label.
      source: { toolName: 'compaction', callId: ToolCallId(`compaction:${input.compactionId}`), label: 'transcript' },
      suggestedName: 'compacted-conversation.txt',
      content: renderTranscript(input.messages),
    })
    locators.push(ref.locator)
    hint = ` ${ref.retrievalHint}`
  } catch (error: unknown) {
    ctx.logger.warn(`compaction-basic: storing the condensed transcript failed: ${String(error)}`)
  }
  if (locators.length === 0) return undefined
  return [`${TRANSCRIPTS_HEADER}${hint}`, ...locators.map(locator => `- ${locator}`)].join('\n')
}

/**
 * Transcript locators listed by earlier checkpoints inside the condensed span,
 * oldest first. Only checkpoint messages are read, so user text cannot inject a path.
 * @param messages - the condensed span's messages.
 * @returns locators in the order they were listed.
 */
export function earlierTranscripts(messages: readonly Message[]): string[] {
  const locators: string[] = []
  for (const message of messages) {
    if (!isCompactCheckpointSource(message.source)) continue
    for (const block of message.content) {
      if (block.type !== 'text' || !block.text.startsWith(TRANSCRIPTS_HEADER)) continue
      for (const line of block.text.split('\n').slice(1)) {
        if (line.startsWith('- ') && !locators.includes(line.slice(2))) locators.push(line.slice(2))
      }
    }
  }
  return locators
}

/**
 * Render messages as a plain-text transcript a model can grep.
 * @param messages - messages in surface order.
 * @returns one labeled line group per content block.
 */
export function renderTranscript(messages: readonly Message[]): string {
  const lines: string[] = []
  for (const message of messages) {
    const speaker = message.role === 'assistant' ? 'Assistant' : message.role === 'system' ? 'System' : 'User'
    for (const block of message.content) lines.push(renderBlock(speaker, block))
  }
  return lines.join('\n\n')
}

function renderBlock(speaker: string, block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return `[${speaker}]: ${block.text}`
    case 'reasoning':
      return `[${speaker} reasoning]: ${block.text}`
    case 'image':
      return `[${speaker} image]`
    case 'tool-call':
      return `[Tool call ${block.id}]: ${block.name}(${block.arguments})`
    case 'tool-result': {
      const label = block.isError === true ? 'Tool error' : 'Tool result'
      const body = block.content.map(inner => renderBlock(speaker, inner)).join('\n')
      return `[${label} ${block.toolCallId}]:\n${body}`
    }
    // Merge-extensible union: a block type added by a plugin renders as its tag.
    default:
      return `[${speaker} ${(block as { type: string }).type}]`
  }
}

/**
 * Paths successfully read by the `read` tool, directly or inside `run_code`,
 * most recent first, excluding any path read again after `endSeq`.
 * @param session - session whose log is scanned.
 * @param endSeq - last condensed seq.
 * @returns distinct paths as the model wrote them.
 */
export function recentlyReadFiles(session: Session, endSeq: number): string[] {
  const pending = new Map<string, string>()
  const lastRead = new Map<string, number>()
  for (const event of session.events) {
    if (event.type === 'tool/call' && event.data.name === READ_TOOL) {
      const path = filePathOf(parseArguments(event.data.arguments))
      if (path !== undefined) pending.set(event.data.callId, path)
    } else if (event.type === 'tool/result') {
      const result = event.data.message.content[0]
      const path = pending.get(result.toolCallId)
      if (path !== undefined && result.isError !== true) lastRead.set(path, event.seq)
    } else if (event.type === 'tool/code-dispatch' && event.data.name === READ_TOOL && !event.data.isError) {
      const path = filePathOf(event.data.arguments)
      if (path !== undefined) lastRead.set(path, event.seq)
    }
  }
  return [...lastRead]
    .filter(([, seq]) => seq <= endSeq)
    .sort(([, a], [, b]) => b - a)
    .map(([path]) => path)
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    // Model-written arguments may be malformed; such a call read nothing to re-attach.
    return undefined
  }
}

function filePathOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const path = (args as { file_path?: unknown }).file_path
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

function fileBlock(path: string, content: string): string {
  return `<file path=${JSON.stringify(path)}>\n${content}\n</file>`
}

function estimateText(meter: TokenMeter, text: string): number {
  return meter.estimateMessage(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** Cut `text` at a line boundary until its estimate fits `maxTokens`, marking the cut. */
function truncateToTokens(meter: TokenMeter, text: string, maxTokens: number): string {
  if (estimateText(meter, text) <= maxTokens) return text
  let kept = text
  while (kept.length > 0 && estimateText(meter, `${kept}${TRUNCATED_NOTE}`) > maxTokens) {
    const cut = Math.floor(kept.length * 0.8)
    const lineEnd = kept.lastIndexOf('\n', cut)
    kept = kept.slice(0, lineEnd > cut / 2 ? lineEnd : cut)
  }
  return `${kept}${TRUNCATED_NOTE}`
}

const TRUNCATED_NOTE = '\n[... truncated; read the file for the rest ...]'
