/**
 * LocalVfsAdapter — wraps a `VfsService` instance with tree lock.
 *
 * Delegates every call to the `VfsService` factory result, which closes
 * over the per-server `UnifiedStorage` and `EncryptionService` instances
 * supplied by `vfsFacade.getAdapter`. The local VFS code path is the
 * same as before — it's just behind the `VfsAdapter` interface and now
 * receives its collaborators via constructor injection instead of
 * importing module-level singletons.
 */

import type { VfsAdapter } from './vfsAdapter';
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
  VfsService,
} from './vfsService';
import { withTreeLock } from './treeLock';
import { VfsError, isBinaryContent } from './vfsService';

export class LocalVfsAdapter implements VfsAdapter {
  private svc: VfsService;
  private projectId: string;
  private namespace?: string;

  constructor(svc: VfsService, projectId: string, namespace?: string) {
    this.svc = svc;
    this.projectId = projectId;
    this.namespace = namespace;
  }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    return withTreeLock(this.projectId, fn);
  }

  async readDir(path: string, includeDeleted = false): Promise<DirEntry[]> {
    return this.lock(() => this.svc.readDir(this.projectId, path, includeDeleted, this.namespace));
  }

  async readFile(path: string): Promise<string> {
    return this.lock(() => this.svc.readFile(this.projectId, path, this.namespace));
  }

  async readFileWithMeta(path: string): Promise<ReadFileResult> {
    return this.lock(() => this.svc.readFileWithMeta(this.projectId, path, this.namespace));
  }

  async writeFile(path: string, content: FileContent): Promise<void> {
    return this.lock(() => this.svc.writeFile(this.projectId, path, content, this.namespace));
  }

  async createFile(path: string, content: string): Promise<void> {
    return this.lock(() => this.svc.createFile(this.projectId, path, content, this.namespace));
  }

  async deleteFile(path: string): Promise<void> {
    return this.lock(() => this.svc.deleteFile(this.projectId, path, this.namespace));
  }

  async mkdir(path: string): Promise<void> {
    return this.lock(() => this.svc.mkdir(this.projectId, path, this.namespace));
  }

  async rmdir(path: string, recursive = false): Promise<void> {
    return this.lock(() => this.svc.rmdir(this.projectId, path, recursive, this.namespace));
  }

  async rename(oldPath: string, newPath: string, overwrite?: boolean): Promise<void> {
    return this.lock(() =>
      this.svc.rename(this.projectId, oldPath, newPath, this.namespace, overwrite)
    );
  }

  async exists(path: string): Promise<boolean> {
    return this.lock(() => this.svc.exists(this.projectId, path, this.namespace));
  }

  async isFile(path: string): Promise<boolean> {
    return this.lock(() => this.svc.isFile(this.projectId, path, this.namespace));
  }

  async isDirectory(path: string): Promise<boolean> {
    return this.lock(() => this.svc.isDirectory(this.projectId, path, this.namespace));
  }

  async stat(path: string): Promise<VfsStat> {
    return this.lock(() => this.svc.stat(this.projectId, path, this.namespace));
  }

  async hasVfs(): Promise<boolean> {
    return this.lock(() => this.svc.hasVfs(this.projectId));
  }

  async clearVfs(): Promise<void> {
    return this.lock(() => this.svc.clearVfs(this.projectId));
  }

  async strReplace(path: string, oldStr: string, newStr: string): Promise<StrReplaceResult> {
    return this.lock(() =>
      this.svc.strReplace(this.projectId, path, oldStr, newStr, this.namespace)
    );
  }

  async insert(path: string, line: number, text: string): Promise<InsertResult> {
    return this.lock(() => this.svc.insert(this.projectId, path, line, text, this.namespace));
  }

  async appendFile(path: string, text: string): Promise<{ created: boolean }> {
    return this.lock(async () => {
      const fileExists = await this.svc.exists(this.projectId, path, this.namespace);
      if (fileExists) {
        const fileStat = await this.svc.stat(this.projectId, path, this.namespace);
        if (fileStat.isBinary) {
          throw new VfsError(`Cannot append to binary file: ${path}`, 'BINARY_FILE');
        }
        const content = await this.svc.readFile(this.projectId, path, this.namespace);
        await this.svc.updateFile(this.projectId, path, content + text, this.namespace);
        return { created: false };
      }
      await this.svc.writeFile(this.projectId, path, text, this.namespace);
      return { created: true };
    });
  }

  async getFileMeta(path: string) {
    return this.lock(() => this.svc.getFileMeta(this.projectId, path));
  }

  async getFileId(path: string): Promise<string | null> {
    return this.lock(() => this.svc.getFileId(this.projectId, path));
  }

  async listVersions(fileId: string): Promise<VersionInfo[]> {
    return this.lock(() => this.svc.listVersions(this.projectId, fileId));
  }

  async getVersion(fileId: string, version: number): Promise<string | null> {
    return this.lock(() => this.svc.getVersion(this.projectId, fileId, version));
  }

  async dropOldVersions(fileId: string, keepCount: number): Promise<number> {
    return this.lock(() => this.svc.dropOldVersions(this.projectId, fileId, keepCount));
  }

  async listOrphans(): Promise<OrphanInfo[]> {
    return this.lock(() => this.svc.listOrphans(this.projectId));
  }

  async restoreOrphan(fileId: string, targetPath: string): Promise<void> {
    return this.lock(() => this.svc.restoreOrphan(this.projectId, fileId, targetPath));
  }

  async purgeOrphan(fileId: string): Promise<void> {
    return this.lock(() => this.svc.purgeOrphan(this.projectId, fileId));
  }

  async copyFile(src: string, dst: string, overwrite?: boolean): Promise<void> {
    return this.lock(async () => {
      const destIsDir = await this.svc.isDirectory(this.projectId, dst, this.namespace);
      if (destIsDir) {
        throw new VfsError(`Destination is a directory: ${dst}`, 'NOT_A_FILE');
      }
      if (!overwrite) {
        const destExists = await this.svc.exists(this.projectId, dst, this.namespace);
        if (destExists) {
          throw new VfsError(`Destination already exists: ${dst}`, 'DESTINATION_EXISTS');
        }
      }
      const source = await this.svc.readFileWithMeta(this.projectId, src, this.namespace);
      if (source.isBinary) {
        await this.svc.writeFile(this.projectId, dst, source.buffer!, this.namespace);
      } else {
        await this.svc.writeFile(this.projectId, dst, source.content, this.namespace);
      }
    });
  }

  async deletePath(path: string): Promise<void> {
    return this.lock(async () => {
      try {
        await this.svc.deleteFile(this.projectId, path, this.namespace);
      } catch (error) {
        if (error instanceof VfsError && error.code === 'NOT_A_FILE') {
          await this.svc.rmdir(this.projectId, path, true, this.namespace);
        } else {
          throw error;
        }
      }
    });
  }

  async createFileGuarded(path: string, content: FileContent, overwrite?: boolean): Promise<void> {
    return this.lock(async () => {
      if (overwrite) {
        await this.svc.writeFile(this.projectId, path, content, this.namespace);
      } else {
        if (isBinaryContent(content)) {
          const pathExists = await this.svc.exists(this.projectId, path, this.namespace);
          if (pathExists) {
            throw new VfsError(`File already exists: ${path}`, 'FILE_EXISTS');
          }
          await this.svc.writeFile(this.projectId, path, content, this.namespace);
        } else {
          await this.svc.createFile(this.projectId, path, content, this.namespace);
        }
      }
    });
  }

  async ensureDirAndWrite(
    dir: string,
    files: Array<{ name: string; content: string }>
  ): Promise<void> {
    return this.lock(async () => {
      const dirExists = await this.svc.isDirectory(this.projectId, dir, this.namespace);
      if (!dirExists) {
        await this.svc.mkdir(this.projectId, dir, this.namespace);
      }
      for (const file of files) {
        const filePath = dir.endsWith('/') ? `${dir}${file.name}` : `${dir}/${file.name}`;
        await this.svc.writeFile(this.projectId, filePath, file.content, this.namespace);
      }
    });
  }

  async compactProject(
    onProgress?: (p: CompactProgress) => void,
    options?: CompactOptions
  ): Promise<CompactResult> {
    return this.lock(() => this.svc.compactProject(this.projectId, onProgress, options));
  }
}
