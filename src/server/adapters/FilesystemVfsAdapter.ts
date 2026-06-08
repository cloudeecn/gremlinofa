/**
 * Filesystem-backed VFS adapter for the Node server deployment.
 *
 * Thin wrapper over the shared `vfsEngine` — files live at
 * `${basePath}/${projectId}/${filepath}` as real files on disk, browsable and
 * editable outside the app. Versioning uses hidden `.{filename}.ver/`
 * directories.
 */

import fs from 'node:fs/promises';
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
import * as engine from '../vfsEngine/fsEngine.js';
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

function fileContentToString(content: FileContent): string {
  if (typeof content === 'string') return content;
  if (content instanceof ArrayBuffer) {
    return new TextDecoder().decode(content);
  }
  if (content instanceof Uint8Array) {
    return new TextDecoder().decode(content);
  }
  return String(content);
}

// ============================================================================
// Adapter
// ============================================================================

export class FilesystemVfsAdapter implements VfsAdapter {
  private readonly root: string;

  constructor(basePath: string, projectId: string) {
    this.root = path.join(basePath, projectId);
    console.debug('[FilesystemVfs] Adapter created, root:', this.root);
  }

  private resolve(vfsPath: string): string {
    // Normalize: strip leading slash, prevent path traversal
    const normalized = vfsPath.replace(/^\/+/, '');
    const resolved = path.resolve(this.root, normalized);
    if (!resolved.startsWith(path.resolve(this.root))) {
      throw new Error(`Path traversal detected: ${vfsPath}`);
    }
    return resolved;
  }

  // --------------------------------------------------------------------------
  // Basic CRUD
  // --------------------------------------------------------------------------

  async readDir(dirPath: string, _includeDeleted?: boolean): Promise<DirEntry[]> {
    const abs = this.resolve(dirPath);
    await fs.mkdir(abs, { recursive: true });

    const entries = await fs.readdir(abs, { withFileTypes: true });
    const results: DirEntry[] = [];

    for (const entry of entries) {
      // Hide all dotfiles (version dirs and other hidden files)
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(abs, entry.name);
      const stat = await fs.stat(fullPath);

      results.push({
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
        deleted: false,
        createdAt: stat.mtimeMs,
        updatedAt: stat.mtimeMs,
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
    const abs = this.resolve(filePath);
    return fs.readFile(abs, 'utf-8');
  }

  async readFileWithMeta(filePath: string): Promise<ReadFileResult> {
    const abs = this.resolve(filePath);
    const content = await fs.readFile(abs, 'utf-8');
    return {
      content,
      isBinary: false,
      mime: engine.detectMimeByExtension(abs),
    };
  }

  async writeFile(filePath: string, content: FileContent): Promise<void> {
    const abs = this.resolve(filePath);
    await withFileLock(abs, async () => {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, fileContentToString(content), 'utf-8');
      await saveVersion(abs);
    });
  }

  async createFile(filePath: string, content: string): Promise<void> {
    const abs = this.resolve(filePath);
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
    const abs = this.resolve(filePath);
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
    const abs = this.resolve(dirPath);
    await fs.mkdir(abs, { recursive: true });
  }

  async rmdir(dirPath: string, recursive?: boolean): Promise<void> {
    const abs = this.resolve(dirPath);
    if (recursive) {
      await fs.rm(abs, { recursive: true });
    } else {
      await fs.rmdir(abs);
    }
  }

  async rename(oldPath: string, newPath: string, overwrite?: boolean): Promise<void> {
    const absOld = this.resolve(oldPath);
    const absNew = this.resolve(newPath);
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
    return pathExists(this.resolve(filePath));
  }

  async isFile(filePath: string): Promise<boolean> {
    try {
      return (await fs.stat(this.resolve(filePath))).isFile();
    } catch {
      return false;
    }
  }

  async isDirectory(dirPath: string): Promise<boolean> {
    return isDir(this.resolve(dirPath));
  }

  async stat(filePath: string): Promise<VfsStat> {
    const abs = this.resolve(filePath);
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
    return isDir(this.root);
  }

  async clearVfs(): Promise<void> {
    if (await pathExists(this.root)) {
      await fs.rm(this.root, { recursive: true });
    }
  }

  // --------------------------------------------------------------------------
  // Text editing operations
  // --------------------------------------------------------------------------

  async strReplace(filePath: string, oldStr: string, newStr: string): Promise<StrReplaceResult> {
    const abs = this.resolve(filePath);
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
    const abs = this.resolve(filePath);
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
    const abs = this.resolve(filePath);
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
    _isBinary: boolean
  ): Promise<void> {
    const abs = this.resolve(filePath);
    const vd = verDir(abs);

    // Create dirs once
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.mkdir(vd, { recursive: true });

    // Write historical versions directly to .ver/N (no intermediate file + copy)
    for (let i = 0; i < versions.length; i++) {
      await fs.writeFile(path.join(vd, String(i + 1)), versions[i].content, 'utf-8');
    }

    // Write current content as actual file
    await fs.writeFile(abs, fileContentToString(currentContent), 'utf-8');

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
    const abs = this.resolve(filePath);
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
    const abs = this.resolve(filePath);
    if (!(await pathExists(abs))) return null;
    return filePath;
  }

  async listVersions(fileId: string): Promise<VersionInfo[]> {
    const abs = this.resolve(fileId);
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
    const abs = this.resolve(fileId);
    const versionPath = path.join(verDir(abs), String(version));
    try {
      return await fs.readFile(versionPath, 'utf-8');
    } catch {
      return null;
    }
  }

  async dropOldVersions(fileId: string, keepCount: number): Promise<number> {
    const abs = this.resolve(fileId);
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
    const absSrc = this.resolve(src);
    const absDst = this.resolve(dst);
    if (!overwrite && (await pathExists(absDst))) {
      throw new Error(`Target already exists: ${dst}`);
    }
    await fs.mkdir(path.dirname(absDst), { recursive: true });
    await fs.copyFile(absSrc, absDst);
    await saveVersion(absDst);
  }

  async deletePath(filePath: string): Promise<void> {
    const abs = this.resolve(filePath);
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
    } else {
      await this.createFile(filePath, fileContentToString(content));
    }
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

    if (!(await pathExists(this.root))) {
      onProgress?.({ phase: 'done', current: 0, total: 0 });
      return result;
    }

    // Walk tree and count files + prune old versions
    const walk = async (dirPath: string) => {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (isVersionDir(entry.name)) continue;

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
    await walk(this.root);

    onProgress?.({ phase: 'done', current: result.fileCount, total: result.fileCount });
    return result;
  }
}
