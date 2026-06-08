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
