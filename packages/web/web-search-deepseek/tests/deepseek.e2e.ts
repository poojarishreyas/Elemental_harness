import { describe, expect, it } from 'vitest'
import {
  deepseekSearchProvider,
  deepseek_DEFAULT_API_VERSION,
  deepseek_DEFAULT_BASE_URL,
  deepseek_DEFAULT_MAX_TOKENS,
  deepseek_DEFAULT_MAX_USES,
  deepseek_DEFAULT_MODEL,
} from '@deepseek-ai/dsh-web-search-deepseek'

/** Construct the provider over a fixed options value; production passes a live thunk. */
import type { deepseekSearchProviderOptions } from '@deepseek-ai/dsh-web-search-deepseek'

const searchProvider = (options: deepseekSearchProviderOptions): deepseekSearchProvider =>
  new deepseekSearchProvider(() => options)

/**
 * Disabled real-API probe for the deepseek search provider. The live endpoint
 * can complete without structured source blocks, so this is not a reliable
 * merge signal. Its body remains because mocks cannot confirm the wire shape.
 */
const apiKey = process.env.deepseek_API_KEY
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('deepseekSearchProvider real API', () => {
  it.skip('returns citeable sources for a live query via native web_search', async () => {
    const provider = searchProvider({
      apiKey: apiKey!,
      baseURL: process.env.deepseek_SEARCH_BASE_URL ?? deepseek_DEFAULT_BASE_URL,
      model: process.env.deepseek_SEARCH_MODEL ?? deepseek_DEFAULT_MODEL,
      apiVersion: deepseek_DEFAULT_API_VERSION,
      maxTokens: deepseek_DEFAULT_MAX_TOKENS,
      maxUses: deepseek_DEFAULT_MAX_USES,
    })
    const result = await provider.search({ query: 'What is deepseek Harness?', maxResults: 5 })
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
  }, 60_000)
})
