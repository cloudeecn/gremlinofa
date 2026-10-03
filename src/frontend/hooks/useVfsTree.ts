import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DirEntry, VfsAdapter } from '../../shared/protocol/types/vfs';
import { VFS_ROOT, ancestors, basename, dirname, joinPath } from '../lib/vfsPath';

export type EntryType = DirEntry['type'];

export interface DirState {
  status: 'loading' | 'ready' | 'error';
  /** Kept while a reload is in flight so the tree doesn't flash empty */
  entries: DirEntry[] | null;
  error: string | null;
}

export interface VfsTreeState {
  dirs: ReadonlyMap<string, DirState>;
  expanded: ReadonlySet<string>;
  toggle: (dir: string) => void;
  expand: (dir: string) => void;
  collapse: (dir: string) => void;
  /** Expands every ancestor of `path`, loading the ones not loaded yet */
  reveal: (path: string) => void;
  /** Reloads `dir` if it was ever loaded, or every loaded directory */
  refresh: (dir?: string) => void;
  /**
   * Loads `dir` unless it was requested before, without expanding it. Sets
   * state only after the fetch, so an effect may call it.
   */
  ensureLoaded: (dir: string) => void;
  /** From the parent's loaded listing; null when that isn't loaded or has no such entry */
  entryKind: (path: string) => EntryType | null;
}

export type TreeRow =
  | {
      kind: 'entry';
      path: string;
      name: string;
      type: EntryType;
      level: number;
      size?: number;
      expanded: boolean;
      loading: boolean;
    }
  | { kind: 'empty'; key: string; level: number }
  | { kind: 'error'; key: string; level: number; dir: string; message: string };

const LOADING: DirState = { status: 'loading', entries: null, error: null };

function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) =>
    a.type !== b.type
      ? a.type === 'dir'
        ? -1
        : 1
      : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  );
}

/**
 * Root plus the ancestors of the path to reveal (`ancestors` starts at root),
 * or the folder to open along with its ancestors.
 */
function initialDirs(revealPath: string | undefined, openDir: string | undefined): string[] {
  const chain = revealPath
    ? ancestors(revealPath)
    : openDir && openDir !== VFS_ROOT
      ? [...ancestors(openDir), openDir]
      : [];
  return chain.length > 0 ? chain : [VFS_ROOT];
}

/**
 * Lazily loaded directory tree over a VFS adapter. The owner keeps it, so
 * expansion survives whatever re-renders the tree component (the manager's
 * mobile/desktop switch). Remount on an adapter change: loaded listings
 * belong to the old one.
 */
