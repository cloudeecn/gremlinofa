/**
 * VFS migration — recursive copy between two VfsAdapter instances.
 *
 * Used during cross-backend import to move files from a source adapter
 * (remote VFS with old CEK, or local VFS tables) to a target adapter
 * (local VFS, filesystem VFS, or remote VFS with new userId).
 *
 * Copies both current content and version history. Versions are written
 * oldest→newest via `writeFile`, so each call auto-creates a new version
 * on the target. The final write is the current content.
 */

import type { VfsAdapter } from '../services/vfs/vfsAdapter';
import type { DirEntry, MigrationFileData } from '../services/vfs/vfsService';

export interface VfsMigrationProgress {
  filesProcessed: number;
  totalFiles: number;
  versionsProcessed: number;
}

export interface VfsMigrationResult {
  filesCopied: number;
  versionsCopied: number;
  errors: string[];
}

/**
 * Recursively copy all files (with version history) from `source` to `target`.
 */
export async function migrateProjectVfs(
  source: VfsAdapter,
  target: VfsAdapter,
  onProgress?: (p: VfsMigrationProgress) => void
): Promise<VfsMigrationResult> {
  const filePaths: string[] = [];
  await collectFiles(source, '/', filePaths);
  console.debug('[vfsMigration] Found', filePaths.length, 'files to migrate');

  const result: VfsMigrationResult = {
    filesCopied: 0,
    versionsCopied: 0,
    errors: [],
  };

  // Ensure directories exist first (sorted so parents come before children)
  const dirPaths = new Set<string>();
  for (const fp of filePaths) {
    const parts = fp.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      dirPaths.add('/' + parts.slice(0, i).join('/'));
    }
  }
  for (const dir of [...dirPaths].sort()) {
    try {
      const exists = await target.isDirectory(dir);
      if (!exists) await target.mkdir(dir);
    } catch (err) {
      // mkdir may throw if parent doesn't exist or dir already exists — proceed
      console.debug('[vfsMigration] mkdir warning for', dir, err);
    }
  }

  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];
    try {
      const copied = await copyFileWithVersions(source, target, filePath);
      result.filesCopied++;
      result.versionsCopied += copied.versionsCopied;
      if (result.filesCopied % 50 === 0 || i === filePaths.length - 1) {
        console.debug('[vfsMigration]', result.filesCopied, '/', filePaths.length, 'files copied');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${filePath}: ${msg}`);
      console.debug('[vfsMigration] Error copying', filePath, ':', msg);
    }
    onProgress?.({
      filesProcessed: i + 1,
      totalFiles: filePaths.length,
      versionsProcessed: result.versionsCopied,
    });
  }

  return result;
}

/**
 * Recursively collect all file paths under `dir` from the source adapter.
 */
async function collectFiles(source: VfsAdapter, dir: string, out: string[]): Promise<void> {
  let entries: DirEntry[];
  try {
    entries = await source.readDir(dir);
  } catch (err) {
    // Swallowing root-level errors hides real failures (e.g. decryption
    // errors) and makes the migration report 0 files, which can lead to
    // data loss if the caller clears the source. Re-throw for root; only
    // swallow for subdirectories (a missing subdir is non-fatal).
    if (dir === '/') throw err;
    return;
  }
  for (const entry of entries) {
    if (entry.deleted) continue;
    const childPath = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
    if (entry.type === 'dir') {
      await collectFiles(source, childPath, out);
    } else {
      out.push(childPath);
    }
  }
}

/**
 * Copy a single file from source to target, including version history.
 *
 * Uses bulk read (readAllVersions) when available to fetch all version
 * contents in one call, then writes them via writeFileWithHistory to
 * avoid per-version saveVersion cycles on the target.
 *
 * Falls back to sequential per-version read/write when readAllVersions
 * is not available on the source adapter.
 */
async function copyFileWithVersions(
  source: VfsAdapter,
  target: VfsAdapter,
  filePath: string
): Promise<{ versionsCopied: number }> {
  const fileId = await source.getFileId(filePath);

  // Read current content (always needed)
  const meta = await source.readFileWithMeta(filePath);
  const currentContent = meta.isBinary && meta.buffer ? meta.buffer : meta.content;

  if (!fileId) {
    // No version history — just write the current file
    await target.writeFileWithHistory(filePath, [], currentContent, meta.isBinary);
    return { versionsCopied: 0 };
  }

  // Bulk-read all version contents from source
  let historicalVersions: Array<{ content: string; createdAt: number }>;

  if (source.readAllVersions) {
    // Single HTTP call for all versions
    const allVersions = await source.readAllVersions(fileId);
    // Exclude the latest version — current content replaces it
    const historical = allVersions.length > 0 ? allVersions.slice(0, -1) : [];
    historicalVersions = historical.map(v => ({ content: v.content, createdAt: 0 }));
  } else {
    // Fallback: sequential per-version reads
    const versionList = await source.listVersions(fileId);
    versionList.sort((a, b) => a.version - b.version);
    const historical = versionList.length > 0 ? versionList.slice(0, -1) : [];
    historicalVersions = [];
    for (const ver of historical) {
      const content = await source.getVersion(fileId, ver.version);
      if (content !== null) {
        historicalVersions.push({ content, createdAt: ver.createdAt });
      }
    }
  }

  // Single write with full history — no per-version saveVersion cycles
  await target.writeFileWithHistory(filePath, historicalVersions, currentContent, meta.isBinary);
  return { versionsCopied: historicalVersions.length };
}

// ============================================================================
// Bulk migration path (pre-read data + parallel writes)
// ============================================================================

async function parallelForEach<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/**
 * Bulk migration: write pre-read MigrationFileData to a target adapter.
 *
 * Pairs with `vfsService.readAllForMigration()` which does the heavy
 * source-side work (single tree load, batch DB fetch, parallel decrypt).
 * This function handles the target writes with bounded concurrency.
 */
export async function migrateProjectVfsBulk(
  files: MigrationFileData[],
  target: VfsAdapter,
  onProgress?: (p: VfsMigrationProgress) => void,
  concurrency = 8
): Promise<VfsMigrationResult> {
  console.debug('[vfsMigration] Bulk migrating', files.length, 'files');

  const result: VfsMigrationResult = {
    filesCopied: 0,
    versionsCopied: 0,
    errors: [],
  };

  // Ensure directories exist first (sorted so parents come before children)
  const dirPaths = new Set<string>();
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      dirPaths.add('/' + parts.slice(0, i).join('/'));
    }
  }
  for (const dir of [...dirPaths].sort()) {
    try {
      const dirExists = await target.isDirectory(dir);
      if (!dirExists) await target.mkdir(dir);
    } catch (err) {
      console.debug('[vfsMigration] mkdir warning for', dir, err);
    }
  }

  let processed = 0;
  await parallelForEach(files, concurrency, async (file, _idx) => {
    try {
      await target.writeFileWithHistory(file.path, file.versions, file.content, file.isBinary);
      result.filesCopied++;
      result.versionsCopied += file.versions.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${file.path}: ${msg}`);
      console.debug('[vfsMigration] Error copying', file.path, ':', msg);
    }
    processed++;
    if (processed % 50 === 0 || processed === files.length) {
      console.debug('[vfsMigration]', processed, '/', files.length, 'files copied (bulk)');
    }
    onProgress?.({
      filesProcessed: processed,
      totalFiles: files.length,
      versionsProcessed: result.versionsCopied,
    });
  });

  return result;
}
