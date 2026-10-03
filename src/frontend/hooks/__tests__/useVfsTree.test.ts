import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { DirEntry, VfsAdapter } from '../../../shared/protocol/types/vfs';
import { flattenVisibleRows, useVfsTree } from '../useVfsTree';

const entry = (name: string, type: 'file' | 'dir', size?: number): DirEntry => ({
  name,
  type,
  deleted: false,
  createdAt: 0,
  updatedAt: 0,
  size,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

function adapterWith(listings: Record<string, DirEntry[]>) {
  return {
    readDir: vi.fn(async (path: string) => {
      const listing = listings[path];
      if (!listing) throw new Error(`Path not found: ${path}`);
      return listing;
    }),
  } as unknown as VfsAdapter & { readDir: ReturnType<typeof vi.fn> };
}

const names = (rows: ReturnType<typeof flattenVisibleRows>) =>
  rows.map(row =>
    row.kind === 'entry' ? `${row.level}:${row.name}` : `${row.level}:<${row.kind}>`
  );

describe('useVfsTree', () => {
  it('loads the root on mount and sorts folders first, then names naturally', async () => {
    const adapter = adapterWith({
      '/': [
        entry('b10.md', 'file'),
        entry('zeta', 'dir'),
        entry('b2.md', 'file'),
        entry('Alpha', 'dir'),
      ],
    });
    const { result } = renderHook(() => useVfsTree(adapter));

    expect(result.current.dirs.get('/')?.status).toBe('loading');
    await waitFor(() => expect(result.current.dirs.get('/')?.status).toBe('ready'));
    expect(result.current.dirs.get('/')?.entries?.map(e => e.name)).toEqual([
      'Alpha',
      'zeta',
      'b2.md',
      'b10.md',
    ]);
  });

  it('loads and expands the ancestors of a path to reveal, all at once', async () => {
    const adapter = adapterWith({
      '/': [entry('a', 'dir')],
      '/a': [entry('b', 'dir')],
      '/a/b': [entry('c.md', 'file')],
    });
    const { result } = renderHook(() => useVfsTree(adapter, { reveal: '/a/b/c.md' }));

    expect(adapter.readDir.mock.calls.map(([path]) => path)).toEqual(['/', '/a', '/a/b']);
    await waitFor(() => expect(result.current.dirs.get('/a/b')?.status).toBe('ready'));
    expect([...result.current.expanded]).toEqual(['/', '/a', '/a/b']);
    expect(result.current.entryKind('/a/b/c.md')).toBe('file');
    expect(result.current.entryKind('/a/b')).toBe('dir');
    expect(result.current.entryKind('/a/b/missing.md')).toBeNull();
  });

  it('drops a listing that lands after a newer request for the same folder', async () => {
    const first = deferred<DirEntry[]>();
    const second = deferred<DirEntry[]>();
    const adapter = {
      readDir: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    } as unknown as VfsAdapter;
    const { result } = renderHook(() => useVfsTree(adapter));

    act(() => result.current.refresh('/'));
    await act(async () => second.resolve([entry('new.md', 'file')]));
    await act(async () => first.resolve([entry('old.md', 'file')]));

    expect(result.current.dirs.get('/')?.entries?.map(e => e.name)).toEqual(['new.md']);
  });

  it('keeps the old entries on screen while a refresh is in flight', async () => {
    const adapter = adapterWith({ '/': [entry('a.md', 'file')] });
    const { result } = renderHook(() => useVfsTree(adapter));
    await waitFor(() => expect(result.current.dirs.get('/')?.status).toBe('ready'));

    const pending = deferred<DirEntry[]>();
    adapter.readDir.mockReturnValueOnce(pending.promise);
    act(() => result.current.refresh());

    expect(result.current.dirs.get('/')).toMatchObject({ status: 'loading' });
    expect(result.current.dirs.get('/')?.entries?.map(e => e.name)).toEqual(['a.md']);
    await act(async () => pending.resolve([entry('a.md', 'file'), entry('b.md', 'file')]));
    expect(result.current.dirs.get('/')?.entries).toHaveLength(2);
  });

  it('records a failed listing and loads it again on expand', async () => {
    const adapter = adapterWith({ '/': [entry('a', 'dir')] });
    const { result } = renderHook(() => useVfsTree(adapter));
    await waitFor(() => expect(result.current.dirs.get('/')?.status).toBe('ready'));

    act(() => result.current.expand('/a'));
    await waitFor(() => expect(result.current.dirs.get('/a')?.status).toBe('error'));
    expect(result.current.dirs.get('/a')?.error).toMatch(/Path not found/);

    act(() => result.current.collapse('/a'));
    act(() => result.current.expand('/a'));
    expect(adapter.readDir).toHaveBeenCalledTimes(3);
  });

  it('toggles without reloading a loaded folder', async () => {
    const adapter = adapterWith({ '/': [entry('a', 'dir')], '/a': [] });
    const { result } = renderHook(() => useVfsTree(adapter));
    await waitFor(() => expect(result.current.dirs.get('/')?.status).toBe('ready'));

    act(() => result.current.toggle('/a'));
    await waitFor(() => expect(result.current.dirs.get('/a')?.status).toBe('ready'));
    act(() => result.current.toggle('/a'));
    expect(result.current.expanded.has('/a')).toBe(false);
    act(() => result.current.toggle('/a'));
    expect(result.current.expanded.has('/a')).toBe(true);
    expect(adapter.readDir).toHaveBeenCalledTimes(2);
  });

  it('loads a folder once through ensureLoaded without expanding it', async () => {
    const adapter = adapterWith({ '/': [entry('a', 'dir')], '/a': [entry('x.md', 'file')] });
    const { result } = renderHook(() => useVfsTree(adapter));

    act(() => {
      result.current.ensureLoaded('/a');
      result.current.ensureLoaded('/a');
      result.current.ensureLoaded('/');
    });
    await waitFor(() => expect(result.current.dirs.get('/a')?.status).toBe('ready'));
    expect(adapter.readDir).toHaveBeenCalledTimes(2);
    expect(result.current.expanded.has('/a')).toBe(false);
  });
});

describe('flattenVisibleRows', () => {
  it('lists expanded folders depth-first with empty and error rows', () => {
    const dirs = new Map([
      [
        '/',
        {
          status: 'ready' as const,
          entries: [
            entry('a', 'dir'),
            entry('b', 'dir'),
            entry('c', 'dir'),
            entry('x.md', 'file', 3),
          ],
          error: null,
        },
      ],
      ['/a', { status: 'ready' as const, entries: [], error: null }],
      ['/b', { status: 'error' as const, entries: null, error: 'boom' }],
      ['/c', { status: 'loading' as const, entries: null, error: null }],
    ]);
    const rows = flattenVisibleRows(dirs, new Set(['/', '/a', '/b', '/c']));

    expect(names(rows)).toEqual(['1:/', '2:a', '3:<empty>', '2:b', '3:<error>', '2:c', '2:x.md']);
    expect(rows.find(row => row.kind === 'entry' && row.name === 'c')).toMatchObject({
      loading: true,
      expanded: true,
    });
    expect(rows.find(row => row.kind === 'entry' && row.name === 'x.md')).toMatchObject({
      path: '/x.md',
      size: 3,
    });
  });

  it('hides the children of collapsed folders', () => {
    const dirs = new Map([
      ['/', { status: 'ready' as const, entries: [entry('a', 'dir')], error: null }],
      ['/a', { status: 'ready' as const, entries: [entry('y.md', 'file')], error: null }],
    ]);
    expect(names(flattenVisibleRows(dirs, new Set(['/'])))).toEqual(['1:/', '2:a']);
  });
});
