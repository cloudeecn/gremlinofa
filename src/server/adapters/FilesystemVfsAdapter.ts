/**
 * Filesystem-backed VFS adapter for the Node server deployment.
 *
 * Thin wrapper over the shared `vfsEngine` — files live at
 * `${basePath}/${projectId}/${filepath}` as real files on disk, browsable and
 * editable outside the app. Versioning uses hidden `.{filename}.ver/`
 * directories.
 *
 * Path resolution + symlink policy come from `VfsAccessConfig` injected at
 * construction time (see `vfsEngine/accessConfig.ts`).
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { VfsAdapter } from '../../shared/services/vfs/vfsAdapter';
import type {
  CompactOptions,
  CompactProgress,
  CompactResult,
  DirEntry,
  FileContent,
  InsertResult,
  OrphanInfo,
  ReadFileResult,
  StrReplaceResult,
  VfsStat,
  VersionInfo,
} from '../../shared/services/vfs/vfsService';
import { VfsError, detectMimeFromBuffer } from '../../shared/services/vfs/vfsService';
import * as engine from '../vfsEngine/fsEngine.js';
import type { VfsContext } from '../vfsEngine/fsEngine.js';
import { type VfsAccessConfig, getAllowedRootsForProject } from '../vfsEngine/accessConfig.js';
import { isVersionDir, saveVersion } from '../vfsEngine/versioning.js';
import { withFileLock } from '../vfsEngine/fileLock.js';

// ============================================================================
// Helpers
// ============================================================================

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function verDir(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return path.join(dir, `.${base}.ver`);
}

async function readMeta(
  filePath: string
): Promise<{ currentVersion: number; createdAt: number } | null> {
  try {
    const raw = await fs.readFile(path.join(verDir(filePath), 'meta.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function fileContentToBuffer(content: FileContent): Buffer | string {
  if (typeof content === 'string') return content;
  if (content instanceof Uint8Array) {
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  }
  if (content instanceof ArrayBuffer) {
    return Buffer.from(content);
  }
  // Unreachable under FileContent type. Reject at runtime rather than coerce.
  throw new VfsError('Unsupported file content type', 'INVALID_PATH');
}

function isBinaryBuffer(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return false;
  } catch {
    return true;
  }
}

function bufferToBase64(buf: Buffer): string {
  return buf.toString('base64');
}

function bufferToArrayBufferCopy(buf: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

/**
 * Translate engine FsError (and bare Errors thrown by node fs) into the
 * VfsError shape adapter callers expect.
 */
function translateError(e: unknown): never {
  if (e instanceof engine.FsError) {
    throw new VfsError(e.message, 'INVALID_PATH');
  }
  throw e;
}

// ============================================================================
// Adapter
// ============================================================================

export class FilesystemVfsAdapter implements VfsAdapter {
  private readonly root: string;
  private readonly ctx: VfsContext;

  constructor(basePath: string, projectId: string, accessConfig: VfsAccessConfig) {
    this.root = path.join(basePath, projectId);
    // Ensure project root exists so realpath works, then canonicalize. This
    // also keeps the prior "auto-create on first touch" UX without making
    // readDir responsible for it.
    fsSync.mkdirSync(this.root, { recursive: true });
    const projectRoot = fsSync.realpathSync(this.root);
    this.ctx = {
      projectRoot,
      allowedRoots: getAllowedRootsForProject(accessConfig, projectId, projectRoot),
      followSymlinks: accessConfig.followSymlinks,
    };
    console.debug('[FilesystemVfs] Adapter created, root:', projectRoot);
  }

  private async resolveCanonical(vfsPath: string, opts?: { forWrite?: boolean }): Promise<string> {
    try {
      return await engine.resolveCanonicalPath(vfsPath, this.ctx, opts);
    } catch (e) {
      translateError(e);
    }
  }

  // --------------------------------------------------------------------------
  // Basic CRUD
  // --------------------------------------------------------------------------

