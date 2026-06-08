/**
 * Filesystem operations with path-traversal protection, symlink policy, and
 * versioning integration.
 *
 * Every op resolves the requested path against a {@link VfsContext} that
 * describes:
 *   - the project root,
 *   - the canonical allow-list (project root + extra mounts the deployer wired
 *     via VFS_EXTRA_ROOTS),
 *   - whether symlinks may be followed.
 *
 * The canonical (realpath) path is computed before any FS call, then checked
 * against the allow-list. Symlinks that escape (or any symlink at all when
 * follow is off) are rejected with HTTP 403.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from './fileLock.js';
import * as versioning from './versioning.js';

export { type VersionInfo } from './versioning.js';

export const SAFE_SEGMENT = /^[A-Za-z0-9_]+$/;

function assertSegment(segment: string): void {
  if (!SAFE_SEGMENT.test(segment)) {
    throw new FsError('Path traversal rejected', 403);
  }
}

/**
 * Resolve a project root directory for a (userId, projectId) pair.
 * Rejects userId/projectId values that would escape dataDir.
 */
export function projectRoot(dataDir: string, userId: string, projectId: string): string {
  assertSegment(userId);
  assertSegment(projectId);
  const canonical = path.resolve(dataDir);
  const resolved = path.join(canonical, userId, projectId);
  if (!resolved.startsWith(canonical)) {
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
// Path resolution
// ============================================================================

export interface VfsContext {
  /** Canonical absolute path to the project root. */
  projectRoot: string;
  /** Canonical absolute paths the project may touch. Always includes projectRoot. */
  allowedRoots: string[];
  /** When false, any symlink in the chain triggers FsError(403). */
  followSymlinks: boolean;
}

export interface ResolveOptions {
  /**
   * When true, the target path is allowed to not exist yet. We realpath the
   * deepest existing ancestor and append the missing tail. This still detects
   * symlinks anywhere up the chain.
   */
  forWrite?: boolean;
}

function containedIn(canonical: string, root: string): boolean {
  if (canonical === root) return true;
  if (!canonical.startsWith(root)) return false;
  return canonical[root.length] === path.sep;
}

function inAllowedRoots(canonical: string, roots: string[]): boolean {
  for (const r of roots) {
    if (containedIn(canonical, r)) return true;
  }
  return false;
}

async function realpathSafe(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
}

async function canonicalForWrite(lexical: string): Promise<string> {
  // Walk up until we find an existing ancestor.
  const segments: string[] = [];
  let current = lexical;
  while (true) {
    const real = await realpathSafe(current);
    if (real !== null) {
      return segments.length === 0 ? real : path.join(real, ...segments.reverse());
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root without finding anything — unreachable in
      // practice since '/' always exists. Fall back to lexical.
      return lexical;
    }
    segments.push(path.basename(current));
    current = parent;
  }
}

/**
 * Resolve a user-supplied path to a canonical absolute path, enforcing
 * containment + symlink policy.
 */
export async function resolveCanonicalPath(
  requestedPath: string,
  ctx: VfsContext,
  opts: ResolveOptions = {}
): Promise<string> {
  if (typeof requestedPath !== 'string') {
    throw new FsError('Path must be a string', 400);
  }
  if (requestedPath.includes('\0')) {
    throw new FsError('Path traversal rejected', 403);
  }

  const cleaned = requestedPath.replace(/^\/+/, '');
  const lexical = path.resolve(ctx.projectRoot, cleaned);

  // Lexical containment against project root (preserves existing safePath
  // semantics — '..' escapes are caught here before we even touch FS).
  if (!containedIn(lexical, ctx.projectRoot)) {
    throw new FsError('Path traversal rejected', 403);
  }

  let canonical: string;
  if (opts.forWrite) {
    canonical = await canonicalForWrite(lexical);
  } else {
    const real = await realpathSafe(lexical);
    canonical = real ?? lexical;
  }

  if (!ctx.followSymlinks && canonical !== lexical) {
    throw new FsError('Symlink encountered; VFS_FOLLOW_SYMLINKS disabled', 403);
  }

  if (!inAllowedRoots(canonical, ctx.allowedRoots)) {
    throw new FsError('Path outside allowed roots', 403);
  }

  return canonical;
}

// ============================================================================
// MIME detection
// ============================================================================

const MIME_MAP: Record<string, string> = {
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

export function detectMimeByExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

// ============================================================================
// Read operations (no lock)
// ============================================================================

export async function ls(
  ctx: VfsContext,
  dirPath: string
): Promise<Array<{ name: string; type: 'file' | 'dir'; size: number; mtime: number }>> {
  const resolved = await resolveCanonicalPath(dirPath, ctx);
  const entries = await fs.readdir(resolved, { withFileTypes: true });

  // Filter: hide dotfiles always. In follow=off mode, also hide symlinks (we
  // refuse to traverse them anywhere else, so listing them would be a lie).
  // In follow=on mode, leave them visible — access-time resolution enforces
  // the allow-list per entry, so a link pointing to a forbidden target shows
  // up but errors on read.
  const visible = entries.filter(entry => {
    if (entry.name.startsWith('.')) return false;
    if (!ctx.followSymlinks && entry.isSymbolicLink()) return false;
    return true;
  });

  const results = await Promise.all(
    visible.map(async entry => {
      const fullPath = path.join(resolved, entry.name);
      const stat = await fs.stat(fullPath);
      return {
        name: entry.name,
        type: (entry.isDirectory() || (entry.isSymbolicLink() && stat.isDirectory())
          ? 'dir'
          : 'file') as 'file' | 'dir',
        size: stat.size,
        mtime: stat.mtimeMs,
      };
    })
  );

  // Sort: directories first, then alphabetical
  results.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

export async function stat(
  ctx: VfsContext,
  filePath: string
): Promise<{ size: number; mtime: number; type: 'file' | 'dir' }> {
  const resolved = await resolveCanonicalPath(filePath, ctx);
  const s = await fs.stat(resolved);
  return {
    size: s.size,
    mtime: s.mtimeMs,
    type: s.isDirectory() ? 'dir' : 'file',
  };
}

export async function exists(ctx: VfsContext, filePath: string): Promise<boolean> {
  // resolveCanonicalPath without forWrite falls back to lexical on ENOENT so a
  // missing file still gets the symlink + allow-list check on its parent chain.
  const resolved = await resolveCanonicalPath(filePath, ctx);
  try {
    await fs.access(resolved);
    return true;
  } catch {
    return false;
  }
}

export async function read(ctx: VfsContext, filePath: string): Promise<Buffer> {
  const resolved = await resolveCanonicalPath(filePath, ctx);
  return fs.readFile(resolved);
}

// ============================================================================
// Write operations (locked)
// ============================================================================

export async function write(
  ctx: VfsContext,
  filePath: string,
  content: Buffer,
  createOnly: boolean
): Promise<void> {
  const resolved = await resolveCanonicalPath(filePath, ctx, { forWrite: true });
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

    await fs.writeFile(resolved, content);
    await versioning.saveVersion(resolved);
  });
}

export async function rm(ctx: VfsContext, filePath: string): Promise<void> {
  const resolved = await resolveCanonicalPath(filePath, ctx);
  await withFileLock(resolved, async () => {
    await fs.unlink(resolved);
    await versioning.removeVersionDir(resolved);
  });
}

export async function mkdir(ctx: VfsContext, dirPath: string): Promise<void> {
  const resolved = await resolveCanonicalPath(dirPath, ctx, { forWrite: true });
  await fs.mkdir(resolved, { recursive: true });
}

export async function rmdir(ctx: VfsContext, dirPath: string): Promise<void> {
  const resolved = await resolveCanonicalPath(dirPath, ctx);
  // Recursively clean up version dirs inside
  await removeVersionDirsRecursive(resolved);
  await fs.rm(resolved, { recursive: true, force: true });
}

async function removeVersionDirsRecursive(dirPath: string): Promise<void> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      // Don't recurse through symlinks — risk of loops / accidental traversal
      // into external mounts. We're cleaning up *this* project's versioning,
      // not somewhere a symlink points.
      if (entry.isSymbolicLink()) continue;
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

export async function rename(ctx: VfsContext, fromPath: string, toPath: string): Promise<void> {
  const resolvedFrom = await resolveCanonicalPath(fromPath, ctx);
  const resolvedTo = await resolveCanonicalPath(toPath, ctx, { forWrite: true });
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
  ctx: VfsContext,
  filePath: string,
  oldStr: string,
  newStr: string
): Promise<StrReplaceResult> {
  const resolved = await resolveCanonicalPath(filePath, ctx);
  return withFileLock(resolved, async () => {
    const content = await fs.readFile(resolved, 'utf-8');

    // Count occurrences
    let count = 0;
    let pos = 0;
    while ((pos = content.indexOf(oldStr, pos)) !== -1) {
      count++;
      pos += oldStr.length;
    }

    if (count === 0) {
      throw new FsError('String not found in file', 400);
    }
    if (count > 1) {
      throw new FsError(`String not unique: ${count} occurrences found`, 400);
    }

    const replacePos = content.indexOf(oldStr);
    const editLine = content.substring(0, replacePos).split('\n').length;
    const newContent =
      content.substring(0, replacePos) + newStr + content.substring(replacePos + oldStr.length);

    await fs.writeFile(resolved, newContent, 'utf-8');
    await versioning.saveVersion(resolved);

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
  ctx: VfsContext,
  filePath: string,
  line: number,
  text: string
): Promise<InsertResult> {
  const resolved = await resolveCanonicalPath(filePath, ctx);
  return withFileLock(resolved, async () => {
    const content = await fs.readFile(resolved, 'utf-8');
    const lines = content.split('\n');

    if (line < 0 || line > lines.length) {
      throw new FsError(`Invalid line ${line}. Valid range: [0, ${lines.length}]`, 400);
    }

    const textLines = text.split('\n');
    lines.splice(line, 0, ...textLines);
    await fs.writeFile(resolved, lines.join('\n'), 'utf-8');
    await versioning.saveVersion(resolved);

    return { insertedAt: line };
  });
}

export async function append(
  ctx: VfsContext,
  filePath: string,
  text: string
): Promise<{ created: boolean }> {
  const resolved = await resolveCanonicalPath(filePath, ctx, { forWrite: true });
  return withFileLock(resolved, async () => {
    let created = false;
    try {
      await fs.access(resolved);
      await fs.appendFile(resolved, text, 'utf-8');
    } catch {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, text, 'utf-8');
      created = true;
    }
    await versioning.saveVersion(resolved);
    return { created };
  });
}

// ============================================================================
// Versioning pass-through
// ============================================================================

export async function fileVersions(
  ctx: VfsContext,
  filePath: string
): Promise<versioning.VersionInfo[]> {
  const resolved = await resolveCanonicalPath(filePath, ctx);
  return versioning.listVersions(resolved);
}

export async function fileVersion(
  ctx: VfsContext,
  filePath: string,
  version: number
): Promise<Buffer | null> {
  const resolved = await resolveCanonicalPath(filePath, ctx);
  return versioning.getVersion(resolved, version);
}

export async function readAllFileVersions(
  ctx: VfsContext,
  filePath: string
): Promise<Array<{ version: number; content: string }>> {
  const resolved = await resolveCanonicalPath(filePath, ctx);
  return versioning.readAllVersions(resolved);
}

export async function dropFileVersions(
  ctx: VfsContext,
  filePath: string,
  keepCount: number
): Promise<number> {
  const resolved = await resolveCanonicalPath(filePath, ctx);
  return versioning.dropOldVersions(resolved, keepCount);
}

export async function fileMeta(
  ctx: VfsContext,
  filePath: string
): Promise<{
  version: number;
  createdAt: number;
  size: number;
  mime: string;
} | null> {
  const resolved = await resolveCanonicalPath(filePath, ctx);
  const meta = await versioning.getFileMeta(resolved);
  if (!meta) return null;

  return {
    ...meta,
    mime: detectMimeByExtension(resolved),
  };
}

/**
 * Compact all files in a project: walk the tree and prune old versions.
 * Skips symlinks regardless of follow setting — we're operating on *this*
 * project's storage, not external mounts the user happens to link in.
 */
export async function compact(
  ctx: VfsContext,
  keepCount: number
): Promise<{ filesProcessed: number; versionsDropped: number }> {
  let filesProcessed = 0;
  let versionsDropped = 0;

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) continue;
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

  await walk(ctx.projectRoot);
  return { filesProcessed, versionsDropped };
}
