/** Wire types for the active deepseek plugin package inventory. */

/** One exact active plugin package version. */
export interface deepseekPluginPackageIdentity {
  readonly name: string
  readonly version: string
}

/** Versioned full package inventory carried by each official deepseek request. */
export interface deepseekPluginPackageInventoryExtension {
  readonly version: 1
  readonly packages: readonly deepseekPluginPackageIdentity[]
}

declare module '@deepseek-ai/dsh-deepseek-llm-api-extensions/types' {
  interface deepseekLlmApiExtensionMap {
    dsh_plugin_packages: deepseekPluginPackageInventoryExtension
  }
}
