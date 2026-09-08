/** deepseek Files API identifiers. @module dsh-llm-deepseek/file-id */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identifier returned by the deepseek Files API. */
export type deepseekFileId = Branded<'deepseekFileId'>

/**
 * Brand a provider-returned file identifier after wire validation.
 * @param id - non-empty Files API identifier.
 * @returns the same string with its provider identity attached at type level.
 */
export function deepseekFileId(id: string): deepseekFileId {
  return id as deepseekFileId
}

/** Non-secret digest identifying one endpoint and API-key file namespace. */
export type deepseekFileScope = Branded<'deepseekFileScope'>

/**
 * Brand a locally derived namespace digest.
 * @param scope - SHA-256 digest of endpoint and API key.
 * @returns the same string with namespace identity attached at type level.
 */
export function deepseekFileScope(scope: string): deepseekFileScope {
  return scope as deepseekFileScope
}