export function useVfsTree(
  adapter: VfsAdapter,
  options?: { reveal?: string; openDir?: string }
): VfsTreeState {
  const [initialPaths] = useState(() => initialDirs(options?.reveal, options?.openDir));
  const [dirs, setDirs] = useState<ReadonlyMap<string, DirState>>(
    () => new Map(initialPaths.map(path => [path, LOADING]))
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(initialPaths));

  // Latest request per directory: an older listing landing late is dropped
  const requestIdsRef = useRef(new Map<string, number>());

  /** Fetches and stores a listing. Sets state only after the await. */
  const fetchDir = useCallback(
    async (dir: string) => {
      const requestId = (requestIdsRef.current.get(dir) ?? 0) + 1;
      requestIdsRef.current.set(dir, requestId);
      let next: DirState;
      try {
        next = { status: 'ready', entries: sortEntries(await adapter.readDir(dir)), error: null };
      } catch (error) {
        console.debug('[useVfsTree] readDir failed', dir, error);
        const message = error instanceof Error ? error.message : String(error);
        next = { status: 'error', entries: null, error: message };
      }
      if (requestIdsRef.current.get(dir) !== requestId) return;
      setDirs(prev => new Map(prev).set(dir, next));
    },
    [adapter]
  );

  useEffect(() => {
    for (const path of initialPaths) void fetchDir(path);
  }, [fetchDir, initialPaths]);

  const load = useCallback(
    (dir: string) => {
      setDirs(prev => {
        const entries = prev.get(dir)?.entries ?? null;
        return new Map(prev).set(dir, { status: 'loading', entries, error: null });
      });
      void fetchDir(dir);
    },
    [fetchDir]
  );

  const needsLoad = useCallback(
    (dir: string) => {
      const state = dirs.get(dir);
      return !state || state.status === 'error';
    },
    [dirs]
  );

  const expand = useCallback(
    (dir: string) => {
      setExpanded(prev => (prev.has(dir) ? prev : new Set(prev).add(dir)));
      if (needsLoad(dir)) load(dir);
    },
    [load, needsLoad]
  );

  const collapse = useCallback((dir: string) => {
    setExpanded(prev => {
      if (!prev.has(dir)) return prev;
      const next = new Set(prev);
      next.delete(dir);
      return next;
    });
  }, []);

  const toggle = useCallback(
    (dir: string) => (expanded.has(dir) ? collapse(dir) : expand(dir)),
    [collapse, expand, expanded]
  );

  const reveal = useCallback(
    (path: string) => {
      const chain = ancestors(path);
      setExpanded(prev => {
        if (chain.every(dir => prev.has(dir))) return prev;
        const next = new Set(prev);
        for (const dir of chain) next.add(dir);
        return next;
      });
      for (const dir of chain) if (needsLoad(dir)) load(dir);
    },
    [load, needsLoad]
  );

  const refresh = useCallback(
    (dir?: string) => {
      if (dir === undefined) {
        for (const path of dirs.keys()) load(path);
      } else if (dirs.has(dir)) {
        load(dir);
      }
    },
    [dirs, load]
  );

  const ensureLoaded = useCallback(
    (dir: string) => {
      if (!requestIdsRef.current.has(dir)) void fetchDir(dir);
    },
    [fetchDir]
  );

  const entryKind = useCallback(
    (path: string): EntryType | null => {
      if (path === VFS_ROOT) return 'dir';
      const name = basename(path);
      return dirs.get(dirname(path))?.entries?.find(entry => entry.name === name)?.type ?? null;
    },
    [dirs]
  );

  return useMemo(
    () => ({ dirs, expanded, toggle, expand, collapse, reveal, refresh, ensureLoaded, entryKind }),
    [dirs, expanded, toggle, expand, collapse, reveal, refresh, ensureLoaded, entryKind]
  );
}

/**
 * The rows a tree shows, root first, depth-first in display order. A loading
 * directory is marked on its own row (spinner in the chevron slot) rather
 * than getting a placeholder child.
 */
export function flattenVisibleRows(
  dirs: ReadonlyMap<string, DirState>,
  expanded: ReadonlySet<string>
): TreeRow[] {
  const rows: TreeRow[] = [];

  const pushEntry = (path: string, name: string, type: EntryType, level: number, size?: number) => {
    const state = type === 'dir' ? dirs.get(path) : undefined;
    const isExpanded = type === 'dir' && expanded.has(path);
    rows.push({
      kind: 'entry',
      path,
      name,
      type,
      level,
      size,
      expanded: isExpanded,
      loading: state?.status === 'loading',
    });
    if (!isExpanded || !state) return;

    if (state.status === 'error') {
      rows.push({
        kind: 'error',
        key: `${path}:error`,
        level: level + 1,
        dir: path,
        message: state.error ?? 'Failed to load',
      });
    } else if (state.entries?.length === 0 && state.status === 'ready') {
      rows.push({ kind: 'empty', key: `${path}:empty`, level: level + 1 });
    }
    for (const entry of state.entries ?? []) {
      pushEntry(joinPath(path, entry.name), entry.name, entry.type, level + 1, entry.size);
    }
  };

  pushEntry(VFS_ROOT, VFS_ROOT, 'dir', 1);
  return rows;
}
