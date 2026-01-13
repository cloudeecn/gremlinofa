/**
 * VFS Orphan Management Tests
 *
 * Tests for orphan handling including:
 * - Orphan creation on rename displacement
 * - Orphan listing
 * - Orphan restoration
 * - Orphan purging
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
  deleteFile,
  rename,
  readFile,
  exists,
  getFileId,
  getVersion,
  listVersions,
  listOrphans,
  restoreOrphan,
  purgeOrphan,
} from '../vfsService';

describe('VFS Orphan Management', () => {
  const projectId = 'test-project';

  beforeEach(() => {
    mockStorage.clear();
  });

  describe('orphan creation on rename displacement', () => {
    it('creates orphan when rename overwrites soft-deleted file', async () => {
      // Create two files
      await createFile(projectId, '/source.txt', 'source content');
      await createFile(projectId, '/target.txt', 'will be orphaned');

      // Soft-delete target
      await deleteFile(projectId, '/target.txt');

      // Get target fileId before rename
      // (need to get it from storage since file is deleted)
      const orphans0 = await listOrphans(projectId);
      expect(orphans0).toHaveLength(0);

      // Rename source → target, displacing the deleted target
      await rename(projectId, '/source.txt', '/target.txt');

      // Check orphan was created
      const orphans = await listOrphans(projectId);
      expect(orphans).toHaveLength(1);
      expect(orphans[0].originalPath).toBe('/target.txt');
      expect(orphans[0].orphanedAt).toBeGreaterThan(0);
    });

    it('preserves orphan file content and versions', async () => {
      await createFile(projectId, '/target.txt', 'v1');
      const { updateFile } = await import('../vfsService');
      await updateFile(projectId, '/target.txt', 'v2');

      const targetFileId = await getFileId(projectId, '/target.txt');
      await deleteFile(projectId, '/target.txt');

      await createFile(projectId, '/source.txt', 'source');
      await rename(projectId, '/source.txt', '/target.txt');

      // Orphan should have all versions preserved
      const orphans = await listOrphans(projectId);
      expect(orphans[0].fileId).toBe(targetFileId);

      const versions = await listVersions(projectId, targetFileId!);
      expect(versions).toHaveLength(2);

      expect(await getVersion(projectId, targetFileId!, 1)).toBe('v1');
      expect(await getVersion(projectId, targetFileId!, 2)).toBe('v2');
    });

    it('does not create orphan when overwriting non-file (directory)', async () => {
      const { mkdir, rmdir } = await import('../vfsService');

      // Create and delete a directory
      await mkdir(projectId, '/target');
      await rmdir(projectId, '/target');

      // Create source file
      await createFile(projectId, '/source.txt', 'content');

      // Rename source → target (directory)
      // This should overwrite the deleted directory without creating orphan
      await rename(projectId, '/source.txt', '/target');

      const orphans = await listOrphans(projectId);
      expect(orphans).toHaveLength(0);
    });
  });

  describe('listOrphans', () => {
    it('returns empty array when no orphans', async () => {
      const orphans = await listOrphans(projectId);
      expect(orphans).toEqual([]);
    });

    it('returns all orphans with correct info', async () => {
      // Create multiple orphans
      await createFile(projectId, '/a.txt', 'a');
      await createFile(projectId, '/b.txt', 'b');
      await deleteFile(projectId, '/a.txt');
      await deleteFile(projectId, '/b.txt');

      await createFile(projectId, '/new-a.txt', 'new a');
      await createFile(projectId, '/new-b.txt', 'new b');

      await rename(projectId, '/new-a.txt', '/a.txt');
      await rename(projectId, '/new-b.txt', '/b.txt');

      const orphans = await listOrphans(projectId);
      expect(orphans).toHaveLength(2);

      const paths = orphans.map(o => o.originalPath).sort();
      expect(paths).toEqual(['/a.txt', '/b.txt']);
    });
  });

  describe('restoreOrphan', () => {
    it('restores orphan to new path', async () => {
      // Create and orphan a file
      await createFile(projectId, '/original.txt', 'orphaned content');
      const fileId = await getFileId(projectId, '/original.txt');
      await deleteFile(projectId, '/original.txt');

      await createFile(projectId, '/other.txt', 'other');
      await rename(projectId, '/other.txt', '/original.txt');

      // Restore orphan to new location
      await restoreOrphan(projectId, fileId!, '/restored.txt');

      // Verify restoration
      expect(await exists(projectId, '/restored.txt')).toBe(true);
      expect(await readFile(projectId, '/restored.txt')).toBe('orphaned content');

      // Orphan should be removed from list
      const orphans = await listOrphans(projectId);
      expect(orphans).toHaveLength(0);
    });

    it('restores orphan to nested path (auto-creates parents)', async () => {
      await createFile(projectId, '/file.txt', 'content');
      const fileId = await getFileId(projectId, '/file.txt');
      await deleteFile(projectId, '/file.txt');

      await createFile(projectId, '/new.txt', 'new');
      await rename(projectId, '/new.txt', '/file.txt');

      await restoreOrphan(projectId, fileId!, '/deep/nested/path/restored.txt');

      expect(await exists(projectId, '/deep/nested/path/restored.txt')).toBe(true);
      expect(await readFile(projectId, '/deep/nested/path/restored.txt')).toBe('content');
    });

    it('throws when orphan not found', async () => {
      await expect(restoreOrphan(projectId, 'nonexistent', '/target.txt')).rejects.toMatchObject({
        code: 'PATH_NOT_FOUND',
      });
    });

    it('throws when target path already exists', async () => {
      await createFile(projectId, '/file.txt', 'content');
      const fileId = await getFileId(projectId, '/file.txt');
      await deleteFile(projectId, '/file.txt');

      await createFile(projectId, '/new.txt', 'new');
      await rename(projectId, '/new.txt', '/file.txt');

      // Create conflicting file
      await createFile(projectId, '/conflict.txt', 'conflict');

      await expect(restoreOrphan(projectId, fileId!, '/conflict.txt')).rejects.toMatchObject({
        code: 'DESTINATION_EXISTS',
      });
    });

    it('allows restoring to path with soft-deleted file', async () => {
      await createFile(projectId, '/orphan.txt', 'orphan');
      const orphanFileId = await getFileId(projectId, '/orphan.txt');
      await deleteFile(projectId, '/orphan.txt');

      await createFile(projectId, '/displacer.txt', 'displacer');
      await rename(projectId, '/displacer.txt', '/orphan.txt');

      // Create and delete another file at target path
      await createFile(projectId, '/target.txt', 'deleted target');
      await deleteFile(projectId, '/target.txt');

      // Should succeed - overwrites deleted file
      await restoreOrphan(projectId, orphanFileId!, '/target.txt');

      expect(await exists(projectId, '/target.txt')).toBe(true);
      expect(await readFile(projectId, '/target.txt')).toBe('orphan');
    });

    it('throws for root path', async () => {
      await createFile(projectId, '/file.txt', 'content');
      const fileId = await getFileId(projectId, '/file.txt');
      await deleteFile(projectId, '/file.txt');

      await createFile(projectId, '/new.txt', 'new');
      await rename(projectId, '/new.txt', '/file.txt');

      await expect(restoreOrphan(projectId, fileId!, '/')).rejects.toMatchObject({
        code: 'INVALID_PATH',
      });
    });
  });

  describe('purgeOrphan', () => {
    it('permanently deletes orphan file and versions', async () => {
      await createFile(projectId, '/file.txt', 'v1');
      const { updateFile } = await import('../vfsService');
      await updateFile(projectId, '/file.txt', 'v2');

      const fileId = await getFileId(projectId, '/file.txt');
      await deleteFile(projectId, '/file.txt');

      await createFile(projectId, '/new.txt', 'new');
      await rename(projectId, '/new.txt', '/file.txt');

      // Verify orphan exists
      let orphans = await listOrphans(projectId);
      expect(orphans).toHaveLength(1);

      // Purge it
      await purgeOrphan(projectId, fileId!);

      // Orphan should be gone
      orphans = await listOrphans(projectId);
      expect(orphans).toHaveLength(0);

      // File data should be gone (getVersion returns null)
      expect(await getVersion(projectId, fileId!, 1)).toBeNull();
      expect(await getVersion(projectId, fileId!, 2)).toBeNull();
    });

    it('throws when orphan not found', async () => {
      await expect(purgeOrphan(projectId, 'nonexistent')).rejects.toMatchObject({
        code: 'PATH_NOT_FOUND',
      });
    });

    it('removes correct orphan when multiple exist', async () => {
      // Create two orphans
      await createFile(projectId, '/a.txt', 'a');
      await createFile(projectId, '/b.txt', 'b');

      const fileIdA = await getFileId(projectId, '/a.txt');
      const fileIdB = await getFileId(projectId, '/b.txt');

      await deleteFile(projectId, '/a.txt');
      await deleteFile(projectId, '/b.txt');

      await createFile(projectId, '/new-a.txt', 'new a');
      await createFile(projectId, '/new-b.txt', 'new b');

      await rename(projectId, '/new-a.txt', '/a.txt');
      await rename(projectId, '/new-b.txt', '/b.txt');

      // Purge only orphan A
      await purgeOrphan(projectId, fileIdA!);

      const orphans = await listOrphans(projectId);
      expect(orphans).toHaveLength(1);
      expect(orphans[0].fileId).toBe(fileIdB);
    });
  });

  describe('orphan lifecycle', () => {
    it('can restore and then modify restored file', async () => {
      await createFile(projectId, '/original.txt', 'original');
      const fileId = await getFileId(projectId, '/original.txt');
      await deleteFile(projectId, '/original.txt');

      await createFile(projectId, '/new.txt', 'new');
      await rename(projectId, '/new.txt', '/original.txt');

      // Restore orphan
      await restoreOrphan(projectId, fileId!, '/restored.txt');

      // Modify the restored file
      const { updateFile } = await import('../vfsService');
      await updateFile(projectId, '/restored.txt', 'modified');

      expect(await readFile(projectId, '/restored.txt')).toBe('modified');

      // Version history should continue
      const versions = await listVersions(projectId, fileId!);
      expect(versions).toHaveLength(2);
    });

    it('orphan stays accessible after tree modifications', async () => {
      await createFile(projectId, '/orphan.txt', 'orphan content');
      const fileId = await getFileId(projectId, '/orphan.txt');
      await deleteFile(projectId, '/orphan.txt');

      await createFile(projectId, '/new.txt', 'new');
      await rename(projectId, '/new.txt', '/orphan.txt');

      // Do various tree operations
      const { mkdir, rmdir } = await import('../vfsService');
      await mkdir(projectId, '/dir');
      await createFile(projectId, '/dir/file.txt', 'content');
      await rmdir(projectId, '/dir', true);

      // Orphan should still be accessible
      const orphans = await listOrphans(projectId);
      expect(orphans).toHaveLength(1);
      expect(orphans[0].fileId).toBe(fileId);

      // Can still restore
      await restoreOrphan(projectId, fileId!, '/recovered.txt');
      expect(await readFile(projectId, '/recovered.txt')).toBe('orphan content');
    });
  });
});
