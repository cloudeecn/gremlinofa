/**
 * VfsAdapter — abstraction layer for VFS operations.
 *
 * LocalVfsAdapter wraps existing vfsService (encrypted blobs in IndexedDB/remote SQLite).
 * RemoteVfsAdapter talks to the vfs-backend HTTP API.
 *
 * The facade routes operations to the correct adapter based on project config.
 */

import type {
  DirEntry,
  ReadFileResult,
  VfsStat,
  VersionInfo,
  StrReplaceResult,
  InsertResult,
  CompactProgress,
  CompactResult,
  CompactOptions,
  OrphanInfo,
  FileContent,
} from './vfsService';

export interface VfsAdapter {
  // Basic CRUD
  readDir(path: string, includeDeleted?: boolean): Promise<DirEntry[]>;
  readFile(path: string): Promise<string>;
  readFileWithMeta(path: string): Promise<ReadFileResult>;
  writeFile(path: string, content: FileContent): Promise<void>;
  createFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string, recursive?: boolean): Promise<void>;
  rename(oldPath: string, newPath: string, overwrite?: boolean): Promise<void>;
  exists(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;
  stat(path: string): Promise<VfsStat>;
  hasVfs(): Promise<boolean>;
  clearVfs(): Promise<void>;

  // Text editing operations
  strReplace(path: string, oldStr: string, newStr: string): Promise<StrReplaceResult>;
  insert(path: string, line: number, text: string): Promise<InsertResult>;
  appendFile(path: string, text: string): Promise<{ created: boolean }>;

  // Versioning
  getFileMeta(path: string): Promise<{
    version: number;
    createdAt: number;
    updatedAt: number;
    minStoredVersion: number;
    storedVersionCount: number;
  } | null>;
  getFileId(path: string): Promise<string | null>;
  listVersions(fileId: string): Promise<VersionInfo[]>;
  getVersion(fileId: string, version: number): Promise<string | null>;
  dropOldVersions(fileId: string, keepCount: number): Promise<number>;

  // Orphan management (local VFS only — remote returns empty/no-op)
  listOrphans(): Promise<OrphanInfo[]>;
  restoreOrphan(fileId: string, targetPath: string): Promise<void>;
  purgeOrphan(fileId: string): Promise<void>;

  // Compound operations
  copyFile(src: string, dst: string, overwrite?: boolean): Promise<void>;
  deletePath(path: string): Promise<void>;
  createFileGuarded(path: string, content: FileContent, overwrite?: boolean): Promise<void>;
  ensureDirAndWrite(dir: string, files: Array<{ name: string; content: string }>): Promise<void>;

  // Compact
  compactProject(
    onProgress?: (p: CompactProgress) => void,
    options?: CompactOptions
  ): Promise<CompactResult>;
}
