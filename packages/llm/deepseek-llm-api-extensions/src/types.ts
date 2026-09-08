/** Provider-specific JSON and contribution types for deepseek request extensions. */

/** Lossless JSON value accepted by the deepseek request body. */
export type deepseekLlmApiJson =
  | null
  | boolean
  | number
  | string
  | deepseekLlmApiJson[]
  | { [key: string]: deepseekLlmApiJson }

/**
 * Merge-extensible table of top-level deepseek request extension fields.
 * Contributor packages declaration-merge the field they own.
 */
export interface deepseekLlmApiExtensionMap { }

/** Exact serialized request facts visible to extension providers. */
export interface deepseekLlmApiExtensionRequest {
  /** Base deepseek request body before extension fields are merged. */
  readonly body: Readonly<Record<string, deepseekLlmApiJson>>
  /** Session identity carried by the model request, when present. */
  readonly sessionId?: string
  /** Auxiliary request classification, when present. */
  readonly purpose?: 'compaction' | 'session-title'
  /** Cancellation for request preparation; providers must stop promptly after abort. */
  readonly signal: AbortSignal
}

/** One prepared field value and its optional post-2xx commit. */
export interface PrepareddeepseekLlmApiExtension<T extends deepseekLlmApiJson> {
  /** Detached value merged under the provider's registered field. */
  readonly value: T
  /** Commit state that depends on confirmed provider acceptance. */
  accept?(): void | Promise<void>
}

/** Provider registered under one key of {@link deepseekLlmApiExtensionMap}. */
export interface deepseekLlmApiExtensionProvider<T extends deepseekLlmApiJson> {
  /**
   * Prepare one field for an exact serialized request.
   * @param request - immutable base request facts.
   * @returns the prepared field, or `undefined` when this request has no value for it.
   */
  prepare(
    request: deepseekLlmApiExtensionRequest,
  ): PrepareddeepseekLlmApiExtension<T> | undefined | Promise<PrepareddeepseekLlmApiExtension<T> | undefined>
}

/** All fields prepared for one request plus their joint acceptance transaction. */
export interface PrepareddeepseekLlmApiExtensions {
  /** Detached top-level fields to merge into the base request. */
  readonly fields: Readonly<Partial<deepseekLlmApiExtensionMap>>
  /**
   * Commit every captured provider after HTTP 2xx. Repeated calls join the same settlement.
   * @returns fulfillment after every commit succeeds.
   */
  accept(): Promise<void>
}
