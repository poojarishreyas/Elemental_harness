/** Session fixtures, manifests, normalization, and workspace comparison for browser tests.
 * @module @deepseek-ai/dsh-session-snapshot
 */

export {
  redactSessionSnapshotIds,
} from './identity.ts'
export {
  extractSnapshotSpillPaths,
  normalizeSessionLog,
  normalizeSessionSnapshot,
  normalizeSessionSnapshots,
  normalizeStdout,
  scrubRequestHeaders,
  scrubSessionSnapshot,
  scrubSystemPrompts,
  scrubToolSchemas,
  tokenizeSessionFixtureCwd,
  type CwdPathMode,
  type NormalizeContext,
  type NormalizeOptions,
} from './normalize.ts'
export {
  parseSnapshotManifest,
  type SnapshotHeaderManifest,
  type SnapshotInputAttachment,
  type SnapshotInputManifest,
  type SnapshotManifest,
  type SnapshotPermission,
  type SnapshotPlatform,
  type SnapshotProfile,
  type SnapshotRecording,
  type SnapshotReplayManifest,
  type SnapshotSessionReference,
  type SnapshotWorkspaceManifest,
} from './manifest.ts'
export {
  formatSystemPromptSnapshot,
  formatToolSchemasSnapshot,
  fixtureContext,
  headerChangeCount,
  normalizedHeaders,
  normalizedSystemPrompts,
  normalizedToolSchemas,
  parseToolSchemasSnapshot,
  refreshFixtureReplacements,
  restorePinnedToolSchemas,
  sessionFixtureNames,
  stabilizeFixtureMessageIds,
  stabilizeRefreshLog,
  type HarvestedLog,
} from './suite.ts'
export {
  captureExpectedWorkspaceSnapshot,
  captureWorkspaceSnapshot,
  EMPTY_WORKSPACE_MARKER,
  type CaptureWorkspaceSnapshotOptions,
  type WorkspaceBinaryFileSnapshot,
  type WorkspaceEmptyDirectorySnapshot,
  type WorkspaceSnapshotEntry,
  type WorkspaceSymlinkSnapshot,
  type WorkspaceTextFileSnapshot,
} from './workspace.ts'
export { materializeProfilePatch } from './patch.ts'
