/**
 * Pure VFS path helpers.
 *
 * These functions only operate on path strings — no I/O, no storage, no
 * encryption. The full impure VFS service in `src/services/vfs/vfsService.ts`
 * imports them from here so frontend callers can use the same parsing logic
 * without crossing the worker boundary or pulling the singleton/storage
 * dependencies along.
 *
 * Frontend callers (under `src/components/**`, `src/hooks/**`, `src/contexts/**`,
 * `src/utils/**`) should import from this module directly — the boundary
 * lint rule blocks `src/services/**` imports for those trees.
 */

/**
 * Normalize a path: resolve `.` and `..`, ensure leading slash, remove trailing slash.
 */
export function normalizePath(path: string): string {
  // Handle empty or whitespace-only
  if (!path || !path.trim()) return '/';

  // Split and filter empty segments
  const segments = path.split('/').filter(s => s && s !== '.');
  const result: string[] = [];

  for (const seg of segments) {
    if (seg === '..') {
      result.pop(); // Go up one level
    } else {
      result.push(seg);
    }
  }

  return '/' + result.join('/');
}

/**
 * Get parent directory path.
 */
export function getParentDir(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === '/') return '/';

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return '/';

  return normalized.slice(0, lastSlash);
}

/**
 * Get basename (last component of path).
 */
export function getBasename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === '/') return '';

  const lastSlash = normalized.lastIndexOf('/');
  return normalized.slice(lastSlash + 1);
}

/**
 * Split path into segments (excluding root).
 */
export function getPathSegments(path: string): string[] {
  const normalized = normalizePath(path);
  if (normalized === '/') return [];
  return normalized.slice(1).split('/');
}

/**
 * Check if a path is the root.
 */
export function isRootPath(path: string): boolean {
  return normalizePath(path) === '/';
}

/**
 * Batch-delete bookkeeping shared by every VFS backend: true when `path`
 * itself or one of its ancestors was already deleted earlier in the same
 * batch. Lets `rm(['/a', '/a/b'], {recursive})` report both as deleted
 * whatever order they arrive in, instead of `/a/b` failing with "not found"
 * on one backend and succeeding on another. Both arguments are normalized.
 */
export function isCoveredByDeleted(path: string, deleted: ReadonlySet<string>): boolean {
  if (deleted.size === 0) return false;
  let current = path;
  while (true) {
    if (deleted.has(current)) return true;
    if (current === '/') return false;
    current = getParentDir(current);
  }
}
