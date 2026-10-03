import { unzip, zip } from 'fflate';
import { base64ToUint8Array } from '../../shared/protocol/binaryEncoding';
import type { FileContent, ReadFileResult, VfsAdapter } from '../../shared/protocol/types/vfs';
import { joinPath } from './vfsPath';

/** Text if the bytes are valid UTF-8, otherwise null (store as binary). */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** What to hand `writeFile`: a string for UTF-8 text, the raw bytes otherwise. */
export function toFileContent(bytes: Uint8Array): FileContent {
  return decodeUtf8(bytes) ?? bytes;
}

/** Bytes of a `readFileWithMeta` result (binary content arrives as base64). */
export function readResultBytes(result: ReadFileResult): Uint8Array {
  return result.isBinary
    ? base64ToUint8Array(result.content)
    : new TextEncoder().encode(result.content);
}

/** Runs `fn` over `items` with at most `limit` calls in flight, keeping order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Every file under `dir`, keyed by its path relative to `dir`. Directories are
 * walked one level at a time; file reads run four at a time, so a big folder
 * doesn't queue hundreds of RPCs at once.
 */
export async function collectFolderFiles(
  adapter: VfsAdapter,
  dir: string,
  onProgress?: (done: number, total: number) => void
): Promise<Record<string, Uint8Array>> {
  const files: Array<{ path: string; relPath: string }> = [];
  let level: Array<{ path: string; relPath: string }> = [{ path: dir, relPath: '' }];

  while (level.length > 0) {
    const listings = await Promise.all(level.map(d => adapter.readDir(d.path)));
    const nextLevel: typeof level = [];
    listings.forEach((entries, i) => {
      const parent = level[i];
      for (const entry of entries) {
        const child = {
          path: joinPath(parent.path, entry.name),
          relPath: parent.relPath ? `${parent.relPath}/${entry.name}` : entry.name,
        };
        (entry.type === 'dir' ? nextLevel : files).push(child);
      }
    });
    level = nextLevel;
  }

  let done = 0;
  const contents = await mapWithConcurrency(files, 4, async file => {
    const bytes = readResultBytes(await adapter.readFileWithMeta(file.path));
    onProgress?.(++done, files.length);
    return bytes;
  });

  const result: Record<string, Uint8Array> = {};
  files.forEach((file, i) => {
    result[file.relPath] = contents[i];
  });
  return result;
}

export function zipFiles(files: Record<string, Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    zip(files, { level: 6 }, (error, archive) => (error ? reject(error) : resolve(archive)));
  });
}

export function unzipArchive(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (error, entries) => (error ? reject(error) : resolve(entries)));
  });
}

export interface ZipImportPlan {
  /** Relative paths, no leading slash. */
  files: Array<{ path: string; bytes: Uint8Array }>;
  /** Directories with no file below them; others come into being with their files. */
  emptyDirs: string[];
  /** Entries refused because they point outside the target (`..`, absolute paths). */
  skipped: string[];
}

/** Finder and Windows clutter that nobody wants in their memory files. */
function isJunk(segments: string[]): boolean {
  const name = segments[segments.length - 1];
  return (
    segments.includes('__MACOSX') ||
    name === '.DS_Store' ||
    name === 'Thumbs.db' ||
    name.startsWith('._')
  );
}

/**
 * Turns raw ZIP entries into what to write. When every entry sits under one
 * top-level folder (the usual "zip the folder" archive), that folder is
 * stripped, so extracting `notes.zip` into `/notes` doesn't give `/notes/notes`.
 * Junk is dropped before that check, otherwise a Finder archive's
 * `__MACOSX/` sibling would defeat it.
 */
export function planZipImport(entries: Record<string, Uint8Array>): ZipImportPlan {
  const skipped: string[] = [];
  const files: Array<{ segments: string[]; bytes: Uint8Array }> = [];
  const dirs: string[][] = [];

  for (const [rawPath, bytes] of Object.entries(entries)) {
    const normalized = rawPath.replace(/\\/g, '/');
    const isDir = normalized.endsWith('/');
    const segments = normalized.split('/').filter(segment => segment && segment !== '.');
    if (segments.length === 0) continue;
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || segments.includes('..')) {
      skipped.push(rawPath);
      continue;
    }
    if (isJunk(segments)) continue;
    if (isDir) dirs.push(segments);
    else files.push({ segments, bytes });
  }

  const root = files[0]?.segments[0];
  const stripRoot =
    root !== undefined &&
    files.every(f => f.segments.length > 1 && f.segments[0] === root) &&
    dirs.every(d => d[0] === root);
  const strip = (segments: string[]) => (stripRoot ? segments.slice(1) : segments);

  const filePaths = files.map(f => strip(f.segments).join('/'));
  const emptyDirs = dirs
    .map(d => strip(d).join('/'))
    .filter(dir => dir && !filePaths.some(path => path.startsWith(`${dir}/`)));

  return {
    files: files.map((f, i) => ({ path: filePaths[i], bytes: f.bytes })),
    emptyDirs: [...new Set(emptyDirs)].sort(),
    skipped,
  };
}

export interface ZipImportResult {
  written: number;
  failed: Array<{ path: string; message: string }>;
}

/**
 * Writes a plan into `targetDir`. `writeFile` creates parent directories, so
 * only the empty ones need a `mkdir`. Files go one at a time: every write
 * takes the project's tree lock anyway.
 */
export async function importZip(
  adapter: VfsAdapter,
  targetDir: string,
  plan: ZipImportPlan,
  onProgress?: (done: number, total: number) => void
): Promise<ZipImportResult> {
  const failed: ZipImportResult['failed'] = [];
  let written = 0;

  for (const dir of plan.emptyDirs) {
    const path = joinPath(targetDir, dir);
    try {
      await adapter.mkdir(path, { recursive: true });
    } catch (error) {
      failed.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const [index, file] of plan.files.entries()) {
    const path = joinPath(targetDir, file.path);
    try {
      await adapter.writeFile(path, toFileContent(file.bytes));
      written++;
    } catch (error) {
      failed.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
    onProgress?.(index + 1, plan.files.length);
  }

  return { written, failed };
}