  async readDir(dirPath: string, _includeDeleted?: boolean): Promise<DirEntry[]> {
    const abs = await this.resolveCanonical(dirPath);

    const entries = await fs.readdir(abs, { withFileTypes: true });
    const results: DirEntry[] = [];

    for (const entry of entries) {
      // Hide all dotfiles (version dirs and other hidden files)
      if (entry.name.startsWith('.')) continue;
      // In follow=off mode, drop symlinks entirely — they're refused at access
      // time, so listing them would be a lie. In follow=on mode the per-op
      // resolveCanonicalPath handles allow-list enforcement on individual reads.
      if (!this.ctx.followSymlinks && entry.isSymbolicLink()) continue;

      const fullPath = path.join(abs, entry.name);
      const stat = await fs.stat(fullPath);
      const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && stat.isDirectory());

      results.push({
        name: entry.name,
        type: isDirectory ? 'dir' : 'file',
        deleted: false,
        createdAt: stat.mtimeMs,
        updatedAt: stat.mtimeMs,
        size: isDirectory ? undefined : stat.size,
      });
    }

    // Sort: directories first, then alphabetical
    results.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return results;
  }

  async readFile(filePath: string): Promise<string> {
    const abs = await this.resolveCanonical(filePath);
    const buf = await fs.readFile(abs);
    if (isBinaryBuffer(buf)) {
      throw new VfsError(`Cannot read binary file as text: ${filePath}`, 'BINARY_FILE');
    }
    return buf.toString('utf-8');
  }

  async readFileWithMeta(filePath: string): Promise<ReadFileResult> {
    const abs = await this.resolveCanonical(filePath);
    const buf = await fs.readFile(abs);
    if (isBinaryBuffer(buf)) {
      const arrayBuffer = bufferToArrayBufferCopy(buf);
      const sniffed = detectMimeFromBuffer(arrayBuffer);
      const mime =
        sniffed !== 'application/octet-stream' ? sniffed : engine.detectMimeByExtension(abs);
      return {
        content: bufferToBase64(buf),
        isBinary: true,
        mime,
        buffer: arrayBuffer,
      };
    }
    return {
      content: buf.toString('utf-8'),
      isBinary: false,
      mime: 'text/plain',
    };
  }

  async writeFile(filePath: string, content: FileContent): Promise<void> {
    const abs = await this.resolveCanonical(filePath, { forWrite: true });
    await withFileLock(abs, async () => {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, fileContentToBuffer(content));
      await saveVersion(abs);
    });
  }

  async createFile(filePath: string, content: string): Promise<void> {
    const abs = await this.resolveCanonical(filePath, { forWrite: true });
    if (await pathExists(abs)) {
      throw new Error(`File already exists: ${filePath}`);
    }
    await withFileLock(abs, async () => {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf-8');
      await saveVersion(abs);
    });
  }

  async deleteFile(filePath: string): Promise<void> {
    const abs = await this.resolveCanonical(filePath);
    await withFileLock(abs, async () => {
      await fs.unlink(abs);
      // Clean up version directory
      const vd = verDir(abs);
      if (await pathExists(vd)) {
        await fs.rm(vd, { recursive: true });
      }
    });
  }

  async mkdir(dirPath: string): Promise<void> {
    const abs = await this.resolveCanonical(dirPath, { forWrite: true });
    await fs.mkdir(abs, { recursive: true });
  }

  async rmdir(dirPath: string, recursive?: boolean): Promise<void> {
    const abs = await this.resolveCanonical(dirPath);
    if (recursive) {
      await fs.rm(abs, { recursive: true });
    } else {
      await fs.rmdir(abs);
    }
  }

  async rename(oldPath: string, newPath: string, overwrite?: boolean): Promise<void> {
    const absOld = await this.resolveCanonical(oldPath);
    const absNew = await this.resolveCanonical(newPath, { forWrite: true });
    if (!overwrite && (await pathExists(absNew))) {
      throw new Error(`Target already exists: ${newPath}`);
    }
    await fs.mkdir(path.dirname(absNew), { recursive: true });
    await fs.rename(absOld, absNew);
    // Move version directory too
    const oldVd = verDir(absOld);
    if (await pathExists(oldVd)) {
      const newVd = verDir(absNew);
      await fs.rename(oldVd, newVd);
    }
  }

  async exists(filePath: string): Promise<boolean> {
    return pathExists(await this.resolveCanonical(filePath));
  }

  async isFile(filePath: string): Promise<boolean> {
    try {
      return (await fs.stat(await this.resolveCanonical(filePath))).isFile();
    } catch {
      return false;
    }
  }

  async isDirectory(dirPath: string): Promise<boolean> {
    return isDir(await this.resolveCanonical(dirPath));
  }

  async stat(filePath: string): Promise<VfsStat> {
    const abs = await this.resolveCanonical(filePath);
    const st = await fs.stat(abs);
    return {
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
      size: st.size,
      createdAt: st.birthtimeMs,
      updatedAt: st.mtimeMs,
      isBinary: false,
      mime: st.isDirectory() ? '' : engine.detectMimeByExtension(abs),
    };
  }

  async hasVfs(): Promise<boolean> {
    return isDir(this.ctx.projectRoot);
  }

  async clearVfs(): Promise<void> {
    if (await pathExists(this.ctx.projectRoot)) {
      await fs.rm(this.ctx.projectRoot, { recursive: true });
    }
  }

  // --------------------------------------------------------------------------
  // Text editing operations
  // --------------------------------------------------------------------------

  async strReplace(filePath: string, oldStr: string, newStr: string): Promise<StrReplaceResult> {
    const abs = await this.resolveCanonical(filePath);
    return withFileLock(abs, async () => {
      const content = await fs.readFile(abs, 'utf-8');
      const idx = content.indexOf(oldStr);
      if (idx === -1) {
        throw new Error(`String not found in ${filePath}`);
      }
      // Check uniqueness
      if (content.indexOf(oldStr, idx + 1) !== -1) {
        throw new Error(`String is not unique in ${filePath}`);
      }
      const updated = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
      await fs.writeFile(abs, updated, 'utf-8');
      await saveVersion(abs);
      const editLine = content.slice(0, idx).split('\n').length;
      const lines = updated.split('\n');
      const snippetStart = Math.max(0, editLine - 2);
      const snippetEnd = Math.min(lines.length, editLine + 3);
      return {
        editLine,
        snippet: lines.slice(snippetStart, snippetEnd).join('\n'),
      };
    });
  }

  async insert(filePath: string, line: number, text: string): Promise<InsertResult> {
    const abs = await this.resolveCanonical(filePath);
    return withFileLock(abs, async () => {
      const content = await fs.readFile(abs, 'utf-8');
      const lines = content.split('\n');
      const insertAt = Math.max(0, Math.min(line - 1, lines.length));
      lines.splice(insertAt, 0, text);
      await fs.writeFile(abs, lines.join('\n'), 'utf-8');
      await saveVersion(abs);
      return { insertedAt: insertAt + 1 };
    });
  }

  async appendFile(filePath: string, text: string): Promise<{ created: boolean }> {
    const abs = await this.resolveCanonical(filePath, { forWrite: true });
    const fileExists = await pathExists(abs);
    await withFileLock(abs, async () => {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.appendFile(abs, text, 'utf-8');
      await saveVersion(abs);
    });
    return { created: !fileExists };
  }

  // --------------------------------------------------------------------------
  // Bulk migration write
  // --------------------------------------------------------------------------

  async writeFileWithHistory(
    filePath: string,
    versions: Array<{ content: string; createdAt: number }>,
    currentContent: FileContent,
    isBinary: boolean
  ): Promise<void> {
    const abs = await this.resolveCanonical(filePath, { forWrite: true });
    const vd = verDir(abs);

    // Create dirs once
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.mkdir(vd, { recursive: true });

    // Write historical versions directly to .ver/N (no intermediate file + copy).
    // For binary files the `content` strings are base64-encoded bytes (matching
    // the vfsService VfsVersion format); decode before writing so the disk
    // bytes match the original. A file's binary-ness is stable across its
    // version history because vfsService orphans the fileId on type change.
    for (let i = 0; i < versions.length; i++) {
      const data: Buffer | string = isBinary
        ? Buffer.from(versions[i].content, 'base64')
        : versions[i].content;
      await fs.writeFile(path.join(vd, String(i + 1)), data);
    }

    // Write current content as actual file
    await fs.writeFile(abs, fileContentToBuffer(currentContent));

    // Copy current to version slot + write meta once
    const totalVersion = versions.length + 1;
    await fs.copyFile(abs, path.join(vd, String(totalVersion)));
    await fs.mkdir(vd, { recursive: true });
    await fs.writeFile(
      path.join(vd, 'meta.json'),
      JSON.stringify({
        currentVersion: totalVersion,
        createdAt: versions.length > 0 ? versions[0].createdAt : Date.now(),
      })
    );
  }

  // --------------------------------------------------------------------------
  // Versioning
  // --------------------------------------------------------------------------

  async getFileMeta(filePath: string): Promise<{
    version: number;
    createdAt: number;
    updatedAt: number;
    minStoredVersion: number;
    storedVersionCount: number;
  } | null> {
    const abs = await this.resolveCanonical(filePath);
    if (!(await pathExists(abs))) return null;

    const meta = await readMeta(abs);
    const st = await fs.stat(abs);

    if (!meta) {
      return {
        version: 0,
        createdAt: st.birthtimeMs,
        updatedAt: st.mtimeMs,
        minStoredVersion: 0,
        storedVersionCount: 0,
      };
    }

    // Count stored versions
    const vd = verDir(abs);
    let minVer = Infinity;
    let count = 0;
    try {
      const entries = await fs.readdir(vd);
      for (const name of entries) {
        if (name === 'meta.json') continue;
        const ver = parseInt(name, 10);
        if (!Number.isNaN(ver)) {
          count++;
          if (ver < minVer) minVer = ver;
        }
      }
    } catch {
      // No version directory
    }

    return {
      version: meta.currentVersion,
      createdAt: meta.createdAt,
      updatedAt: st.mtimeMs,
      minStoredVersion: count > 0 ? minVer : 0,
      storedVersionCount: count,
    };
  }

  async getFileId(filePath: string): Promise<string | null> {
    // Filesystem adapter uses the path as the file ID
    const abs = await this.resolveCanonical(filePath);
    if (!(await pathExists(abs))) return null;
    return filePath;
  }

  async listVersions(fileId: string): Promise<VersionInfo[]> {
    const abs = await this.resolveCanonical(fileId);
    const vd = verDir(abs);

    try {
      const entries = await fs.readdir(vd);
      const validEntries = entries
        .filter(name => name !== 'meta.json')
        .map(name => ({ name, version: parseInt(name, 10) }))
        .filter(e => !Number.isNaN(e.version));

      const versions = await Promise.all(
        validEntries.map(async e => {
          const st = await fs.stat(path.join(vd, e.name));
          return { version: e.version, createdAt: st.mtimeMs };
        })
      );

      versions.sort((a, b) => a.version - b.version);
      return versions;
    } catch {
      return [];
    }
  }

  async getVersion(fileId: string, version: number): Promise<string | null> {
    const abs = await this.resolveCanonical(fileId);
    const versionPath = path.join(verDir(abs), String(version));
    try {
      const buf = await fs.readFile(versionPath);
      return isBinaryBuffer(buf) ? buf.toString('base64') : buf.toString('utf-8');
    } catch {
      return null;
    }
  }

  async dropOldVersions(fileId: string, keepCount: number): Promise<number> {
    const abs = await this.resolveCanonical(fileId);
    const vd = verDir(abs);
    let dropped = 0;

    try {
      const entries = await fs.readdir(vd);
      const versions: number[] = [];
      for (const name of entries) {
        if (name === 'meta.json') continue;
        const ver = parseInt(name, 10);
        if (!Number.isNaN(ver)) versions.push(ver);
      }
      versions.sort((a, b) => a - b);

      const toDrop = versions.slice(0, Math.max(0, versions.length - keepCount));
      for (const ver of toDrop) {
        await fs.unlink(path.join(vd, String(ver)));
        dropped++;
      }
    } catch {
      // No versions to drop
    }

    return dropped;
  }

  // --------------------------------------------------------------------------
  // Orphan management (no-op for filesystem — orphans are a database concept)
  // --------------------------------------------------------------------------

  async listOrphans(): Promise<OrphanInfo[]> {
    return [];
  }

  async restoreOrphan(_fileId: string, _targetPath: string): Promise<void> {
    throw new Error('Orphan management not supported on filesystem VFS');
  }

  async purgeOrphan(_fileId: string): Promise<void> {
    throw new Error('Orphan management not supported on filesystem VFS');
  }

  // --------------------------------------------------------------------------
  // Compound operations
  // --------------------------------------------------------------------------

  async copyFile(src: string, dst: string, overwrite?: boolean): Promise<void> {
    const absSrc = await this.resolveCanonical(src);
    const absDst = await this.resolveCanonical(dst, { forWrite: true });
    if (!overwrite && (await pathExists(absDst))) {
      throw new Error(`Target already exists: ${dst}`);
    }
    await fs.mkdir(path.dirname(absDst), { recursive: true });
    await fs.copyFile(absSrc, absDst);
    await saveVersion(absDst);
  }

  async deletePath(filePath: string): Promise<void> {
    const abs = await this.resolveCanonical(filePath);
    try {
      const st = await fs.stat(abs);
      if (st.isDirectory()) {
        await fs.rm(abs, { recursive: true });
      } else {
        await this.deleteFile(filePath);
      }
    } catch {
      // Path doesn't exist — no-op
    }
  }

  async createFileGuarded(
    filePath: string,
    content: FileContent,
    overwrite?: boolean
  ): Promise<void> {
    if (overwrite) {
      await this.writeFile(filePath, content);
      return;
    }
    const abs = await this.resolveCanonical(filePath, { forWrite: true });
    if (await pathExists(abs)) {
      throw new VfsError(`File already exists: ${filePath}`, 'FILE_EXISTS');
    }
    await this.writeFile(filePath, content);
  }

  async ensureDirAndWrite(
    dir: string,
    files: Array<{ name: string; content: string }>
  ): Promise<void> {
    await this.mkdir(dir);
    for (const file of files) {
      const filePath = dir.endsWith('/') ? `${dir}${file.name}` : `${dir}/${file.name}`;
      await this.writeFile(filePath, file.content);
    }
  }

  // --------------------------------------------------------------------------
  // Compact
  // --------------------------------------------------------------------------

  async compactProject(
    onProgress?: (p: CompactProgress) => void,
    options?: CompactOptions
  ): Promise<CompactResult> {
    const result: CompactResult = {
      purgedNodes: 0,
      purgedOrphans: 0,
      prunedRevisions: 0,
      collapsedFiles: 0,
      treeNodes: 0,
      fileCount: 0,
      totalRevisions: 0,
    };

    onProgress?.({ phase: 'scanning', current: 0, total: 0 });

    if (!(await pathExists(this.ctx.projectRoot))) {
      onProgress?.({ phase: 'done', current: 0, total: 0 });
      return result;
    }

    // Walk tree and count files + prune old versions
    const walk = async (dirPath: string) => {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (isVersionDir(entry.name)) continue;
        // Skip symlinks during compact — we're operating on this project's
        // storage, not external mounts that might be linked in.
        if (entry.isSymbolicLink()) continue;

        const fullPath = path.join(dirPath, entry.name);
        result.treeNodes++;

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else {
          result.fileCount++;
          // Prune versions older than keepCount (default: keep 5)
          const vd = verDir(fullPath);
          if (await pathExists(vd)) {
            const verEntries = await fs.readdir(vd);
            const versions: number[] = [];
            for (const name of verEntries) {
              if (name === 'meta.json') continue;
              const ver = parseInt(name, 10);
              if (!Number.isNaN(ver)) versions.push(ver);
            }
            versions.sort((a, b) => a - b);
            result.totalRevisions += versions.length;

            const keepCount = options?.purgeAllDeleted ? 1 : 5;
            const toDrop = versions.slice(0, Math.max(0, versions.length - keepCount));
            for (const ver of toDrop) {
              await fs.unlink(path.join(vd, String(ver)));
              result.prunedRevisions++;
            }
          }
        }
      }
    };

    onProgress?.({ phase: 'pruning-revisions', current: 0, total: 0 });
    await walk(this.ctx.projectRoot);

    onProgress?.({ phase: 'done', current: result.fileCount, total: result.fileCount });
    return result;
  }
}
