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
  DeletePathResult,
} from './vfsService';

export interface VfsAdapter {
  // Basic CRUD
  readDir(path: string, includeDeleted?: boolean): Promise<DirEntry[]>;
  readFile(path: string): Promise<string>;
  readFileWithMeta(path: string): Promise<ReadFileResult>;
  /** Creates missing parent directories. */
  writeFile(path: string, content: FileContent): Promise<void>;
  createFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  /**
   * Creates missing parent directories. An existing directory is DIR_EXISTS
   * unless `recursive` is set, which makes it a no-op (`mkdir -p`).
   */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
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
  /** Text files only; creates the file and missing parents when absent. */
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

  // Bulk migration read — fetch all version contents in one call (optional, remote VFS only).
  readAllVersions?(fileId: string): Promise<Array<{ version: number; content: string }>>;

  // Orphan management (local VFS only — remote returns empty/no-op)
  listOrphans(): Promise<OrphanInfo[]>;
  restoreOrphan(fileId: string, targetPath: string): Promise<void>;
  purgeOrphan(fileId: string): Promise<void>;

  // Bulk migration write — writes a file with its full version history in one call.
  writeFileWithHistory(
    filePath: string,
    versions: Array<{ content: string; createdAt: number }>,
    currentContent: FileContent,
    isBinary: boolean
  ): Promise<void>;

  // Compound operations
  copyFile(src: string, dst: string, overwrite?: boolean): Promise<void>;
  deletePath(path: string): Promise<void>;
  /**
   * Best-effort batch delete with one result per path. Missing paths are
   * PATH_NOT_FOUND, directories without `recursive` are NOT_A_FILE, and a
   * path under one already deleted in the same batch counts as deleted.
   */
  deletePaths(paths: string[], recursive: boolean): Promise<DeletePathResult[]>;
  createFileGuarded(path: string, content: FileContent, overwrite?: boolean): Promise<void>;
  ensureDirAndWrite(dir: string, files: Array<{ name: string; content: string }>): Promise<void>;

  // Compact
  compactProject(
    onProgress?: (p: CompactProgress) => void,
    options?: CompactOptions
  ): Promise<CompactResult>;
}
