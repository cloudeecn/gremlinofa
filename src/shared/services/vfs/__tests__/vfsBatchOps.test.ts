/**
 * Encrypted-VFS hot paths: decrypted-tree cache, node sizes (readDir / stat
 * without decrypting content), single-pass append, batch delete, and
 * `mkdir({ recursive })`.
 *
 * Crypto work is counted through the stub encryption's mock calls: tree
 * payloads carry `"orphans"`, file payloads carry `"content"`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createVfsService, VfsError } from '../vfsService';
import { LocalVfsAdapter } from '../localVfsAdapter';
import type { UnifiedStorage } from '../../storage/unifiedStorage';
import type { EncryptionCore } from '../../encryption/encryptionCore';
import type { VfsTree } from '../../../protocol/types';
import { buildStubVfsDeps } from './_vfsTestHelpers';

vi.mock('../../../protocol/idGenerator', () => ({
  generateUniqueId: vi.fn((prefix: string) => `${prefix}_${Math.random().toString(36).slice(2)}`),
}));

const PROJECT = 'proj_batch';

const { stubStorage, stubEncryption, mockStorage } = buildStubVfsDeps();

function newService() {
  return createVfsService(
    stubStorage as unknown as UnifiedStorage,
    stubEncryption as unknown as EncryptionCore
  );
}

function decryptCalls(kind: 'tree' | 'file'): number {
  const marker = kind === 'tree' ? '"orphans"' : '"content"';
  return stubEncryption.decryptWithDecompression.mock.calls.filter(([data]) =>
    String(data).includes(marker)
  ).length;
}

function encryptCalls(kind: 'tree' | 'file'): number {
  const marker = kind === 'tree' ? '"orphans"' : '"content"';
  return stubEncryption.encryptWithCompression.mock.calls.filter(([data]) =>
    String(data).includes(marker)
  ).length;
}

function storedTree(): VfsTree {
  const row = mockStorage.get('vfs_meta')!.get(`vfs_meta_${PROJECT}`)!;
  return JSON.parse(row.encryptedData.slice('encrypted:'.length)) as VfsTree;
}

function storeTree(tree: VfsTree): void {
  mockStorage.get('vfs_meta')!.set(`vfs_meta_${PROJECT}`, {
    encryptedData: `encrypted:${JSON.stringify(tree)}`,
    parentId: PROJECT,
  });
}

let vfs: ReturnType<typeof newService>;

beforeEach(() => {
  mockStorage.clear();
  stubEncryption.encryptWithCompression.mockClear();
  stubEncryption.decryptWithDecompression.mockClear();
  vfs = newService();
});

describe('decrypted-tree cache', () => {
  it('skips decrypting a tree it just saved', async () => {
    await vfs.createFile(PROJECT, '/a.txt', 'a');
    await vfs.readFile(PROJECT, '/a.txt');
    await vfs.exists(PROJECT, '/a.txt');
    expect(decryptCalls('tree')).toBe(0);
  });

  it('decrypts again when another writer replaces the ciphertext', async () => {
    await vfs.createFile(PROJECT, '/a.txt', 'a');
    const tree = storedTree();
    tree.children['b'] = { type: 'dir', deleted: false, createdAt: 1, updatedAt: 1, children: {} };
    storeTree(tree);

    expect(await vfs.isDirectory(PROJECT, '/b')).toBe(true);
    expect(decryptCalls('tree')).toBe(1);
  });

  it('hands each op its own tree, so a failed op leaves no trace', async () => {
    await vfs.createFile(PROJECT, '/a.txt', 'a');
    await expect(vfs.mkdir(PROJECT, '/a.txt/sub')).rejects.toMatchObject({
      code: 'NOT_A_DIRECTORY',
    });
    expect(await vfs.readDir(PROJECT, '/')).toEqual([expect.objectContaining({ name: 'a.txt' })]);
  });

  it('forgets the project on clearVfs', async () => {
    await vfs.createFile(PROJECT, '/a.txt', 'a');
    await vfs.clearVfs(PROJECT);
    expect(await vfs.exists(PROJECT, '/a.txt')).toBe(false);
  });
});

describe('node sizes', () => {
  it('readDir and stat report sizes without decrypting file content', async () => {
    await vfs.createFile(PROJECT, '/dir/one.txt', 'hello');
    await vfs.writeFile(PROJECT, '/dir/two.txt', 'hi');
    await vfs.strReplace(PROJECT, '/dir/two.txt', 'hi', 'hiya');
    const decryptsBefore = decryptCalls('file');

    const entries = await vfs.readDir(PROJECT, '/dir');
    const stat = await vfs.stat(PROJECT, '/dir/one.txt');

    expect(entries.map(e => [e.name, e.size])).toEqual([
      ['one.txt', 5],
      ['two.txt', 4],
    ]);
    expect(stat.size).toBe(5);
    expect(decryptCalls('file')).toBe(decryptsBefore);
  });

  it('omits size for empty files, as before', async () => {
    await vfs.createFile(PROJECT, '/empty.txt', '');
    const [entry] = await vfs.readDir(PROJECT, '/');
    expect(entry.size).toBeUndefined();
  });

  it('backfills legacy nodes once', async () => {
    await vfs.createFile(PROJECT, '/old.txt', 'legacy');
    const tree = storedTree();
    delete tree.children['old.txt'].size;
    storeTree(tree);

    const first = await vfs.readDir(PROJECT, '/');
    expect(first[0].size).toBe(6);
    expect(storedTree().children['old.txt'].size).toBe(6);

    const decryptsBefore = decryptCalls('file');
    await vfs.readDir(PROJECT, '/');
    expect(decryptCalls('file')).toBe(decryptsBefore);
  });
});

describe('appendFile', () => {
  it('creates a missing file and its parents', async () => {
    const result = await vfs.appendFile(PROJECT, '/logs/a/run.log', 'line 1\n');
    expect(result).toEqual({ created: true });
    expect(await vfs.readFile(PROJECT, '/logs/a/run.log')).toBe('line 1\n');
    expect(await vfs.isDirectory(PROJECT, '/logs/a')).toBe(true);
  });

  it('appends with one content decrypt and keeps the old content as a version', async () => {
    await vfs.createFile(PROJECT, '/run.log', 'one\n');
    const decryptsBefore = decryptCalls('file');

    const result = await vfs.appendFile(PROJECT, '/run.log', 'two\n');

    expect(result).toEqual({ created: false });
    expect(decryptCalls('file')).toBe(decryptsBefore + 1);
    expect(await vfs.readFile(PROJECT, '/run.log')).toBe('one\ntwo\n');
    const fileId = (await vfs.getFileId(PROJECT, '/run.log'))!;
    expect(await vfs.getVersion(PROJECT, fileId, 1)).toBe('one\n');
    expect((await vfs.stat(PROJECT, '/run.log')).size).toBe(8);
  });

  it('refuses binary files and directories', async () => {
    await vfs.writeFile(PROJECT, '/img.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]));
    await vfs.mkdir(PROJECT, '/dir');
    await expect(vfs.appendFile(PROJECT, '/img.png', 'x')).rejects.toMatchObject({
      code: 'BINARY_FILE',
    });
    await expect(vfs.appendFile(PROJECT, '/dir', 'x')).rejects.toMatchObject({
      code: 'NOT_A_FILE',
    });
  });

  it('keeps minStoredVersion across appends', async () => {
    await vfs.createFile(PROJECT, '/f.txt', 'v1');
    for (let i = 2; i <= 4; i++) await vfs.appendFile(PROJECT, '/f.txt', `+${i}`);
    const fileId = (await vfs.getFileId(PROJECT, '/f.txt'))!;
    await vfs.dropOldVersions(PROJECT, fileId, 2);
    await vfs.appendFile(PROJECT, '/f.txt', '+5');

    const meta = await vfs.getFileMeta(PROJECT, '/f.txt');
    expect(meta).toMatchObject({ version: 5, minStoredVersion: 3 });
  });

  it('honors namespaces and the read-only /share mount', async () => {
    await vfs.appendFile(PROJECT, '/notes.md', 'x', 'minions/coder');
    expect(await vfs.readFile(PROJECT, '/minions/coder/notes.md')).toBe('x');
    await expect(
      vfs.appendFile(PROJECT, '/share/x.md', 'x', 'minions/coder')
    ).rejects.toMatchObject({ code: 'READONLY' });
  });
});

describe('deletePaths', () => {
  it('deletes files and directories with a single tree save', async () => {
    await vfs.createFile(PROJECT, '/a.txt', 'a');
    await vfs.createFile(PROJECT, '/dir/b.txt', 'b');
    await vfs.createFile(PROJECT, '/dir/sub/c.txt', 'c');
    const treeSavesBefore = encryptCalls('tree');

    const results = await vfs.deletePaths(PROJECT, ['/a.txt', '/dir'], true);

    expect(results).toEqual([{ path: '/a.txt' }, { path: '/dir' }]);
    expect(encryptCalls('tree')).toBe(treeSavesBefore + 1);
    expect(await vfs.exists(PROJECT, '/a.txt')).toBe(false);
    expect(await vfs.exists(PROJECT, '/dir/sub/c.txt')).toBe(false);
  });

  it('reports per-path failures and keeps going', async () => {
    await vfs.createFile(PROJECT, '/a.txt', 'a');
    await vfs.mkdir(PROJECT, '/dir');
    await vfs.createFile(PROJECT, '/gone.txt', 'g');
    await vfs.deleteFile(PROJECT, '/gone.txt');

    const results = await vfs.deletePaths(
      PROJECT,
      ['/missing', '/dir', '/gone.txt', '/a.txt'],
      false
    );

    expect(results.map(r => r.error?.code)).toEqual([
      'PATH_NOT_FOUND',
      'NOT_A_FILE',
      'PATH_NOT_FOUND',
      undefined,
    ]);
    expect(await vfs.exists(PROJECT, '/a.txt')).toBe(false);
    expect(await vfs.isDirectory(PROJECT, '/dir')).toBe(true);
  });

  it('counts paths under an already-deleted path as deleted, in any order', async () => {
    await vfs.createFile(PROJECT, '/a/b/c.txt', 'c');
    await vfs.createFile(PROJECT, '/x/y.txt', 'y');

    const forward = await vfs.deletePaths(PROJECT, ['/a', '/a/b/c.txt', '/a'], true);
    const backward = await vfs.deletePaths(PROJECT, ['/x/y.txt', '/x'], true);

    expect(forward.every(r => !r.error)).toBe(true);
    expect(backward.every(r => !r.error)).toBe(true);
  });

  it('refuses the root, mount roots and read-only namespaced paths', async () => {
    await vfs.createFile(PROJECT, '/share/doc.md', 'd');
    const plain = await vfs.deletePaths(PROJECT, ['/', '/share'], true);
    const namespaced = await vfs.deletePaths(PROJECT, ['/', '/share/doc.md'], true, 'ns');

    expect(plain.map(r => r.error?.code)).toEqual(['INVALID_PATH', 'INVALID_PATH']);
    expect(namespaced.map(r => r.error?.code)).toEqual(['INVALID_PATH', 'READONLY']);
  });

  it('skips the tree save when nothing was deleted', async () => {
    await vfs.createFile(PROJECT, '/a.txt', 'a');
    const treeSavesBefore = encryptCalls('tree');
    await vfs.deletePaths(PROJECT, ['/nope'], false);
    expect(encryptCalls('tree')).toBe(treeSavesBefore);
  });
});

describe('mkdir recursive', () => {
  it('makes an existing directory a no-op only when recursive', async () => {
    await vfs.mkdir(PROJECT, '/a/b');
    await expect(vfs.mkdir(PROJECT, '/a/b')).rejects.toMatchObject({ code: 'DIR_EXISTS' });
    await expect(vfs.mkdir(PROJECT, '/a/b', undefined, true)).resolves.toBeUndefined();
    await expect(vfs.mkdir(PROJECT, '/', undefined, true)).resolves.toBeUndefined();
  });

  it('still refuses a file in the way', async () => {
    await vfs.createFile(PROJECT, '/f', 'x');
    await expect(vfs.mkdir(PROJECT, '/f', undefined, true)).rejects.toMatchObject({
      code: 'FILE_EXISTS',
    });
  });
});

describe('LocalVfsAdapter batch surface', () => {
  it('deletePath throws the per-path error', async () => {
    const adapter = new LocalVfsAdapter(vfs, PROJECT);
    await expect(adapter.deletePath('/nope')).rejects.toBeInstanceOf(VfsError);
    await expect(adapter.deletePath('/nope')).rejects.toMatchObject({ code: 'PATH_NOT_FOUND' });
  });

  it('ensureDirAndWrite tolerates an existing directory', async () => {
    const adapter = new LocalVfsAdapter(vfs, PROJECT);
    await adapter.mkdir('/out');
    await adapter.ensureDirAndWrite('/out', [{ name: 'a.txt', content: 'a' }]);
    expect(await adapter.readFile('/out/a.txt')).toBe('a');
  });
});
