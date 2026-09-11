/**
 * RemoteVfsAdapter — HTTP adapter for the vfs-backend server.
 *
 * Each method maps to a vfs-backend API endpoint. No client-side tree lock —
 * the server handles per-file locking. All content is plaintext (no E2E
 * encryption). Users with existing encrypted data should export via the old
 * version, then re-import.
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
  DeletePathResult,
  VfsErrorCode,
} from './vfsService';
import {
  VfsError,
  isBinaryContent,
  detectMimeFromBuffer,
  resolveNamespacedPath,
  assertWritable,
} from './vfsService';
import { base64ToUint8Array, uint8ArrayToBase64 } from '../../protocol/binaryEncoding';
import { isCoveredByDeleted, isRootPath, normalizePath } from '../../engine/lib/vfsPaths';

export interface RemoteVfsAdapterOptions {
  baseUrl: string;
  userId: string;
  password: string;
  projectId: string;
  namespace?: string;
}

export class RemoteVfsAdapter implements VfsAdapter {
  private baseUrl: string;
  private authHeader: string;
  private projectId: string;
  private namespace?: string;

  constructor(opts: RemoteVfsAdapterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.authHeader = 'Basic ' + btoa(`${opts.userId}:${opts.password}`);
    this.projectId = opts.projectId;
    this.namespace = opts.namespace;
  }

  /** Resolve path through namespace (e.g. `/memories/x` → `/minions/coder/memories/x`) */
  private resolve(path: string): string {
    return resolveNamespacedPath(path, this.namespace);
  }

  private url(path: string, params: Record<string, string> = {}): string {
    const allParams = { projectId: this.projectId, ...params };
    const qs = new URLSearchParams(allParams).toString();
    return `${this.baseUrl}/api${path}?${qs}`;
  }

  private async fetch(input: string, init?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      ...(init?.headers as Record<string, string>),
    };
    const res = await fetch(input, { ...init, headers });
    return res;
  }

  // ============================
  // Basic CRUD
  // ============================

  async readDir(path: string, _includeDeleted = false): Promise<DirEntry[]> {
    const resolved = this.resolve(path);
    const res = await this.fetch(this.url('/ls', { path: resolved }));
    if (!res.ok) throw new VfsError(`ls failed: ${res.status}`, 'PATH_NOT_FOUND');
    const body = await res.json();
    return (body.entries as Array<{ name: string; type: string; size: number; mtime: number }>).map(
      e => ({
        name: e.name,
        type: e.type as 'file' | 'dir',
        deleted: false,
        createdAt: e.mtime,
        updatedAt: e.mtime,
        size: e.type === 'file' ? e.size : undefined,
      })
    );
  }

  async readFile(path: string): Promise<string> {
    const resolved = this.resolve(path);
    const res = await this.fetch(this.url('/read', { path: resolved }));
    if (!res.ok) throw new VfsError(`read failed: ${res.status}`, 'PATH_NOT_FOUND');
    return res.text();
  }

  async readFileWithMeta(path: string): Promise<ReadFileResult> {
    const resolved = this.resolve(path);
    const res = await this.fetch(this.url('/read', { path: resolved }));
    if (!res.ok) throw new VfsError(`read failed: ${res.status}`, 'PATH_NOT_FOUND');

    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Check if it's text (try UTF-8 decode)
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const text = decoder.decode(bytes);
      return { content: text, isBinary: false, mime: 'text/plain' };
    } catch {
      // Binary content
      const mime = detectMimeFromBuffer(buffer);
      // Base64 encode for consistency with local VFS
      return { content: uint8ArrayToBase64(bytes), isBinary: true, mime, buffer };
    }
  }

  async writeFile(path: string, content: FileContent): Promise<void> {
    assertWritable(path, this.namespace);
    const resolved = this.resolve(path);
    let body: Blob;
    if (isBinaryContent(content)) {
      // Copy to a fresh ArrayBuffer to satisfy TypeScript's strict Blob typing
      const src = content instanceof ArrayBuffer ? new Uint8Array(content) : content;
      const copy = new ArrayBuffer(src.byteLength);
      new Uint8Array(copy).set(src);
      body = new Blob([copy]);
    } else {
      body = new Blob([content]);
    }

    const res = await this.fetch(this.url('/write', { path: resolved }), {
      method: 'PUT',
      body,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: 'write failed' }));
      throw new VfsError(errBody.error || `write failed: ${res.status}`, 'INVALID_PATH');
    }
  }

  async createFile(path: string, content: string): Promise<void> {
    assertWritable(path, this.namespace);
    const resolved = this.resolve(path);
    const res = await this.fetch(this.url('/write', { path: resolved, createOnly: 'true' }), {
      method: 'PUT',
      body: new TextEncoder().encode(content),
    });
    if (res.status === 409) throw new VfsError(`File already exists: ${path}`, 'FILE_EXISTS');
    if (!res.ok) throw new VfsError(`create failed: ${res.status}`, 'INVALID_PATH');
  }

  async deleteFile(path: string): Promise<void> {
    assertWritable(path, this.namespace);
    const resolved = this.resolve(path);
    const res = await this.fetch(this.url('/rm', { path: resolved }), { method: 'DELETE' });
    if (!res.ok) throw new VfsError(`rm failed: ${res.status}`, 'PATH_NOT_FOUND');
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    assertWritable(path, this.namespace);
    const resolved = this.resolve(path);
    const params: Record<string, string> = { path: resolved };
    if (options?.recursive) params.recursive = 'true';
    const res = await this.fetch(this.url('/mkdir', params), { method: 'POST' });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const code: VfsErrorCode =
        errBody.code ?? (res.status === 409 ? 'DIR_EXISTS' : 'INVALID_PATH');
      throw new VfsError(errBody.error || `mkdir failed: ${res.status}`, code);
    }
  }

  async rmdir(path: string, _recursive = false): Promise<void> {
    assertWritable(path, this.namespace);
    if (isRootPath(path)) {
      // clearVfs is the way to wipe a project; rmdir('/') must not be.
      throw new VfsError('Cannot delete root directory', 'INVALID_PATH');
    }
    await this.removeTree(this.resolve(path));
  }

  private async removeTree(resolved: string): Promise<void> {
    const res = await this.fetch(this.url('/rmdir', { path: resolved }), { method: 'DELETE' });
    if (!res.ok) throw new VfsError(`rmdir failed: ${res.status}`, 'PATH_NOT_FOUND');
  }

  async rename(oldPath: string, newPath: string, overwrite?: boolean): Promise<void> {
    assertWritable(oldPath, this.namespace);
    assertWritable(newPath, this.namespace);
    // The /rename route always clobbers, so the overwrite guard lives here
    // (same check-then-act as copyFile).
    if (!overwrite && (await this.exists(newPath))) {
      throw new VfsError(`Destination already exists: ${newPath}`, 'DESTINATION_EXISTS');
    }
    const resolvedOld = this.resolve(oldPath);
    const resolvedNew = this.resolve(newPath);
    const res = await this.fetch(this.url('/rename'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: resolvedOld, to: resolvedNew }),
    });
    if (!res.ok) throw new VfsError(`rename failed: ${res.status}`, 'PATH_NOT_FOUND');
  }

  async exists(path: string): Promise<boolean> {
    const resolved = this.resolve(path);
    const res = await this.fetch(this.url('/exists', { path: resolved }));
    if (!res.ok) return false;
    const body = await res.json();
    return body.exists;
  }

  async isFile(path: string): Promise<boolean> {
    try {
      const s = await this.stat(path);
      return s.isFile;
    } catch {
      return false;
    }
  }

  async isDirectory(path: string): Promise<boolean> {
    if (path === '/') return true;
    try {
      const s = await this.stat(path);
      return s.isDirectory;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<VfsStat> {
    const resolved = this.resolve(path);
    const res = await this.fetch(this.url('/stat', { path: resolved }));
    if (!res.ok) throw new VfsError(`stat failed: ${res.status}`, 'PATH_NOT_FOUND');
    const body = await res.json();
    return {
      isFile: body.type === 'file',
      isDirectory: body.type === 'dir',
      size: body.size,
      createdAt: body.mtime,
      updatedAt: body.mtime,
      isBinary: false,
      mime: 'application/octet-stream',
    };
  }

  async hasVfs(): Promise<boolean> {
    // Remote VFS always "has" a VFS — the server directory exists
    return true;
  }

  async clearVfs(): Promise<void> {
    // Remove everything under project root (the namespace root when namespaced)
    await this.removeTree(this.resolve('/'));
  }

  // ============================
  // Text editing operations
  // ============================

  async strReplace(path: string, oldStr: string, newStr: string): Promise<StrReplaceResult> {
    assertWritable(path, this.namespace);
    const resolved = this.resolve(path);
    const res = await this.fetch(this.url('/str-replace', { path: resolved }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldStr, newStr }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: 'str-replace failed' }));
      const msg = errBody.error || `str-replace failed: ${res.status}`;
      if (msg.includes('not found')) throw new VfsError(msg, 'STRING_NOT_FOUND');
      if (msg.includes('not unique') || msg.includes('occurrences'))
        throw new VfsError(msg, 'STRING_NOT_UNIQUE');
      throw new VfsError(msg, 'INVALID_PATH');
    }
    return res.json();
  }

  async insert(path: string, line: number, text: string): Promise<InsertResult> {
    assertWritable(path, this.namespace);
    const resolved = this.resolve(path);
    const res = await this.fetch(this.url('/insert', { path: resolved }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ line, text }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: 'insert failed' }));
      throw new VfsError(errBody.error || `insert failed: ${res.status}`, 'INVALID_LINE');
    }
    return res.json();
  }

  async appendFile(path: string, text: string): Promise<{ created: boolean }> {
    assertWritable(path, this.namespace);
    const resolved = this.resolve(path);
    const res = await this.fetch(this.url('/append', { path: resolved }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new VfsError(`append failed: ${res.status}`, 'INVALID_PATH');
    return res.json();
  }

  // ============================
  // Bulk migration write
  // ============================

  async writeFileWithHistory(
    filePath: string,
    versions: Array<{ content: string; createdAt: number }>,
    currentContent: FileContent,
    _isBinary: boolean
  ): Promise<void> {
    // TODO: optimize with batch endpoint on vfs-backend
    for (const ver of versions) {
      await this.writeFile(filePath, ver.content);
    }
    await this.writeFile(filePath, currentContent);
  }

  // ============================
  // Versioning
  // ============================

  async getFileMeta(path: string) {
    const resolved = this.resolve(path);
    const res = await this.fetch(this.url('/file-meta', { path: resolved }));
    if (!res.ok) return null;
    const body = await res.json();
    return {
      version: body.version,
      createdAt: body.createdAt,
      updatedAt: body.createdAt,
      minStoredVersion: 1,
      storedVersionCount: body.version,
    };
  }

  async getFileId(path: string): Promise<string | null> {
    // For remote VFS, fileId is the resolved path
    const resolved = this.resolve(path);
    const ex = await this.exists(path);
    return ex ? resolved : null;
  }

  async listVersions(fileId: string): Promise<VersionInfo[]> {
    // fileId = path for remote VFS
    const res = await this.fetch(this.url('/versions', { path: fileId }));
    if (!res.ok) return [];
    const body = await res.json();
    return (body.versions as Array<{ version: number; createdAt: number }>).map(v => ({
      version: v.version,
      createdAt: v.createdAt,
    }));
  }

  async getVersion(fileId: string, version: number): Promise<string | null> {
    const res = await this.fetch(this.url('/version', { path: fileId, v: String(version) }));
    if (!res.ok) return null;
    return res.text();
  }

  async readAllVersions(fileId: string): Promise<Array<{ version: number; content: string }>> {
    const res = await this.fetch(this.url('/versions/bulk', { path: fileId }));
    if (res.status === 404) {
      // Old server without bulk endpoint — fall back to sequential reads
      const versions = await this.listVersions(fileId);
      const results: Array<{ version: number; content: string }> = [];
      for (const v of versions) {
        const content = await this.getVersion(fileId, v.version);
        if (content !== null) results.push({ version: v.version, content });
      }
      return results;
    }
    if (!res.ok) return [];
    const body = await res.json();
    const raw = body.versions as Array<{ version: number; content: string }>;

    const decoder = new TextDecoder();
    return raw.map(v => ({
      version: v.version,
      content: decoder.decode(base64ToUint8Array(v.content)),
    }));
  }

  async dropOldVersions(fileId: string, keepCount: number): Promise<number> {
    const res = await this.fetch(this.url('/versions', { path: fileId, keep: String(keepCount) }), {
      method: 'DELETE',
    });
    if (!res.ok) return 0;
    const body = await res.json();
    return body.deleted;
  }

  // ============================
  // Orphan management — no-op for remote VFS
  // ============================

  async listOrphans(): Promise<OrphanInfo[]> {
    return [];
  }

  async restoreOrphan(_fileId: string, _targetPath: string): Promise<void> {
    // No orphans in remote VFS
  }

  async purgeOrphan(_fileId: string): Promise<void> {
    // No orphans in remote VFS
  }

  // ============================
  // Compound operations
  // ============================

  async copyFile(src: string, dst: string, overwrite?: boolean): Promise<void> {
    assertWritable(dst, this.namespace);
    // readFileWithMeta/writeFile/exists/isDirectory already resolve paths internally
    const destIsDir = await this.isDirectory(dst);
    if (destIsDir) {
      throw new VfsError(`Destination is a directory: ${dst}`, 'NOT_A_FILE');
    }
    if (!overwrite) {
      const destExists = await this.exists(dst);
      if (destExists) {
        throw new VfsError(`Destination already exists: ${dst}`, 'DESTINATION_EXISTS');
      }
    }
    const source = await this.readFileWithMeta(src);
    if (source.isBinary) {
      await this.writeFile(dst, source.buffer!);
    } else {
      await this.writeFile(dst, source.content);
    }
  }

  async deletePath(path: string): Promise<void> {
    const [result] = await this.deletePaths([path], true);
    if (result.error) throw new VfsError(result.error.message, result.error.code);
  }

  async deletePaths(paths: string[], recursive: boolean): Promise<DeletePathResult[]> {
    const results: DeletePathResult[] = new Array(paths.length);
    const sendIndexes: number[] = [];
    const sendPaths: string[] = [];
    paths.forEach((path, i) => {
      try {
        assertWritable(path, this.namespace);
        if (isRootPath(path)) {
          throw new VfsError('Cannot delete root directory', 'INVALID_PATH');
        }
        sendIndexes.push(i);
        sendPaths.push(this.resolve(path));
      } catch (error) {
        if (!(error instanceof VfsError)) throw error;
        results[i] = { path, error: { code: error.code, message: error.message } };
      }
    });
    if (sendPaths.length === 0) return results;

    const res = await this.fetch(this.url('/rm-many'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: sendPaths, recursive }),
    });
    let serverResults: DeletePathResult[];
    if (res.status === 404) {
      // VFS server predating /rm-many
      serverResults = await this.deletePathsOneByOne(sendPaths, recursive);
    } else if (res.ok) {
      serverResults = (await res.json()).results;
    } else {
      const errBody = await res.json().catch(() => ({}));
      throw new VfsError(errBody.error || `rm-many failed: ${res.status}`, 'INVALID_PATH');
    }

    sendIndexes.forEach((originalIndex, i) => {
      // Report against the caller's path, not the namespace-resolved one.
      results[originalIndex] = { ...serverResults[i], path: paths[originalIndex] };
    });
    return results;
  }

  /** `/rm-many` semantics on top of the per-path endpoints, for older servers. */
  private async deletePathsOneByOne(
    resolvedPaths: string[],
    recursive: boolean
  ): Promise<DeletePathResult[]> {
    const deleted = new Set<string>();
    const results: DeletePathResult[] = [];
    for (const path of resolvedPaths) {
      const normalized = normalizePath(path);
      if (isCoveredByDeleted(normalized, deleted)) {
        results.push({ path });
        continue;
      }
      const statRes = await this.fetch(this.url('/stat', { path: normalized }));
      if (!statRes.ok) {
        results.push({
          path,
          error: { code: 'PATH_NOT_FOUND', message: `Path not found: ${normalized}` },
        });
        continue;
      }
      const isDirectory = (await statRes.json()).type === 'dir';
      if (isDirectory && !recursive) {
        results.push({
          path,
          error: { code: 'NOT_A_FILE', message: `Is a directory: ${normalized}` },
        });
        continue;
      }
      if (isDirectory && isRootPath(normalized)) {
        results.push({
          path,
          error: { code: 'INVALID_PATH', message: 'Cannot delete root directory' },
        });
        continue;
      }
      const rmRes = await this.fetch(
        this.url(isDirectory ? '/rmdir' : '/rm', { path: normalized }),
        {
          method: 'DELETE',
        }
      );
      if (rmRes.ok) {
        deleted.add(normalized);
        results.push({ path });
      } else {
        results.push({
          path,
          error: {
            code: 'IO_ERROR',
            message: `EIO: delete failed (${rmRes.status}), '${normalized}'`,
          },
        });
      }
    }
    return results;
  }

  async createFileGuarded(path: string, content: FileContent, overwrite?: boolean): Promise<void> {
    // writeFile/createFile/exists already resolve and assertWritable
    if (overwrite) {
      await this.writeFile(path, content);
    } else {
      if (isBinaryContent(content)) {
        const pathExists = await this.exists(path);
        if (pathExists) {
          throw new VfsError(`File already exists: ${path}`, 'FILE_EXISTS');
        }
        await this.writeFile(path, content);
      } else {
        await this.createFile(path, content);
      }
    }
  }

  async ensureDirAndWrite(
    dir: string,
    files: Array<{ name: string; content: string }>
  ): Promise<void> {
    // mkdir/writeFile already resolve and assertWritable
    await this.mkdir(dir, { recursive: true });
    for (const file of files) {
      const filePath = dir.endsWith('/') ? `${dir}${file.name}` : `${dir}/${file.name}`;
      await this.writeFile(filePath, file.content);
    }
  }

  // ============================
  // Compact
  // ============================

  async compactProject(
    onProgress?: (p: CompactProgress) => void,
    _options?: CompactOptions
  ): Promise<CompactResult> {
    onProgress?.({ phase: 'pruning-revisions', current: 0, total: 1 });

    const res = await this.fetch(this.url('/compact'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keepCount: 10 }),
    });

    if (!res.ok) {
      onProgress?.({ phase: 'done', current: 0, total: 0 });
      return {
        purgedNodes: 0,
        purgedOrphans: 0,
        prunedRevisions: 0,
        collapsedFiles: 0,
        treeNodes: 0,
        fileCount: 0,
        totalRevisions: 0,
      };
    }

    const body = await res.json();
    onProgress?.({ phase: 'done', current: 0, total: 0 });

    return {
      purgedNodes: 0,
      purgedOrphans: 0,
      prunedRevisions: body.versionsDropped,
      collapsedFiles: body.filesProcessed,
      treeNodes: 0,
      fileCount: body.filesProcessed,
      totalRevisions: 0,
    };
  }
}
