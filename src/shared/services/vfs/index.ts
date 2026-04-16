/**
 * VFS barrel — re-exports the local adapter, utility helpers, and types.
 *
 * Phase 1.65 moved the per-project adapter dispatch (`getAdapter`) and
 * the `RemoteVfsAdapter` class out to `src/worker/adapters/createVfsAdapter.ts`
 * (and `src/worker/adapters/RemoteVfsAdapter.ts`). Production callers go
 * through `BackendDeps.createVfsAdapter`; this barrel only exposes the
 * pure pieces (local adapter, types, path helpers) that shared code can
 * still safely import.
 */

// Utility functions (no lock needed — pure or sync)
export {
  normalizePath,
  getParentDir,
  getBasename,
  getPathSegments,
  isRootPath,
  resolveNamespacedPath,
  isNamespacedReadonly,
  detectMimeFromBuffer,
  isBinaryContent,
  base64ToBuffer,
  formatSnippet,
  selectVersionsToKeep,
} from './vfsService';

// Local adapter (still safe — uses UnifiedStorage, no direct browser globals).
export { LocalVfsAdapter } from './localVfsAdapter';
export type { VfsAdapter } from './vfsAdapter';

// Types and classes
export { VfsError } from './vfsService';
export type {
  VfsErrorCode,
  DirEntry,
  FileContent,
  ReadFileResult,
  VfsStat,
  VersionInfo,
  OrphanInfo,
  StrReplaceResult,
  InsertResult,
  CompactProgress,
  CompactResult,
  CompactOptions,
} from './vfsService';
