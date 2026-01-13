/**
 * VFS Service Tests
 *
 * Tests for the virtual filesystem service including:
 * - Path utilities
 * - File CRUD operations
 * - Directory operations
 * - Rename with orphan handling
 * - Soft-delete and restore
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before importing vfsService
vi.mock('../../encryption/encryptionService', () => ({
  encryptionService: {
    encryptWithCompression: vi.fn(async (data: string) => `encrypted:${data}`),
    decryptWithDecompression: vi.fn(async (data: string) => {
      if (data.startsWith('encrypted:')) {
        return data.slice(10);
      }
      throw new Error('Invalid encrypted data');
    }),
  },
}));

// In-memory storage mock
const mockStorage = new Map<string, Map<string, { encryptedData: string; parentId?: string }>>();

vi.mock('../../storage', () => ({
  storage: {
    getAdapter: () => ({
      get: vi.fn(async (table: string, id: string) => {
        const tableMap = mockStorage.get(table);
        return tableMap?.get(id) || null;
      }),
      save: vi.fn(
        async (
          table: string,
          id: string,
          encryptedData: string,
          metadata: { parentId?: string }
        ) => {
          if (!mockStorage.has(table)) {
            mockStorage.set(table, new Map());
          }
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
          if (record.parentId === filters.parentId) {
            tableMap.delete(id);
          }
        }
      }),
    }),
  },
}));

vi.mock('../../../utils/idGenerator', () => ({
  generateUniqueId: vi.fn((prefix: string) => `${prefix}_${Math.random().toString(36).slice(2)}`),
}));

import {
  normalizePath,
  getParentDir,
  getBasename,
  getPathSegments,
  isRootPath,
  createFile,
  readFile,
  updateFile,
  deleteFile,
  mkdir,
  rmdir,
  readDir,
  rename,
  exists,
  isFile,
  isDirectory,
  restore,
  purge,
  clearVfs,
  hasVfs,
  getFileMeta,
  VfsError,
} from '../vfsService';

describe('Path Utilities', () => {
  describe('normalizePath', () => {
    it('handles empty and whitespace paths', () => {
      expect(normalizePath('')).toBe('/');
      expect(normalizePath('   ')).toBe('/');
    });

    it('ensures leading slash', () => {
      expect(normalizePath('foo/bar')).toBe('/foo/bar');
      expect(normalizePath('/foo/bar')).toBe('/foo/bar');
    });

    it('removes trailing slash', () => {
      expect(normalizePath('/foo/bar/')).toBe('/foo/bar');
      expect(normalizePath('/foo/')).toBe('/foo');
    });

    it('resolves . and ..', () => {
      expect(normalizePath('/foo/./bar')).toBe('/foo/bar');
      expect(normalizePath('/foo/bar/../baz')).toBe('/foo/baz');
      expect(normalizePath('/foo/bar/../../baz')).toBe('/baz');
      expect(normalizePath('/foo/../..')).toBe('/');
    });

    it('handles multiple consecutive slashes', () => {
      expect(normalizePath('/foo//bar///baz')).toBe('/foo/bar/baz');
    });
  });

  describe('getParentDir', () => {
    it('returns root for root', () => {
      expect(getParentDir('/')).toBe('/');
    });

    it('returns root for top-level items', () => {
      expect(getParentDir('/foo')).toBe('/');
      expect(getParentDir('foo')).toBe('/');
    });

    it('returns parent for nested paths', () => {
      expect(getParentDir('/foo/bar')).toBe('/foo');
      expect(getParentDir('/foo/bar/baz')).toBe('/foo/bar');
    });
  });

  describe('getBasename', () => {
    it('returns empty for root', () => {
      expect(getBasename('/')).toBe('');
    });

    it('returns name for paths', () => {
      expect(getBasename('/foo')).toBe('foo');
      expect(getBasename('/foo/bar')).toBe('bar');
      expect(getBasename('foo/bar/baz.txt')).toBe('baz.txt');
    });
  });

  describe('getPathSegments', () => {
    it('returns empty array for root', () => {
      expect(getPathSegments('/')).toEqual([]);
    });

    it('returns segments for paths', () => {
      expect(getPathSegments('/foo')).toEqual(['foo']);
      expect(getPathSegments('/foo/bar/baz')).toEqual(['foo', 'bar', 'baz']);
    });
  });

  describe('isRootPath', () => {
    it('identifies root paths', () => {
      expect(isRootPath('/')).toBe(true);
      expect(isRootPath('')).toBe(true);
      expect(isRootPath('/foo')).toBe(false);
    });
  });
});

describe('VFS File Operations', () => {
  const projectId = 'test-project';

  beforeEach(() => {
    mockStorage.clear();
  });

  describe('createFile', () => {
    it('creates a file at root level', async () => {
      await createFile(projectId, '/test.txt', 'hello world');

      const content = await readFile(projectId, '/test.txt');
      expect(content).toBe('hello world');
    });

    it('creates a file in nested directory (auto-creates parents)', async () => {
      await createFile(projectId, '/foo/bar/test.txt', 'nested content');

      const content = await readFile(projectId, '/foo/bar/test.txt');
      expect(content).toBe('nested content');

      // Parent directories should exist
      expect(await isDirectory(projectId, '/foo')).toBe(true);
      expect(await isDirectory(projectId, '/foo/bar')).toBe(true);
    });

    it('throws when file already exists', async () => {
      await createFile(projectId, '/test.txt', 'first');

      await expect(createFile(projectId, '/test.txt', 'second')).rejects.toThrow(VfsError);
      await expect(createFile(projectId, '/test.txt', 'second')).rejects.toMatchObject({
        code: 'FILE_EXISTS',
      });
    });

    it('throws for root path', async () => {
      await expect(createFile(projectId, '/', 'content')).rejects.toMatchObject({
        code: 'INVALID_PATH',
      });
    });
  });

  describe('readFile', () => {
    it('reads file content', async () => {
      await createFile(projectId, '/test.txt', 'content here');
      expect(await readFile(projectId, '/test.txt')).toBe('content here');
    });

    it('throws for non-existent file', async () => {
      await expect(readFile(projectId, '/nonexistent.txt')).rejects.toMatchObject({
        code: 'PATH_NOT_FOUND',
      });
    });

    it('throws for directory', async () => {
      await mkdir(projectId, '/mydir');
      await expect(readFile(projectId, '/mydir')).rejects.toMatchObject({
        code: 'NOT_A_FILE',
      });
    });

    it('throws for deleted file', async () => {
      await createFile(projectId, '/test.txt', 'content');
      await deleteFile(projectId, '/test.txt');

      await expect(readFile(projectId, '/test.txt')).rejects.toMatchObject({
        code: 'IS_DELETED',
      });
    });
  });

  describe('updateFile', () => {
    it('updates file content and increments version', async () => {
      await createFile(projectId, '/test.txt', 'v1 content');

      let meta = await getFileMeta(projectId, '/test.txt');
      expect(meta?.version).toBe(1);

      await updateFile(projectId, '/test.txt', 'v2 content');

      meta = await getFileMeta(projectId, '/test.txt');
      expect(meta?.version).toBe(2);
      expect(await readFile(projectId, '/test.txt')).toBe('v2 content');
    });

    it('throws for non-existent file', async () => {
      await expect(updateFile(projectId, '/nonexistent.txt', 'content')).rejects.toMatchObject({
        code: 'PATH_NOT_FOUND',
      });
    });

    it('throws for deleted file', async () => {
      await createFile(projectId, '/test.txt', 'content');
      await deleteFile(projectId, '/test.txt');

      await expect(updateFile(projectId, '/test.txt', 'new content')).rejects.toMatchObject({
        code: 'IS_DELETED',
      });
    });
  });

  describe('deleteFile', () => {
    it('soft-deletes a file', async () => {
      await createFile(projectId, '/test.txt', 'content');
      expect(await exists(projectId, '/test.txt')).toBe(true);

      await deleteFile(projectId, '/test.txt');
      expect(await exists(projectId, '/test.txt')).toBe(false);
    });

    it('is idempotent for already deleted files', async () => {
      await createFile(projectId, '/test.txt', 'content');
      await deleteFile(projectId, '/test.txt');
      await deleteFile(projectId, '/test.txt'); // Should not throw
    });

    it('throws for non-existent file', async () => {
      await expect(deleteFile(projectId, '/nonexistent.txt')).rejects.toMatchObject({
        code: 'PATH_NOT_FOUND',
      });
    });
  });
});

describe('VFS Directory Operations', () => {
  const projectId = 'test-project';

  beforeEach(() => {
    mockStorage.clear();
  });

  describe('mkdir', () => {
    it('creates a directory', async () => {
      await mkdir(projectId, '/mydir');
      expect(await isDirectory(projectId, '/mydir')).toBe(true);
    });

    it('creates nested directories (auto-creates parents)', async () => {
      await mkdir(projectId, '/a/b/c');

      expect(await isDirectory(projectId, '/a')).toBe(true);
      expect(await isDirectory(projectId, '/a/b')).toBe(true);
      expect(await isDirectory(projectId, '/a/b/c')).toBe(true);
    });

    it('throws when directory exists', async () => {
      await mkdir(projectId, '/mydir');

      await expect(mkdir(projectId, '/mydir')).rejects.toMatchObject({
        code: 'DIR_EXISTS',
      });
    });

    it('throws when file exists at path', async () => {
      await createFile(projectId, '/conflict', 'content');

      await expect(mkdir(projectId, '/conflict')).rejects.toMatchObject({
        code: 'FILE_EXISTS',
      });
    });
  });

  describe('rmdir', () => {
    it('removes empty directory', async () => {
      await mkdir(projectId, '/mydir');
      await rmdir(projectId, '/mydir');

      expect(await exists(projectId, '/mydir')).toBe(false);
    });

    it('throws for non-empty directory without recursive', async () => {
      await createFile(projectId, '/mydir/file.txt', 'content');

      await expect(rmdir(projectId, '/mydir')).rejects.toMatchObject({
        code: 'DIR_NOT_EMPTY',
      });
    });

    it('removes non-empty directory with recursive flag', async () => {
      await createFile(projectId, '/mydir/file.txt', 'content');
      await createFile(projectId, '/mydir/sub/nested.txt', 'nested');

      await rmdir(projectId, '/mydir', true);

      expect(await exists(projectId, '/mydir')).toBe(false);
      expect(await exists(projectId, '/mydir/file.txt')).toBe(false);
      expect(await exists(projectId, '/mydir/sub/nested.txt')).toBe(false);
    });

    it('throws for root', async () => {
      await expect(rmdir(projectId, '/')).rejects.toMatchObject({
        code: 'INVALID_PATH',
      });
    });
  });

  describe('readDir', () => {
    it('lists directory contents', async () => {
      await createFile(projectId, '/file1.txt', 'content1');
      await createFile(projectId, '/file2.txt', 'content2');
      await mkdir(projectId, '/subdir');

      const entries = await readDir(projectId, '/');

      expect(entries).toHaveLength(3);
      expect(entries.map(e => e.name)).toContain('file1.txt');
      expect(entries.map(e => e.name)).toContain('file2.txt');
      expect(entries.map(e => e.name)).toContain('subdir');
    });

    it('sorts directories first, then by name', async () => {
      await createFile(projectId, '/zebra.txt', 'z');
      await mkdir(projectId, '/alpha');
      await createFile(projectId, '/apple.txt', 'a');
      await mkdir(projectId, '/zoo');

      const entries = await readDir(projectId, '/');
      const names = entries.map(e => e.name);

      expect(names).toEqual(['alpha', 'zoo', 'apple.txt', 'zebra.txt']);
    });

    it('excludes deleted items by default', async () => {
      await createFile(projectId, '/visible.txt', 'v');
      await createFile(projectId, '/deleted.txt', 'd');
      await deleteFile(projectId, '/deleted.txt');

      const entries = await readDir(projectId, '/');
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('visible.txt');
    });

    it('includes deleted items when requested', async () => {
      await createFile(projectId, '/visible.txt', 'v');
      await createFile(projectId, '/deleted.txt', 'd');
      await deleteFile(projectId, '/deleted.txt');

      const entries = await readDir(projectId, '/', true);
      expect(entries).toHaveLength(2);
    });

    it('includes file size for files', async () => {
      await createFile(projectId, '/test.txt', 'hello'); // 5 chars

      const entries = await readDir(projectId, '/');
      expect(entries[0].size).toBe(5);
    });
  });
});

describe('VFS Rename Operations', () => {
  const projectId = 'test-project';

  beforeEach(() => {
    mockStorage.clear();
  });

  it('renames a file', async () => {
    await createFile(projectId, '/old.txt', 'content');
    await rename(projectId, '/old.txt', '/new.txt');

    expect(await exists(projectId, '/old.txt')).toBe(false);
    expect(await exists(projectId, '/new.txt')).toBe(true);
    expect(await readFile(projectId, '/new.txt')).toBe('content');
  });

  it('moves a file to different directory', async () => {
    await createFile(projectId, '/src/file.txt', 'content');
    await mkdir(projectId, '/dest');
    await rename(projectId, '/src/file.txt', '/dest/file.txt');

    expect(await exists(projectId, '/src/file.txt')).toBe(false);
    expect(await exists(projectId, '/dest/file.txt')).toBe(true);
  });

  it('renames a directory', async () => {
    await createFile(projectId, '/olddir/file.txt', 'content');
    await rename(projectId, '/olddir', '/newdir');

    expect(await exists(projectId, '/olddir')).toBe(false);
    expect(await exists(projectId, '/newdir')).toBe(true);
    expect(await readFile(projectId, '/newdir/file.txt')).toBe('content');
  });

  it('throws when destination exists and not deleted', async () => {
    await createFile(projectId, '/src.txt', 'source');
    await createFile(projectId, '/dest.txt', 'dest');

    await expect(rename(projectId, '/src.txt', '/dest.txt')).rejects.toMatchObject({
      code: 'DESTINATION_EXISTS',
    });
  });

  it('creates orphan when displacing soft-deleted file', async () => {
    await createFile(projectId, '/src.txt', 'source');
    await createFile(projectId, '/dest.txt', 'will be orphaned');
    await deleteFile(projectId, '/dest.txt');

    // This should succeed and orphan the deleted dest.txt
    await rename(projectId, '/src.txt', '/dest.txt');

    expect(await exists(projectId, '/dest.txt')).toBe(true);
    expect(await readFile(projectId, '/dest.txt')).toBe('source');
  });

  it('no-op when source and dest are same', async () => {
    await createFile(projectId, '/test.txt', 'content');
    await rename(projectId, '/test.txt', '/test.txt'); // Should not throw

    expect(await readFile(projectId, '/test.txt')).toBe('content');
  });

  it('throws when source not found', async () => {
    await expect(rename(projectId, '/nonexistent', '/dest')).rejects.toMatchObject({
      code: 'PATH_NOT_FOUND',
    });
  });
});

describe('VFS Delete-Then-Create-Child Bug Fix', () => {
  const projectId = 'test-project';

  beforeEach(() => {
    mockStorage.clear();
  });

  it('restores deleted parent directory when creating child file', async () => {
    // 1. Create directory /a
    await mkdir(projectId, '/a');
    expect(await isDirectory(projectId, '/a')).toBe(true);

    // 2. Delete directory /a
    await rmdir(projectId, '/a');
    expect(await exists(projectId, '/a')).toBe(false);

    // 3. Create file /a/something - should auto-restore /a
    await createFile(projectId, '/a/something', 'content');

    // Verify both /a and /a/something are visible
    expect(await exists(projectId, '/a')).toBe(true);
    expect(await isDirectory(projectId, '/a')).toBe(true);
    expect(await exists(projectId, '/a/something')).toBe(true);
    expect(await readFile(projectId, '/a/something')).toBe('content');

    // Verify /a appears in root listing
    const rootEntries = await readDir(projectId, '/');
    expect(rootEntries.map(e => e.name)).toContain('a');

    // Verify /a/something appears in /a listing
    const aEntries = await readDir(projectId, '/a');
    expect(aEntries.map(e => e.name)).toContain('something');
  });

  it('restores nested deleted directories when creating deep child', async () => {
    // Create /a/b/c structure
    await mkdir(projectId, '/a/b/c');

    // Delete /a (recursive)
    await rmdir(projectId, '/a', true);
    expect(await exists(projectId, '/a')).toBe(false);
    expect(await exists(projectId, '/a/b')).toBe(false);

    // Create /a/b/file.txt - should restore /a and /a/b
    await createFile(projectId, '/a/b/file.txt', 'deep content');

    expect(await exists(projectId, '/a')).toBe(true);
    expect(await exists(projectId, '/a/b')).toBe(true);
    expect(await readFile(projectId, '/a/b/file.txt')).toBe('deep content');
  });

  it('keeps previously deleted files deleted when restoring parent', async () => {
    // Create /a with a file
    await createFile(projectId, '/a/old.txt', 'old content');

    // Delete /a (recursive) - marks both /a and /a/old.txt as deleted
    await rmdir(projectId, '/a', true);

    // Create new file in /a - restores /a but not old.txt
    await createFile(projectId, '/a/new.txt', 'new content');

    // /a and /a/new.txt should be visible
    expect(await exists(projectId, '/a')).toBe(true);
    expect(await exists(projectId, '/a/new.txt')).toBe(true);

    // /a/old.txt should still be deleted
    expect(await exists(projectId, '/a/old.txt')).toBe(false);

    // readDir should show only new.txt
    const entries = await readDir(projectId, '/a');
    expect(entries.map(e => e.name)).toEqual(['new.txt']);

    // But with includeDeleted, old.txt should appear
    const allEntries = await readDir(projectId, '/a', true);
    expect(allEntries.map(e => e.name).sort()).toEqual(['new.txt', 'old.txt']);
  });
});

describe('VFS Restore and Purge', () => {
  const projectId = 'test-project';

  beforeEach(() => {
    mockStorage.clear();
  });

  describe('restore', () => {
    it('restores a soft-deleted file', async () => {
      await createFile(projectId, '/test.txt', 'content');
      await deleteFile(projectId, '/test.txt');
      expect(await exists(projectId, '/test.txt')).toBe(false);

      await restore(projectId, '/test.txt');
      expect(await exists(projectId, '/test.txt')).toBe(true);
    });

    it('restores a soft-deleted directory', async () => {
      await mkdir(projectId, '/mydir');
      await rmdir(projectId, '/mydir');
      expect(await exists(projectId, '/mydir')).toBe(false);

      await restore(projectId, '/mydir');
      expect(await exists(projectId, '/mydir')).toBe(true);
    });

    it('is no-op for non-deleted items', async () => {
      await createFile(projectId, '/test.txt', 'content');
      await restore(projectId, '/test.txt'); // Should not throw
    });
  });

  describe('purge', () => {
    it('permanently deletes a soft-deleted file', async () => {
      await createFile(projectId, '/test.txt', 'content');
      await deleteFile(projectId, '/test.txt');
      await purge(projectId, '/test.txt');

      // Now it should truly not exist (can't even restore)
      await expect(restore(projectId, '/test.txt')).rejects.toMatchObject({
        code: 'PATH_NOT_FOUND',
      });
    });

    it('throws for non-deleted items', async () => {
      await createFile(projectId, '/test.txt', 'content');

      await expect(purge(projectId, '/test.txt')).rejects.toMatchObject({
        code: 'INVALID_PATH',
      });
    });
  });
});

describe('VFS Existence Checks', () => {
  const projectId = 'test-project';

  beforeEach(() => {
    mockStorage.clear();
  });

  it('exists returns true for files and directories', async () => {
    await createFile(projectId, '/file.txt', 'content');
    await mkdir(projectId, '/dir');

    expect(await exists(projectId, '/file.txt')).toBe(true);
    expect(await exists(projectId, '/dir')).toBe(true);
    expect(await exists(projectId, '/nonexistent')).toBe(false);
  });

  it('exists returns true for root', async () => {
    expect(await exists(projectId, '/')).toBe(true);
  });

  it('isFile distinguishes files from directories', async () => {
    await createFile(projectId, '/file.txt', 'content');
    await mkdir(projectId, '/dir');

    expect(await isFile(projectId, '/file.txt')).toBe(true);
    expect(await isFile(projectId, '/dir')).toBe(false);
  });

  it('isDirectory distinguishes directories from files', async () => {
    await createFile(projectId, '/file.txt', 'content');
    await mkdir(projectId, '/dir');

    expect(await isDirectory(projectId, '/file.txt')).toBe(false);
    expect(await isDirectory(projectId, '/dir')).toBe(true);
    expect(await isDirectory(projectId, '/')).toBe(true);
  });
});

describe('VFS Project Operations', () => {
  const projectId = 'test-project';

  beforeEach(() => {
    mockStorage.clear();
  });

  describe('hasVfs', () => {
    it('returns false for empty project', async () => {
      expect(await hasVfs(projectId)).toBe(false);
    });

    it('returns true after creating content', async () => {
      await createFile(projectId, '/test.txt', 'content');
      expect(await hasVfs(projectId)).toBe(true);
    });
  });

  describe('clearVfs', () => {
    it('removes all VFS data for project', async () => {
      await createFile(projectId, '/file1.txt', 'content1');
      await createFile(projectId, '/file2.txt', 'content2');
      await mkdir(projectId, '/dir');

      await clearVfs(projectId);

      expect(await hasVfs(projectId)).toBe(false);
    });
  });

  describe('getFileMeta', () => {
    it('returns metadata for existing file', async () => {
      await createFile(projectId, '/test.txt', 'content');

      const meta = await getFileMeta(projectId, '/test.txt');

      expect(meta).not.toBeNull();
      expect(meta?.version).toBe(1);
      expect(meta?.createdAt).toBeGreaterThan(0);
      expect(meta?.updatedAt).toBeGreaterThan(0);
    });

    it('returns null for non-existent file', async () => {
      expect(await getFileMeta(projectId, '/nonexistent.txt')).toBeNull();
    });

    it('returns null for directory', async () => {
      await mkdir(projectId, '/dir');
      expect(await getFileMeta(projectId, '/dir')).toBeNull();
    });
  });
});
