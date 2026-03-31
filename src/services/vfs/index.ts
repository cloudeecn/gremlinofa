/**
 * VFS barrel — re-exports the facade (locked API) and utility types.
 *
 * All callers should import from here, never directly from vfsService.
 * Only vfsFacade.ts and internal VFS tests may import vfsService directly.
 */

// Locked operations + compound operations
export {
  // Passthrough wrappers
  createFile,
  readFile,
  updateFile,
  writeFile,
  readFileWithMeta,
  deleteFile,
  mkdir,
  rmdir,
  readDir,
  rename,
  exists,
  isFile,
  isDirectory,
  restore,
  purge,
  clearVfs,
  hasVfs,
  stat,
  getFileMeta,
  getFileId,
  getVersion,
  listVersions,
  dropOldVersions,
  listOrphans,
  restoreOrphan,
  purgeOrphan,
  strReplace,
  insert,
  compactProject,
  // Compound operations
  appendFile,
  copyFile,
  deletePath,
  createFileGuarded,
  ensureDirAndWrite,
} from './vfsFacade';

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
export { RemoteVfsAdapter } from './remoteVfsAdapter';
export { LocalVfsAdapter } from './localVfsAdapter';
export type { VfsAdapter } from './vfsAdapter';

// Adapter factory
export { getAdapter } from './vfsFacade';

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
