import { joinPath, normalizePath } from './vfsPath';

/**
 * Where the DUMMY runtime looks for hooks, as a root-VFS path. The runtime
 * reads `/hooks/<name>.js` through the chat's namespaced adapter, so a
 * namespaced chat's hooks live under `<namespace>/hooks`.
 */
export function hooksDir(namespace?: string): string {
  return joinPath(normalizePath(namespace ?? ''), 'hooks');
}

export function hookFilePath(name: string, namespace?: string): string {
  return `${hooksDir(namespace)}/${name}.js`;
}

/**
 * The hook name `dummy register` would take for this file, or null when the
 * runtime can't load it. Subfolders are fine: `/hooks/a/b.js` is `a/b`.
 */
export function hookNameFromPath(path: string, namespace?: string): string | null {
  const prefix = `${hooksDir(namespace)}/`;
  const normalized = normalizePath(path);
  if (!normalized.startsWith(prefix) || !normalized.endsWith('.js')) return null;
  const name = normalized.slice(prefix.length, -'.js'.length);
  return name && !name.endsWith('/') ? name : null;
}
