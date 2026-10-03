/**
 * Path helpers for the VFS UI. The backend's `vfsPaths` sits behind the
 * frontend import boundary, so the UI keeps its own copy of the few pieces it
 * needs. Paths here are absolute and normalized (`/`, `/a`, `/a/b`), which is
 * what the adapter returns.
 */

export const VFS_ROOT = '/';

/** Absolute, no empty segments, no trailing slash: `docs//a/` → `/docs/a`. */
export function normalizePath(path: string): string {
  return `/${path.split('/').filter(Boolean).join('/')}`;
}

export function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? '';
}

/** Parent directory; the root is its own parent. */
export function dirname(path: string): string {
  const segments = path.split('/').filter(Boolean);
  segments.pop();
  return segments.length === 0 ? VFS_ROOT : `/${segments.join('/')}`;
}

export function joinPath(dir: string, name: string): string {
  return dir === VFS_ROOT ? `/${name}` : `${dir}/${name}`;
}

/** Strict ancestors, root first: `/a/b/c` → `['/', '/a', '/a/b']`. */
export function ancestors(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  const result: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    result.push(i === 0 ? VFS_ROOT : `/${segments.slice(0, i).join('/')}`);
  }
  return result;
}

/** True for `dir` itself and anything below it. */
export function isWithin(path: string, dir: string): boolean {
  if (dir === VFS_ROOT) return true;
  return path === dir || path.startsWith(`${dir}/`);
}

/** Route for a VFS path. Segments are encoded so `#`, `?` and `%` survive the hash router. */
export function vfsUrl(projectId: string, path: string): string {
  const segments = path.split('/').filter(Boolean).map(encodeURIComponent);
  const base = `/project/${projectId}/vfs`;
  return segments.length === 0 ? base : `${base}/${segments.join('/')}`;
}

/**
 * The VFS path a link inside a rendered file points at, resolved against the
 * file's folder like a relative URL (`..` stops at the root). Returns null for
 * links that leave the VFS: a scheme (`https:`, `mailto:`) or `//host`.
 * Query and fragment are dropped.
 */
export function resolveLink(dir: string, href: string): string | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return null;
  const pathPart = href.split(/[?#]/)[0];
  let decoded = pathPart;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    // A stray `%` that isn't an escape: take the name literally
  }
  const segments = decoded.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  for (const segment of decoded.split('/')) {
    if (segment === '..') segments.pop();
    else if (segment && segment !== '.') segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

/**
 * Validates one name typed into "New file" / "New folder". Returns an error
 * message, or null when the trimmed name is usable. Nested paths are refused
 * so a typo can't silently create a directory chain.
 */
export function validateEntryName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a name.';
  if (trimmed.includes('/')) return 'Names can’t contain “/”. Create the folder first.';
  if (trimmed === '.' || trimmed === '..') return 'That name is reserved.';
  return null;
}
