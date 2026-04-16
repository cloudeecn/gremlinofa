/**
 * Frontend-safe re-exports of VFS types.
 *
 * Components, hooks, and contexts must NOT import from `src/services/vfs/**`
 * directly (boundary rule in `eslint.config.js`). They import the type
 * surface from here instead.
 *
 * The runtime VFS operations are reached through `gremlinClient.vfs*` or
 * the project-bound `gremlinClient.getVfsAdapter(projectId)` facade.
 */

export type { VfsAdapter } from '../../services/vfs/vfsAdapter';

export type {
  DirEntry,
  ReadFileResult,
  VfsStat,
  VersionInfo,
  OrphanInfo,
  StrReplaceResult,
  InsertResult,
  CompactProgress,
  CompactResult,
  CompactOptions,
  FileContent,
  VfsErrorCode,
} from '../../services/vfs/vfsService';
