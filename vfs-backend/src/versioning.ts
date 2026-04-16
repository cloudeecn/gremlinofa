/**
 * Server-side versioning using hidden directories.
 *
 * For file `{dir}/foo.txt`, versions live in `{dir}/.foo.txt.ver/`.
 * Each version is a file named by number: `1`, `2`, ...
 * A `meta.json` tracks `{currentVersion, createdAt}`.
 */

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

async function writeMeta(filePath: string, meta: VersionMeta): Promise<void> {
  const vd = verDir(filePath);
  await fs.mkdir(vd, { recursive: true });
  await fs.writeFile(metaPath(filePath), JSON.stringify(meta));
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
  await fs.copyFile(filePath, path.join(vd, String(meta.currentVersion)));
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
    const versions: VersionInfo[] = [];

    for (const entry of entries) {
      if (entry === 'meta.json') continue;
      const versionNum = parseInt(entry, 10);
      if (isNaN(versionNum)) continue;

      const versionPath = path.join(vd, entry);
      const stat = await fs.stat(versionPath);
      versions.push({
        version: versionNum,
        createdAt: stat.mtimeMs,
        size: stat.size,
      });
    }

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
 * Get current file metadata including version info.
 */
export async function getFileMeta(
  filePath: string
): Promise<{ version: number; createdAt: number; size: number } | null> {
  const meta = await readMeta(filePath);
  try {
    const stat = await fs.stat(filePath);
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
 */
export async function renameVersionDir(oldPath: string, newPath: string): Promise<void> {
  const oldVd = verDir(oldPath);
  const newVd = verDir(newPath);
  try {
    await fs.access(oldVd);
    await fs.mkdir(path.dirname(newVd), { recursive: true });
    await fs.rename(oldVd, newVd);
  } catch {
    // No version dir to move
  }
}

/**
 * Check if a name is a hidden version directory (starts with `.` and ends with `.ver`).
 */
export function isVersionDir(name: string): boolean {
  return name.startsWith('.') && name.endsWith('.ver');
}
