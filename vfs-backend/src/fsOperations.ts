/**
 * Filesystem operations with path-traversal protection and versioning integration.
 *
 * Every operation resolves the requested path against a project root and
 * verifies the result stays within bounds before touching the filesystem.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { withFileLock } from './fileLock.js';
import * as versioning from './versioning.js';

/** Canonical absolute path of the data directory. Function so tests can override config.dataDir. */
function canonicalDataDir(): string {
  return path.resolve(config.dataDir);
}

const SAFE_SEGMENT = /^[A-Za-z0-9_]+$/;

function assertSegment(segment: string): void {
  if (!SAFE_SEGMENT.test(segment)) {
    throw new FsError('Path traversal rejected', 403);
  }
}

/**
 * Resolve a project root directory for a (userId, projectId) pair.
 * Rejects userId/projectId values that would escape dataDir.
 */
export function projectRoot(userId: string, projectId: string): string {
  assertSegment(userId);
  assertSegment(projectId);
  const dataDir = canonicalDataDir();
  const resolved = path.join(dataDir, userId, projectId);
  if (!resolved.startsWith(dataDir)) {
    throw new FsError('Path traversal rejected', 403);
  }
  return resolved;
}

/**
 * Resolve a user-supplied path within a project root, rejecting traversal.
 */
export function safePath(root: string, requestedPath: string): string {
  if (typeof requestedPath !== 'string') {
    throw new FsError('Path must be a string', 400);
  }
  if (requestedPath.includes('\0')) {
    throw new FsError('Path traversal rejected', 403);
  }

  const cleaned = requestedPath.replace(/^\/+/, '');
  const resolved = path.resolve(root, cleaned);

  // Containment check — path.resolve normalizes away any ".." segments,
  // so startsWith is sufficient to guarantee the resolved path is under root.
  if (!resolved.startsWith(root)) {
    throw new FsError('Path traversal rejected', 403);
  }
  // Prevent sibling-directory match (e.g. root="/a/proj" matching "/a/project2")
  if (resolved !== root && resolved[root.length] !== path.sep) {
    throw new FsError('Path traversal rejected', 403);
  }

  return resolved;
}

export class FsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'FsError';
    this.status = status;
  }
}

// ============================================================================
// Read operations (no lock)
// ============================================================================

export async function ls(
  root: string,
  dirPath: string
): Promise<Array<{ name: string; type: 'file' | 'dir'; size: number; mtime: number }>> {
  const resolved = safePath(root, dirPath);
  const entries = await fs.readdir(resolved, { withFileTypes: true });

  const results: Array<{
    name: string;
    type: 'file' | 'dir';
    size: number;
    mtime: number;
  }> = [];

  for (const entry of entries) {
    // Exclude hidden version directories
    if (versioning.isVersionDir(entry.name)) continue;
    // Exclude dotfiles starting with . (version meta etc.)
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(resolved, entry.name);
    const stat = await fs.stat(fullPath);

    results.push({
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file',
      size: stat.size,
      mtime: stat.mtimeMs,
    });
  }

  // Sort: directories first, then alphabetical
  results.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

export async function stat(
  root: string,
  filePath: string
): Promise<{ size: number; mtime: number; type: 'file' | 'dir' }> {
  const resolved = safePath(root, filePath);
  const s = await fs.stat(resolved);
  return {
    size: s.size,
    mtime: s.mtimeMs,
    type: s.isDirectory() ? 'dir' : 'file',
  };
}

export async function exists(root: string, filePath: string): Promise<boolean> {
  const resolved = safePath(root, filePath);
  try {
    await fs.access(resolved);
    return true;
  } catch {
    return false;
  }
}

export async function read(root: string, filePath: string): Promise<Buffer> {
  const resolved = safePath(root, filePath);
  return fs.readFile(resolved);
}

// ============================================================================
// Write operations (locked)
// ============================================================================

export async function write(
  root: string,
  filePath: string,
  content: Buffer,
  createOnly: boolean
): Promise<void> {
  const resolved = safePath(root, filePath);
  await withFileLock(resolved, async () => {
    if (createOnly) {
      try {
        await fs.access(resolved);
        throw new FsError('File already exists', 409);
      } catch (e) {
        if (e instanceof FsError) throw e;
        // File doesn't exist — continue
      }
    }

    // Auto-create parent directories
    await fs.mkdir(path.dirname(resolved), { recursive: true });

    // Save version before overwrite (if file exists)
    try {
      await fs.access(resolved);
      await versioning.saveVersion(resolved);
    } catch {
      // New file — no version to save
    }

    await fs.writeFile(resolved, content);
  });
}

export async function rm(root: string, filePath: string): Promise<void> {
  const resolved = safePath(root, filePath);
  await withFileLock(resolved, async () => {
    await fs.unlink(resolved);
    await versioning.removeVersionDir(resolved);
  });
}

export async function mkdir(root: string, dirPath: string): Promise<void> {
  const resolved = safePath(root, dirPath);
  await fs.mkdir(resolved, { recursive: true });
}

export async function rmdir(root: string, dirPath: string): Promise<void> {
  const resolved = safePath(root, dirPath);
  // Recursively clean up version dirs inside
  await removeVersionDirsRecursive(resolved);
  await fs.rm(resolved, { recursive: true, force: true });
}

async function removeVersionDirsRecursive(dirPath: string): Promise<void> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (versioning.isVersionDir(entry.name)) {
          await fs.rm(fullPath, { recursive: true, force: true });
        } else {
          await removeVersionDirsRecursive(fullPath);
        }
      } else {
        // Remove version dirs for files
        await versioning.removeVersionDir(fullPath);
      }
    }
  } catch {
    // Directory might not exist
  }
}

