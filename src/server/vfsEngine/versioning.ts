/**
 * Server-side versioning using hidden directories.
 *
 * For file `{dir}/foo.txt`, versions live in `{dir}/.foo.txt.ver/`.
 * Each version is a file named by number: `1`, `2`, ...
 * A `meta.json` tracks `{currentVersion, createdAt}`.
 */

import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

interface VersionMeta {
  currentVersion: number;
  createdAt: number; // ms timestamp
}

export interface VersionInfo {
  version: number;
  createdAt: number;
  size: number;
}

function verDir(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return path.join(dir, `.${base}.ver`);
}

function metaPath(filePath: string): string {
  return path.join(verDir(filePath), 'meta.json');
}

async function readMeta(filePath: string): Promise<VersionMeta | null> {
  try {
    const raw = await fs.readFile(metaPath(filePath), 'utf-8');
    return JSON.parse(raw) as VersionMeta;
  } catch {
    return null;
  }
}

/** Caller must have created the version directory. */
async function writeMeta(filePath: string, meta: VersionMeta): Promise<void> {
  await fs.writeFile(metaPath(filePath), JSON.stringify(meta));
}

/**
 * Copy file contents by read + truncating write, never `fs.copyFile`.
 *
 * `fs.copyFile` fchmod()s the destination to mirror the source and, if that
 * fails, unlinks the destination it just opened. On a group-shared tree where
 * the destination belongs to another user, fchmod is EPERM even with group
 * write, so the copy fails *and* the existing file is gone. A plain write
 * opens with O_TRUNC, which keeps the destination's inode, owner and mode and
 * only needs write permission.
 */
export async function copyFileContents(src: string, dst: string): Promise<void> {
  await fs.writeFile(dst, await fs.readFile(src));
}

/**
 * Copy `src` to `dst` without pulling its bytes into JS.
 *
 * `COPYFILE_FICLONE` makes this a reflink on copy-on-write filesystems
 * (btrfs, XFS with reflink, bcachefs, OpenZFS 2.2+): the copy shares blocks
 * with the source, and a later in-place append to either allocates only the
 * new blocks — so a version snapshot costs metadata, not file size.
 * Elsewhere libuv falls back to an in-kernel copy. A hard link would be
 * cheaper still but wrong: appends and outside editors write the live inode
 * in place, which would rewrite the "saved" version too.
 *
 * `COPYFILE_EXCL` keeps clear of the fchmod hazard described on
 * `copyFileContents`: the fast path only ever writes a file it created. An
 * existing destination (an overwrite, or a lost meta.json restarting the
 * version numbering) gets the inode-preserving truncating write instead.
 */
export async function cloneFile(src: string, dst: string): Promise<void> {
  try {
    await fs.copyFile(src, dst, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
  } catch (e) {
    if ((e as { code?: string }).code !== 'EEXIST') throw e;
    await copyFileContents(src, dst);
  }
}

/**
 * Save current file content as the next version snapshot.
 * Call this AFTER writing the file so the latest version matches the live file.
 */
export async function saveVersion(filePath: string): Promise<number> {
  const vd = verDir(filePath);
  let meta = await readMeta(filePath);

  if (!meta) {
    meta = { currentVersion: 0, createdAt: Date.now() };
  }

  meta.currentVersion += 1;
  await fs.mkdir(vd, { recursive: true });
  await cloneFile(filePath, path.join(vd, String(meta.currentVersion)));
  await writeMeta(filePath, meta);
  return meta.currentVersion;
}

/**
 * List all stored versions for a file.
 */
export async function listVersions(filePath: string): Promise<VersionInfo[]> {
  const vd = verDir(filePath);
  try {
    const entries = await fs.readdir(vd);
    const validEntries = entries
      .filter(e => e !== 'meta.json')
      .map(e => ({ name: e, version: parseInt(e, 10) }))
      .filter(e => !isNaN(e.version));

    const versions = await Promise.all(
      validEntries.map(async e => {
        const stat = await fs.stat(path.join(vd, e.name));
        return { version: e.version, createdAt: stat.mtimeMs, size: stat.size };
      })
    );

    versions.sort((a, b) => a.version - b.version);
    return versions;
  } catch {
    return [];
  }
}

/**
 * Read a specific version's content.
 */
export async function getVersion(filePath: string, version: number): Promise<Buffer | null> {
  const versionPath = path.join(verDir(filePath), String(version));
  try {
    return await fs.readFile(versionPath);
  } catch {
    return null;
  }
}

/**
 * Read all stored versions' content in one call.
 * Returns sorted (ascending) array of {version, content} with base64-encoded content.
 */
export async function readAllVersions(
  filePath: string
): Promise<Array<{ version: number; content: string }>> {
  const vd = verDir(filePath);
  try {
    const entries = await fs.readdir(vd);
    const versionNums = entries
      .filter(e => e !== 'meta.json')
      .map(e => parseInt(e, 10))
      .filter(n => !isNaN(n));

    const results = await Promise.all(
      versionNums.map(async v => {
        const buf = await fs.readFile(path.join(vd, String(v)));
        return { version: v, content: buf.toString('base64') };
      })
    );

    results.sort((a, b) => a.version - b.version);
    return results;
  } catch {
    return [];
  }
}

/**
 * Get current file metadata including version info.
 */
export async function getFileMeta(
  filePath: string
): Promise<{ version: number; createdAt: number; size: number } | null> {
  try {
    const [meta, stat] = await Promise.all([readMeta(filePath), fs.stat(filePath)]);
    return {
      version: meta?.currentVersion ?? 0,
      createdAt: meta?.createdAt ?? stat.birthtimeMs,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

/**
 * Drop old versions, keeping N most recent.
 * Returns count of deleted version files.
 */
export async function dropOldVersions(filePath: string, keepCount: number): Promise<number> {
  const versions = await listVersions(filePath);
  if (versions.length <= keepCount) return 0;

  const toDrop = versions.slice(0, versions.length - keepCount);
  const vd = verDir(filePath);
  let deleted = 0;

  for (const v of toDrop) {
    try {
      await fs.unlink(path.join(vd, String(v.version)));
      deleted++;
    } catch {
      // Already gone
    }
  }

  return deleted;
}

/**
 * Remove the version directory for a file.
 */
export async function removeVersionDir(filePath: string): Promise<void> {
  const vd = verDir(filePath);
  try {
    await fs.rm(vd, { recursive: true, force: true });
  } catch {
    // Already gone
  }
}

/**
 * Move version directory alongside a renamed file.
 *
 * An overwrite-rename replaces the destination file, so its history goes
 * too (worker mode orphans it the same way). Without that removal
 * `fs.rename` onto the non-empty `.ver` directory fails with ENOTEMPTY and
 * leaves the source's history stranded at the old name.
 */
export async function renameVersionDir(oldPath: string, newPath: string): Promise<void> {
  const oldVd = verDir(oldPath);
  const newVd = verDir(newPath);
  try {
    await fs.access(oldVd);
  } catch {
    // Source never had versions; the destination's stale history still
    // must not outlive the file it belonged to.
    await removeVersionDir(newPath);
    return;
  }
  await removeVersionDir(newPath);
  await fs.mkdir(path.dirname(newVd), { recursive: true });
  await fs.rename(oldVd, newVd);
}

/**
 * Check if a name is a hidden version directory (starts with `.` and ends with `.ver`).
 */
export function isVersionDir(name: string): boolean {
  return name.startsWith('.') && name.endsWith('.ver');
}
