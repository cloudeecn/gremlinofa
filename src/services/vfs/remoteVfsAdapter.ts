/**
 * RemoteVfsAdapter — HTTP adapter for the vfs-backend server.
 *
 * Each method maps to a vfs-backend API endpoint. No client-side tree lock —
 * the server handles per-file locking.
 *
 * When encrypt=true, content is encrypted/decrypted via encryptionService.
 * Compound ops (strReplace, insert, append) fall back to client-side
 * read-modify-write when encrypted (server can't read the content).
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
import {
  VfsError,
  isBinaryContent,
  detectMimeFromBuffer,
  resolveNamespacedPath,
  assertWritable,
} from './vfsService';
import { encryptionService } from '../encryption/encryptionService';

export class RemoteVfsAdapter implements VfsAdapter {
  private baseUrl: string;
  private authHeader: string;
  private projectId: string;
  private encrypt: boolean;
  private namespace?: string;

  constructor(
    baseUrl: string,
    userId: string,
    password: string,
    projectId: string,
    encrypt: boolean,
    namespace?: string
  ) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.authHeader = 'Basic ' + btoa(`${userId}:${password}`);
    this.projectId = projectId;
    this.encrypt = encrypt;
    this.namespace = namespace;
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

  private async encryptContent(content: string): Promise<string> {
    if (!this.encrypt) return content;
    return encryptionService.encrypt(content);
  }

  private async decryptContent(content: string): Promise<string> {
    if (!this.encrypt) return content;
    return encryptionService.decrypt(content);
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
    const text = await res.text();
    return this.decryptContent(text);
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
      let text = decoder.decode(bytes);
      text = await this.decryptContent(text);
      return { content: text, isBinary: false, mime: 'text/plain' };
    } catch {
      // Binary content
      const mime = detectMimeFromBuffer(buffer);
      // Base64 encode for consistency with local VFS
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return { content: btoa(binary), isBinary: true, mime, buffer };
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
      const encrypted = await this.encryptContent(content);
      body = new Blob([encrypted]);
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
    const encrypted = await this.encryptContent(content);
    const res = await this.fetch(this.url('/write', { path: resolved, createOnly: 'true' }), {
      method: 'PUT',
      body: new TextEncoder().encode(encrypted),
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

  async mkdir(path: string): Promise<void> {
    assertWritable(path, this.namespace);
    const resolved = this.resolve(path);
    const res = await this.fetch(this.url('/mkdir', { path: resolved }), { method: 'POST' });
    if (!res.ok) throw new VfsError(`mkdir failed: ${res.status}`, 'INVALID_PATH');
  }

  async rmdir(path: string, _recursive = false): Promise<void> {
    assertWritable(path, this.namespace);
    const resolved = this.resolve(path);
    const res = await this.fetch(this.url('/rmdir', { path: resolved }), { method: 'DELETE' });
    if (!res.ok) throw new VfsError(`rmdir failed: ${res.status}`, 'PATH_NOT_FOUND');
  }

  async rename(oldPath: string, newPath: string, _overwrite?: boolean): Promise<void> {
    assertWritable(oldPath, this.namespace);
    assertWritable(newPath, this.namespace);
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
    // Remove everything under project root
    await this.rmdir('/', true);
  }

  // ============================
  // Text editing operations
  // ============================

  async strReplace(path: string, oldStr: string, newStr: string): Promise<StrReplaceResult> {
    assertWritable(path, this.namespace);
    if (this.encrypt) {
      // Client-side fallback: read → modify → write (readFile/writeFile already resolve)
      const content = await this.readFile(path);
      const count = content.split(oldStr).length - 1;
      if (count === 0) throw new VfsError('String not found', 'STRING_NOT_FOUND');
      if (count > 1) throw new VfsError(`${count} occurrences found`, 'STRING_NOT_UNIQUE');

      const pos = content.indexOf(oldStr);
      const editLine = content.substring(0, pos).split('\n').length;
      const newContent = content.replace(oldStr, newStr);

      const lines = newContent.split('\n');
      const start = Math.max(0, editLine - 1 - 3);
      const end = Math.min(lines.length, editLine + 3);
      const snippet = lines
        .slice(start, end)
        .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
        .join('\n');

      await this.writeFile(path, newContent);
      return { editLine, snippet };
    }

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
    if (this.encrypt) {
      // readFile/writeFile already resolve
      const content = await this.readFile(path);
      const lines = content.split('\n');
      if (line < 0 || line > lines.length)
        throw new VfsError(`Invalid line ${line}`, 'INVALID_LINE');
      const textLines = text.split('\n');
      lines.splice(line, 0, ...textLines);
      await this.writeFile(path, lines.join('\n'));
      return { insertedAt: line };
    }

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
    if (this.encrypt) {
      // exists/readFile/writeFile already resolve
      const fileExists = await this.exists(path);
      if (fileExists) {
        const content = await this.readFile(path);
        await this.writeFile(path, content + text);
        return { created: false };
      }
      await this.writeFile(path, text);
      return { created: true };
    }

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
    const text = await res.text();
    return this.decryptContent(text);
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
    // deleteFile/rmdir already resolve and assertWritable
    try {
      await this.deleteFile(path);
    } catch (error) {
      if (error instanceof VfsError && error.code === 'PATH_NOT_FOUND') {
        // Might be a directory — try rmdir
        await this.rmdir(path, true);
      } else {
        throw error;
      }
    }
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
    // mkdir/isDirectory/writeFile already resolve and assertWritable
    const dirExists = await this.isDirectory(dir);
    if (!dirExists) {
      await this.mkdir(dir);
    }
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
