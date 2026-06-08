/**
 * VFS barrel — re-exports the local adapter, utility helpers, and types.
 *
 * Phase 1.65 moved the per-project adapter dispatch (`getAdapter`) out
 * to `src/worker/adapters/createVfsAdapter.ts`. `RemoteVfsAdapter` lives
 * alongside the other adapters in this directory. Production callers go
 * through `BackendDeps.createVfsAdapter`; this barrel exposes the pure
 * pieces (adapters, types, path helpers) that shared code can import.
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

// Adapters
export { LocalVfsAdapter } from './localVfsAdapter';
export { RemoteVfsAdapter } from './RemoteVfsAdapter';
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
