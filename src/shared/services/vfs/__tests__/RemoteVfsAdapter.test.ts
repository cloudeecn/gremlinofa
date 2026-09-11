import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RemoteVfsAdapter } from '../RemoteVfsAdapter';
import { VfsError } from '../vfsService';

// The VFS server's /rename route always clobbers; the overwrite guard is
// client-side, so pin it here against a mocked fetch.
describe('RemoteVfsAdapter.rename', () => {
  const originalFetch = globalThis.fetch;
  let calls: Array<{ url: string; method: string }>;
  let existingPaths: Set<string>;

  beforeEach(() => {
    calls = [];
    existingPaths = new Set();
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url: url.pathname, method: init?.method ?? 'GET' });
      if (url.pathname.endsWith('/api/exists')) {
        const exists = existingPaths.has(url.searchParams.get('path') ?? '');
        return new Response(JSON.stringify({ exists }), { status: 200 });
      }
      if (url.pathname.endsWith('/api/rename')) {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeAdapter(): RemoteVfsAdapter {
    return new RemoteVfsAdapter({
      baseUrl: 'http://vfs.test',
      userId: 'u',
      password: 'p',
      projectId: 'proj',
    });
  }

  it('rejects with DESTINATION_EXISTS and never calls /rename when target exists', async () => {
    existingPaths.add('/b.txt');
    const adapter = makeAdapter();

    await expect(adapter.rename('/a.txt', '/b.txt')).rejects.toMatchObject({
      name: 'VfsError',
      code: 'DESTINATION_EXISTS',
    } satisfies Partial<VfsError>);
    expect(calls.some(c => c.url.endsWith('/api/rename'))).toBe(false);
  });

  it('renames when target exists and overwrite is set', async () => {
    existingPaths.add('/b.txt');
    const adapter = makeAdapter();

    await adapter.rename('/a.txt', '/b.txt', true);

    const renameCall = calls.find(c => c.url.endsWith('/api/rename'));
    expect(renameCall?.method).toBe('POST');
    expect(calls.some(c => c.url.endsWith('/api/exists'))).toBe(false);
  });

  it('renames when target does not exist', async () => {
    const adapter = makeAdapter();

    await adapter.rename('/a.txt', '/b.txt');

    expect(calls.map(c => c.url)).toEqual(['/api/exists', '/api/rename']);
  });
});

describe('RemoteVfsAdapter batch delete + mkdir', () => {
  const originalFetch = globalThis.fetch;
  let calls: Array<{ url: string; method: string; query: URLSearchParams; body?: unknown }>;
  let respond: (url: URL, init?: RequestInit) => Response;

  beforeEach(() => {
    calls = [];
    respond = () => new Response(null, { status: 404 });
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        url: url.pathname,
        method: init?.method ?? 'GET',
        query: url.searchParams,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return respond(url, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeAdapter(namespace?: string): RemoteVfsAdapter {
    return new RemoteVfsAdapter({
      baseUrl: 'http://vfs.test',
      userId: 'u',
      password: 'p',
      projectId: 'proj',
      namespace,
    });
  }

  it('sends one /rm-many and maps results back to the caller paths', async () => {
    respond = () =>
      Response.json({
        results: [
          { path: '/minions/coder/a.txt' },
          {
            path: '/minions/coder/b',
            error: { code: 'NOT_A_FILE', message: 'Is a directory: /minions/coder/b' },
          },
        ],
      });

    const results = await makeAdapter('minions/coder').deletePaths(
      ['/a.txt', '/share/x', '/b'],
      false
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: '/api/rm-many',
      method: 'POST',
      body: { paths: ['/minions/coder/a.txt', '/minions/coder/b'], recursive: false },
    });
    expect(results).toEqual([
      { path: '/a.txt' },
      { path: '/share/x', error: expect.objectContaining({ code: 'READONLY' }) },
      { path: '/b', error: { code: 'NOT_A_FILE', message: 'Is a directory: /minions/coder/b' } },
    ]);
  });

  it('falls back to per-path calls on a server without /rm-many', async () => {
    respond = url => {
      const p = url.searchParams.get('path');
      if (url.pathname === '/api/stat') {
        if (p === '/dir') return Response.json({ type: 'dir', size: 0, mtime: 0 });
        if (p === '/a.txt') return Response.json({ type: 'file', size: 1, mtime: 0 });
        return new Response(null, { status: 404 });
      }
      if (url.pathname === '/api/rm' || url.pathname === '/api/rmdir') {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    };

    const results = await makeAdapter().deletePaths(['/dir', '/dir/x', '/a.txt', '/nope'], true);

    expect(results.map(r => r.error?.code)).toEqual([
      undefined,
      undefined,
      undefined,
      'PATH_NOT_FOUND',
    ]);
    expect(calls.filter(c => c.method === 'DELETE').map(c => c.url)).toEqual([
      '/api/rmdir',
      '/api/rm',
    ]);
  });

  it('deletePath throws the per-path error', async () => {
    respond = () =>
      Response.json({
        results: [{ path: '/nope', error: { code: 'PATH_NOT_FOUND', message: 'nope' } }],
      });
    await expect(makeAdapter().deletePath('/nope')).rejects.toMatchObject({
      code: 'PATH_NOT_FOUND',
    });
  });

  it('refuses to delete the root but still clears the project via clearVfs', async () => {
    respond = () => new Response(null, { status: 204 });
    const adapter = makeAdapter();

    await expect(adapter.rmdir('/', true)).rejects.toMatchObject({ code: 'INVALID_PATH' });
    const [rootResult] = await adapter.deletePaths(['/'], true);
    expect(rootResult.error?.code).toBe('INVALID_PATH');
    expect(calls).toHaveLength(0);

    await adapter.clearVfs();
    expect(calls).toEqual([expect.objectContaining({ url: '/api/rmdir', method: 'DELETE' })]);
    expect(calls[0].query.get('path')).toBe('/');
  });

  it('passes recursive to /mkdir and maps the 409 code', async () => {
    respond = url =>
      url.searchParams.get('recursive') === 'true'
        ? new Response(null, { status: 204 })
        : Response.json({ error: 'Directory already exists', code: 'DIR_EXISTS' }, { status: 409 });
    const adapter = makeAdapter();

    await expect(adapter.mkdir('/d', { recursive: true })).resolves.toBeUndefined();
    await expect(adapter.mkdir('/d')).rejects.toMatchObject({ code: 'DIR_EXISTS' });
  });
});
