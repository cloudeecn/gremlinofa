/**
 * LocalVfsAdapter — wraps existing vfsService with tree lock.
 *
 * Delegates every call to the vfsFacade's locked wrappers. This keeps
 * the local VFS path unchanged — it's the same code, just behind the
 * VfsAdapter interface so the facade can route between local and remote.
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
} from './vfsService';
import { withTreeLock } from './treeLock';
import * as svc from './vfsService';

export class LocalVfsAdapter implements VfsAdapter {
  private projectId: string;
  private namespace?: string;

  constructor(projectId: string, namespace?: string) {
    this.projectId = projectId;
    this.namespace = namespace;
  }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    return withTreeLock(this.projectId, fn);
  }

  async readDir(path: string, includeDeleted = false): Promise<DirEntry[]> {
    return this.lock(() => svc.readDir(this.projectId, path, includeDeleted, this.namespace));
  }

  async readFile(path: string): Promise<string> {
    return this.lock(() => svc.readFile(this.projectId, path, this.namespace));
  }

  async readFileWithMeta(path: string): Promise<ReadFileResult> {
    return this.lock(() => svc.readFileWithMeta(this.projectId, path, this.namespace));
  }

  async writeFile(path: string, content: FileContent): Promise<void> {
    return this.lock(() => svc.writeFile(this.projectId, path, content, this.namespace));
  }

  async createFile(path: string, content: string): Promise<void> {
    return this.lock(() => svc.createFile(this.projectId, path, content, this.namespace));
  }

  async deleteFile(path: string): Promise<void> {
    return this.lock(() => svc.deleteFile(this.projectId, path, this.namespace));
  }

  async mkdir(path: string): Promise<void> {
    return this.lock(() => svc.mkdir(this.projectId, path, this.namespace));
  }

  async rmdir(path: string, recursive = false): Promise<void> {
    return this.lock(() => svc.rmdir(this.projectId, path, recursive, this.namespace));
  }

  async rename(oldPath: string, newPath: string, overwrite?: boolean): Promise<void> {
    return this.lock(() => svc.rename(this.projectId, oldPath, newPath, this.namespace, overwrite));
  }

  async exists(path: string): Promise<boolean> {
    return this.lock(() => svc.exists(this.projectId, path, this.namespace));
  }

  async isFile(path: string): Promise<boolean> {
    return this.lock(() => svc.isFile(this.projectId, path, this.namespace));
  }

  async isDirectory(path: string): Promise<boolean> {
    return this.lock(() => svc.isDirectory(this.projectId, path, this.namespace));
  }

  async stat(path: string): Promise<VfsStat> {
    return this.lock(() => svc.stat(this.projectId, path, this.namespace));
  }

  async hasVfs(): Promise<boolean> {
    return this.lock(() => svc.hasVfs(this.projectId));
  }

  async clearVfs(): Promise<void> {
    return this.lock(() => svc.clearVfs(this.projectId));
  }

  async strReplace(path: string, oldStr: string, newStr: string): Promise<StrReplaceResult> {
    return this.lock(() => svc.strReplace(this.projectId, path, oldStr, newStr, this.namespace));
  }

  async insert(path: string, line: number, text: string): Promise<InsertResult> {
    return this.lock(() => svc.insert(this.projectId, path, line, text, this.namespace));
  }

  async appendFile(path: string, text: string): Promise<{ created: boolean }> {
    return this.lock(async () => {
      const fileExists = await svc.exists(this.projectId, path, this.namespace);
      if (fileExists) {
        const fileStat = await svc.stat(this.projectId, path, this.namespace);
        if (fileStat.isBinary) {
          throw new svc.VfsError(`Cannot append to binary file: ${path}`, 'BINARY_FILE');
        }
        const content = await svc.readFile(this.projectId, path, this.namespace);
        await svc.updateFile(this.projectId, path, content + text, this.namespace);
        return { created: false };
      }
      await svc.writeFile(this.projectId, path, text, this.namespace);
      return { created: true };
    });
  }

  async getFileMeta(path: string) {
    return this.lock(() => svc.getFileMeta(this.projectId, path));
  }

  async getFileId(path: string): Promise<string | null> {
    return this.lock(() => svc.getFileId(this.projectId, path));
  }

  async listVersions(fileId: string): Promise<VersionInfo[]> {
    return this.lock(() => svc.listVersions(this.projectId, fileId));
  }

  async getVersion(fileId: string, version: number): Promise<string | null> {
    return this.lock(() => svc.getVersion(this.projectId, fileId, version));
  }

  async dropOldVersions(fileId: string, keepCount: number): Promise<number> {
    return this.lock(() => svc.dropOldVersions(this.projectId, fileId, keepCount));
  }

  async listOrphans(): Promise<OrphanInfo[]> {
    return this.lock(() => svc.listOrphans(this.projectId));
  }

  async restoreOrphan(fileId: string, targetPath: string): Promise<void> {
    return this.lock(() => svc.restoreOrphan(this.projectId, fileId, targetPath));
  }

  async purgeOrphan(fileId: string): Promise<void> {
    return this.lock(() => svc.purgeOrphan(this.projectId, fileId));
  }

  async copyFile(src: string, dst: string, overwrite?: boolean): Promise<void> {
    return this.lock(async () => {
      const destIsDir = await svc.isDirectory(this.projectId, dst, this.namespace);
      if (destIsDir) {
        throw new svc.VfsError(`Destination is a directory: ${dst}`, 'NOT_A_FILE');
      }
      if (!overwrite) {
        const destExists = await svc.exists(this.projectId, dst, this.namespace);
        if (destExists) {
          throw new svc.VfsError(`Destination already exists: ${dst}`, 'DESTINATION_EXISTS');
        }
      }
      const source = await svc.readFileWithMeta(this.projectId, src, this.namespace);
      if (source.isBinary) {
        await svc.writeFile(this.projectId, dst, source.buffer!, this.namespace);
      } else {
        await svc.writeFile(this.projectId, dst, source.content, this.namespace);
      }
    });
  }

  async deletePath(path: string): Promise<void> {
    return this.lock(async () => {
      try {
        await svc.deleteFile(this.projectId, path, this.namespace);
      } catch (error) {
        if (error instanceof svc.VfsError && error.code === 'NOT_A_FILE') {
          await svc.rmdir(this.projectId, path, true, this.namespace);
        } else {
          throw error;
        }
      }
    });
  }

  async createFileGuarded(path: string, content: FileContent, overwrite?: boolean): Promise<void> {
    return this.lock(async () => {
      if (overwrite) {
        await svc.writeFile(this.projectId, path, content, this.namespace);
      } else {
        if (svc.isBinaryContent(content)) {
          const pathExists = await svc.exists(this.projectId, path, this.namespace);
          if (pathExists) {
            throw new svc.VfsError(`File already exists: ${path}`, 'FILE_EXISTS');
          }
          await svc.writeFile(this.projectId, path, content, this.namespace);
        } else {
          await svc.createFile(this.projectId, path, content, this.namespace);
        }
      }
    });
  }

  async ensureDirAndWrite(
    dir: string,
    files: Array<{ name: string; content: string }>
  ): Promise<void> {
    return this.lock(async () => {
      const dirExists = await svc.isDirectory(this.projectId, dir, this.namespace);
      if (!dirExists) {
        await svc.mkdir(this.projectId, dir, this.namespace);
      }
      for (const file of files) {
        const filePath = dir.endsWith('/') ? `${dir}${file.name}` : `${dir}/${file.name}`;
        await svc.writeFile(this.projectId, filePath, file.content, this.namespace);
      }
    });
  }

  async compactProject(
    onProgress?: (p: CompactProgress) => void,
    options?: CompactOptions
  ): Promise<CompactResult> {
    return this.lock(() => svc.compactProject(this.projectId, onProgress, options));
  }
}
