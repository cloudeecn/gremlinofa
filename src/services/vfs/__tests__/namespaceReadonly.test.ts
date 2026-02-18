/**
 * Namespace readonly enforcement and mount root protection tests.
 *
 * Tests that /share is read-only when accessed from a namespace,
 * /sharerw bypasses namespace and remains writable,
 * and mount roots (/share, /sharerw) cannot be deleted or renamed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../encryption/encryptionService', () => ({
  encryptionService: {
    encryptWithCompression: vi.fn(async (data: string) => `encrypted:${data}`),
    decryptWithDecompression: vi.fn(async (data: string) => {
      if (data.startsWith('encrypted:')) return data.slice(10);
      throw new Error('Invalid encrypted data');
    }),
  },
}));

const mockStorage = new Map<string, Map<string, { encryptedData: string; parentId?: string }>>();

vi.mock('../../storage', () => ({
  storage: {
    getAdapter: () => ({
      get: vi.fn(async (table: string, id: string) => {
        return mockStorage.get(table)?.get(id) || null;
      }),
      save: vi.fn(
        async (
          table: string,
          id: string,
          encryptedData: string,
          metadata: { parentId?: string }
        ) => {
          if (!mockStorage.has(table)) mockStorage.set(table, new Map());
          mockStorage.get(table)!.set(id, { encryptedData, parentId: metadata.parentId });
        }
      ),
      delete: vi.fn(async (table: string, id: string) => {
        mockStorage.get(table)?.delete(id);
      }),
      deleteMany: vi.fn(async (table: string, filters: { parentId?: string }) => {
        const tableMap = mockStorage.get(table);
        if (!tableMap || !filters.parentId) return;
        for (const [id, record] of tableMap.entries()) {
          if (record.parentId === filters.parentId) tableMap.delete(id);
        }
      }),
    }),
  },
}));

vi.mock('../../../utils/idGenerator', () => ({
  generateUniqueId: vi.fn((prefix: string) => `${prefix}_${Math.random().toString(36).slice(2)}`),
}));

import {
  resolveNamespacedPath,
  isNamespacedReadonly,
  createFile,
  readFile,
  writeFile,
  mkdir,
  rmdir,
  deleteFile,
  rename,
  strReplace,
  insert,
  clearVfs,
  VfsError,
} from '../vfsService';

const PROJECT = 'test-project';
const NS = '/minions/coder';

beforeEach(async () => {
  mockStorage.clear();
  await clearVfs(PROJECT);
});

describe('resolveNamespacedPath - /sharerw', () => {
  it('bypasses namespace for /sharerw paths', () => {
    expect(resolveNamespacedPath('/sharerw/data.json', NS)).toBe('/sharerw/data.json');
    expect(resolveNamespacedPath('/sharerw', NS)).toBe('/sharerw');
    expect(resolveNamespacedPath('/sharerw/nested/file.txt', NS)).toBe('/sharerw/nested/file.txt');
  });

  it('does not treat /sharerwx as /sharerw bypass', () => {
    expect(resolveNamespacedPath('/sharerwx/file.txt', NS)).toBe(
      '/minions/coder/sharerwx/file.txt'
    );
  });
});

describe('isNamespacedReadonly', () => {
  it('returns false without namespace', () => {
    expect(isNamespacedReadonly('/share/file.txt')).toBe(false);
    expect(isNamespacedReadonly('/share')).toBe(false);
  });

  it('returns true for /share with namespace', () => {
    expect(isNamespacedReadonly('/share', NS)).toBe(true);
    expect(isNamespacedReadonly('/share/file.txt', NS)).toBe(true);
    expect(isNamespacedReadonly('/share/nested/dir', NS)).toBe(true);
  });

  it('returns false for /sharerw with namespace', () => {
    expect(isNamespacedReadonly('/sharerw', NS)).toBe(false);
    expect(isNamespacedReadonly('/sharerw/file.txt', NS)).toBe(false);
  });

  it('returns false for /sharing with namespace', () => {
    expect(isNamespacedReadonly('/sharing/file.txt', NS)).toBe(false);
  });

  it('returns false for regular paths with namespace', () => {
    expect(isNamespacedReadonly('/data/file.txt', NS)).toBe(false);
    expect(isNamespacedReadonly('/memories/note.md', NS)).toBe(false);
  });
});

describe('/share readonly in namespaced context', () => {
  it('createFile to /share throws READONLY with namespace', async () => {
    await expect(createFile(PROJECT, '/share/file.txt', 'content', NS)).rejects.toThrow(VfsError);
    try {
      await createFile(PROJECT, '/share/file.txt', 'content', NS);
    } catch (e) {
      expect((e as VfsError).code).toBe('READONLY');
    }
  });

  it('createFile to /share works without namespace', async () => {
    await createFile(PROJECT, '/share/file.txt', 'content');
    const content = await readFile(PROJECT, '/share/file.txt');
    expect(content).toBe('content');
  });

  it('writeFile to /share throws READONLY with namespace', async () => {
    await expect(writeFile(PROJECT, '/share/file.txt', 'content', NS)).rejects.toThrow(VfsError);
    try {
      await writeFile(PROJECT, '/share/file.txt', 'content', NS);
    } catch (e) {
      expect((e as VfsError).code).toBe('READONLY');
    }
  });

  it('mkdir at /share/subdir throws READONLY with namespace', async () => {
    await expect(mkdir(PROJECT, '/share/subdir', NS)).rejects.toThrow(VfsError);
    try {
      await mkdir(PROJECT, '/share/subdir', NS);
    } catch (e) {
      expect((e as VfsError).code).toBe('READONLY');
    }
  });

  it('deleteFile at /share throws READONLY with namespace', async () => {
    await createFile(PROJECT, '/share/file.txt', 'content');
    await expect(deleteFile(PROJECT, '/share/file.txt', NS)).rejects.toThrow(VfsError);
    try {
      await deleteFile(PROJECT, '/share/file.txt', NS);
    } catch (e) {
      expect((e as VfsError).code).toBe('READONLY');
    }
  });

  it('rename from /share throws READONLY with namespace', async () => {
    await createFile(PROJECT, '/share/file.txt', 'content');
    await expect(rename(PROJECT, '/share/file.txt', '/other.txt', NS)).rejects.toThrow(VfsError);
    try {
      await rename(PROJECT, '/share/file.txt', '/other.txt', NS);
    } catch (e) {
      expect((e as VfsError).code).toBe('READONLY');
    }
  });

  it('rename to /share throws READONLY with namespace', async () => {
    await createFile(PROJECT, '/other.txt', 'content', NS);
    await expect(rename(PROJECT, '/other.txt', '/share/moved.txt', NS)).rejects.toThrow(VfsError);
  });

  it('strReplace on /share throws READONLY with namespace', async () => {
    await createFile(PROJECT, '/share/file.txt', 'hello world');
    await expect(strReplace(PROJECT, '/share/file.txt', 'hello', 'bye', NS)).rejects.toThrow(
      VfsError
    );
    try {
      await strReplace(PROJECT, '/share/file.txt', 'hello', 'bye', NS);
    } catch (e) {
      expect((e as VfsError).code).toBe('READONLY');
    }
  });

  it('insert on /share throws READONLY with namespace', async () => {
    await createFile(PROJECT, '/share/file.txt', 'line1');
    await expect(insert(PROJECT, '/share/file.txt', 0, 'line0', NS)).rejects.toThrow(VfsError);
    try {
      await insert(PROJECT, '/share/file.txt', 0, 'line0', NS);
    } catch (e) {
      expect((e as VfsError).code).toBe('READONLY');
    }
  });

  it('readFile from /share works with namespace', async () => {
    await createFile(PROJECT, '/share/file.txt', 'shared content');
    const content = await readFile(PROJECT, '/share/file.txt', NS);
    expect(content).toBe('shared content');
  });

  it('regular paths remain writable with namespace', async () => {
    await createFile(PROJECT, '/data/file.txt', 'content', NS);
    const content = await readFile(PROJECT, '/data/file.txt', NS);
    expect(content).toBe('content');
  });
});

describe('/sharerw is writable in namespaced context', () => {
  it('createFile to /sharerw works with namespace', async () => {
    await createFile(PROJECT, '/sharerw/file.txt', 'content', NS);
    const content = await readFile(PROJECT, '/sharerw/file.txt', NS);
    expect(content).toBe('content');
  });

  it('writeFile to /sharerw works with namespace', async () => {
    await writeFile(PROJECT, '/sharerw/file.txt', 'content', NS);
    const content = await readFile(PROJECT, '/sharerw/file.txt', NS);
    expect(content).toBe('content');
  });

  it('mkdir at /sharerw/subdir works with namespace', async () => {
    await mkdir(PROJECT, '/sharerw/subdir', NS);
  });
});

describe('mount root protection', () => {
  it('cannot delete /share root', async () => {
    // Ensure /share exists as directory
    await createFile(PROJECT, '/share/file.txt', 'content');
    await expect(deleteFile(PROJECT, '/share')).rejects.toThrow(VfsError);
    try {
      await deleteFile(PROJECT, '/share');
    } catch (e) {
      expect((e as VfsError).code).toBe('INVALID_PATH');
    }
  });

  it('cannot rmdir /share root', async () => {
    await createFile(PROJECT, '/share/file.txt', 'content');
    await expect(rmdir(PROJECT, '/share', true)).rejects.toThrow(VfsError);
    try {
      await rmdir(PROJECT, '/share', true);
    } catch (e) {
      expect((e as VfsError).code).toBe('INVALID_PATH');
    }
  });

  it('can rmdir /sharerw root (not protected)', async () => {
    await createFile(PROJECT, '/sharerw/file.txt', 'content');
    await rmdir(PROJECT, '/sharerw', true);
  });

  it('cannot rename /share to something else', async () => {
    await createFile(PROJECT, '/share/file.txt', 'content');
    await expect(rename(PROJECT, '/share', '/other')).rejects.toThrow(VfsError);
    try {
      await rename(PROJECT, '/share', '/other');
    } catch (e) {
      expect((e as VfsError).code).toBe('INVALID_PATH');
    }
  });

  it('cannot rename something to /share', async () => {
    await mkdir(PROJECT, '/other');
    await expect(rename(PROJECT, '/other', '/share')).rejects.toThrow(VfsError);
    try {
      await rename(PROJECT, '/other', '/share');
    } catch (e) {
      expect((e as VfsError).code).toBe('INVALID_PATH');
    }
  });

  it('can delete files inside /share', async () => {
    await createFile(PROJECT, '/share/file.txt', 'content');
    await deleteFile(PROJECT, '/share/file.txt');
  });

  it('can delete files inside /sharerw', async () => {
    await createFile(PROJECT, '/sharerw/file.txt', 'content');
    await deleteFile(PROJECT, '/sharerw/file.txt');
  });
});