export async function rename(root: string, fromPath: string, toPath: string): Promise<void> {
  const resolvedFrom = safePath(root, fromPath);
  const resolvedTo = safePath(root, toPath);
  await withFileLock(resolvedFrom, async () => {
    await fs.mkdir(path.dirname(resolvedTo), { recursive: true });
    await fs.rename(resolvedFrom, resolvedTo);
    await versioning.renameVersionDir(resolvedFrom, resolvedTo);
  });
}

// ============================================================================
// Compound operations (locked, atomic read-modify-write)
// ============================================================================

export interface StrReplaceResult {
  editLine: number;
  snippet: string;
}

export async function strReplace(
  root: string,
  filePath: string,
  oldStr: string,
  newStr: string
): Promise<StrReplaceResult> {
  const resolved = safePath(root, filePath);
  return withFileLock(resolved, async () => {
    const content = await fs.readFile(resolved, 'utf-8');

    // Count occurrences
    let count = 0;
    let pos = 0;
    while ((pos = content.indexOf(oldStr, pos)) !== -1) {
      count++;
      pos += 1;
    }

    if (count === 0) {
      throw new FsError('String not found in file', 400);
    }
    if (count > 1) {
      throw new FsError(`String not unique: ${count} occurrences found`, 400);
    }

    // Save version
    await versioning.saveVersion(resolved);

    const replacePos = content.indexOf(oldStr);
    const editLine = content.substring(0, replacePos).split('\n').length;
    const newContent = content.replace(oldStr, newStr);

    await fs.writeFile(resolved, newContent, 'utf-8');

    // Build snippet around edit line
    const lines = newContent.split('\n');
    const start = Math.max(0, editLine - 1 - 3);
    const end = Math.min(lines.length, editLine + 3);
    const snippet = lines
      .slice(start, end)
      .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
      .join('\n');

    return { editLine, snippet };
  });
}

export interface InsertResult {
  insertedAt: number;
}

export async function insert(
  root: string,
  filePath: string,
  line: number,
  text: string
): Promise<InsertResult> {
  const resolved = safePath(root, filePath);
  return withFileLock(resolved, async () => {
    const content = await fs.readFile(resolved, 'utf-8');
    const lines = content.split('\n');

    if (line < 0 || line > lines.length) {
      throw new FsError(`Invalid line ${line}. Valid range: [0, ${lines.length}]`, 400);
    }

    await versioning.saveVersion(resolved);

    const textLines = text.split('\n');
    lines.splice(line, 0, ...textLines);
    await fs.writeFile(resolved, lines.join('\n'), 'utf-8');

    return { insertedAt: line };
  });
}

export async function append(
  root: string,
  filePath: string,
  text: string
): Promise<{ created: boolean }> {
  const resolved = safePath(root, filePath);
  return withFileLock(resolved, async () => {
    let created = false;
    try {
      await fs.access(resolved);
      // File exists — save version then append
      await versioning.saveVersion(resolved);
      await fs.appendFile(resolved, text, 'utf-8');
    } catch {
      // File doesn't exist — create with content
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, text, 'utf-8');
      created = true;
    }
    return { created };
  });
}

// ============================================================================
// Versioning pass-through
// ============================================================================

export async function fileVersions(
  root: string,
  filePath: string
): Promise<versioning.VersionInfo[]> {
  const resolved = safePath(root, filePath);
  return versioning.listVersions(resolved);
}

export async function fileVersion(
  root: string,
  filePath: string,
  version: number
): Promise<Buffer | null> {
  const resolved = safePath(root, filePath);
  return versioning.getVersion(resolved, version);
}

export async function dropFileVersions(
  root: string,
  filePath: string,
  keepCount: number
): Promise<number> {
  const resolved = safePath(root, filePath);
  return versioning.dropOldVersions(resolved, keepCount);
}

export async function fileMeta(
  root: string,
  filePath: string
): Promise<{
  version: number;
  createdAt: number;
  size: number;
  mime: string;
} | null> {
  const resolved = safePath(root, filePath);
  const meta = await versioning.getFileMeta(resolved);
  if (!meta) return null;

  // Simple mime detection by extension
  const ext = path.extname(resolved).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.md': 'text/markdown',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.py': 'text/x-python',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
  };

  return {
    ...meta,
    mime: mimeMap[ext] ?? 'application/octet-stream',
  };
}

/**
 * Compact all files in a project: walk the tree and prune old versions.
 */
export async function compact(
  root: string,
  keepCount: number
): Promise<{ filesProcessed: number; versionsDropped: number }> {
  let filesProcessed = 0;
  let versionsDropped = 0;

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        filesProcessed++;
        const dropped = await versioning.dropOldVersions(fullPath, keepCount);
        versionsDropped += dropped;
      }
    }
  }

  await walk(root);
  return { filesProcessed, versionsDropped };
}
