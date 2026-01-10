/**
 * VFS Versioning Tests
 *
 * Tests for file version history including:
 * - Auto-versioning on update
 * - Version retrieval
 * - Version listing
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
  createFile,
  updateFile,
  getFileMeta,
  getFileId,
  getVersion,
  listVersions,
} from '../vfsService';

describe('VFS Versioning', () => {
  const projectId = 'test-project';

  beforeEach(() => {
    mockStorage.clear();
  });

  describe('auto-versioning on update', () => {
    it('starts at version 1 on create', async () => {
      await createFile(projectId, '/test.txt', 'initial content');

      const meta = await getFileMeta(projectId, '/test.txt');
      expect(meta?.version).toBe(1);
    });

    it('increments version on each update', async () => {
      await createFile(projectId, '/test.txt', 'v1');
      await updateFile(projectId, '/test.txt', 'v2');
      await updateFile(projectId, '/test.txt', 'v3');
      await updateFile(projectId, '/test.txt', 'v4');

      const meta = await getFileMeta(projectId, '/test.txt');
      expect(meta?.version).toBe(4);
    });

    it('stores previous content before updating', async () => {
      await createFile(projectId, '/test.txt', 'original');
      await updateFile(projectId, '/test.txt', 'modified');

      const fileId = await getFileId(projectId, '/test.txt');
      expect(fileId).not.toBeNull();

      // Version 1 should contain original content
      const v1Content = await getVersion(projectId, fileId!, 1);
      expect(v1Content).toBe('original');

      // Version 2 (current) should contain modified content
      const v2Content = await getVersion(projectId, fileId!, 2);
      expect(v2Content).toBe('modified');
    });
  });

  describe('getVersion', () => {
    it('returns content for current version', async () => {
      await createFile(projectId, '/test.txt', 'current');

      const fileId = await getFileId(projectId, '/test.txt');
      const content = await getVersion(projectId, fileId!, 1);

      expect(content).toBe('current');
    });

    it('returns content for historical versions', async () => {
      await createFile(projectId, '/test.txt', 'first');
      await updateFile(projectId, '/test.txt', 'second');
      await updateFile(projectId, '/test.txt', 'third');

      const fileId = await getFileId(projectId, '/test.txt');

      expect(await getVersion(projectId, fileId!, 1)).toBe('first');
      expect(await getVersion(projectId, fileId!, 2)).toBe('second');
      expect(await getVersion(projectId, fileId!, 3)).toBe('third');
    });

    it('returns null for non-existent version', async () => {
      await createFile(projectId, '/test.txt', 'content');

      const fileId = await getFileId(projectId, '/test.txt');

      expect(await getVersion(projectId, fileId!, 0)).toBeNull();
      expect(await getVersion(projectId, fileId!, 2)).toBeNull();
      expect(await getVersion(projectId, fileId!, 999)).toBeNull();
    });

    it('returns null for non-existent fileId', async () => {
      const content = await getVersion(projectId, 'non_existent_file_id', 1);
      expect(content).toBeNull();
    });
  });

  describe('listVersions', () => {
    it('returns single version for new file', async () => {
      await createFile(projectId, '/test.txt', 'content');

      const fileId = await getFileId(projectId, '/test.txt');
      const versions = await listVersions(projectId, fileId!);

      expect(versions).toHaveLength(1);
      expect(versions[0].version).toBe(1);
      expect(versions[0].createdAt).toBeGreaterThan(0);
    });

    it('returns all versions in ascending order', async () => {
      await createFile(projectId, '/test.txt', 'v1');
      await updateFile(projectId, '/test.txt', 'v2');
      await updateFile(projectId, '/test.txt', 'v3');

      const fileId = await getFileId(projectId, '/test.txt');
      const versions = await listVersions(projectId, fileId!);

      expect(versions).toHaveLength(3);
      expect(versions.map(v => v.version)).toEqual([1, 2, 3]);
    });

    it('returns timestamps for each version', async () => {
      await createFile(projectId, '/test.txt', 'v1');

      // Small delay to ensure different timestamps
      await new Promise(r => setTimeout(r, 10));
      await updateFile(projectId, '/test.txt', 'v2');

      const fileId = await getFileId(projectId, '/test.txt');
      const versions = await listVersions(projectId, fileId!);

      expect(versions[0].createdAt).toBeGreaterThan(0);
      expect(versions[1].createdAt).toBeGreaterThanOrEqual(versions[0].createdAt);
    });

    it('returns empty array for non-existent fileId', async () => {
      const versions = await listVersions(projectId, 'non_existent_file_id');
      expect(versions).toEqual([]);
    });
  });

  describe('version preservation across operations', () => {
    it('preserves versions after rename', async () => {
      await createFile(projectId, '/old.txt', 'original');
      await updateFile(projectId, '/old.txt', 'modified');

      const fileId = await getFileId(projectId, '/old.txt');

      // Import rename for this test
      const { rename } = await import('../vfsService');
      await rename(projectId, '/old.txt', '/new.txt');

      // fileId should still work (stable UUID)
      const versions = await listVersions(projectId, fileId!);
      expect(versions).toHaveLength(2);

      expect(await getVersion(projectId, fileId!, 1)).toBe('original');
      expect(await getVersion(projectId, fileId!, 2)).toBe('modified');
    });

    it('preserves versions after move', async () => {
      await createFile(projectId, '/src/file.txt', 'content v1');
      await updateFile(projectId, '/src/file.txt', 'content v2');

      const fileId = await getFileId(projectId, '/src/file.txt');

      const { rename, mkdir } = await import('../vfsService');
      await mkdir(projectId, '/dest');
      await rename(projectId, '/src/file.txt', '/dest/file.txt');

      const versions = await listVersions(projectId, fileId!);
      expect(versions).toHaveLength(2);
    });
  });
});
