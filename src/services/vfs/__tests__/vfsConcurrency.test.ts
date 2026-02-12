/**
 * VFS Concurrency Tests
 *
 * Regression tests for the parallel write race condition (lost updates).
 * Without the tree lock, concurrent VFS writes would each loadTree → modify → saveTree
 * on a single JSON document, causing the second save to silently overwrite the first.
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

let fileCounter = 0;
vi.mock('../../../utils/idGenerator', () => ({
  generateUniqueId: vi.fn((prefix: string) => `${prefix}_${++fileCounter}`),
}));

import { createFile, deleteFile, readDir, mkdir } from '../vfsService';

const PROJECT_ID = 'test_project';

beforeEach(() => {
  mockStorage.clear();
  fileCounter = 0;
});

describe('VFS parallel write safety', () => {
  it('parallel deletes do not lose updates', async () => {
    const fileCount = 5;

    // Create files sequentially (setup)
    for (let i = 0; i < fileCount; i++) {
      await createFile(PROJECT_ID, `/file${i}.txt`, `content ${i}`);
    }

    // Verify all files exist
    const entriesBefore = await readDir(PROJECT_ID, '/');
    expect(entriesBefore).toHaveLength(fileCount);

    // Delete all files in parallel — this was the original race condition
    await Promise.all(
      Array.from({ length: fileCount }, (_, i) => deleteFile(PROJECT_ID, `/file${i}.txt`))
    );

    // All files should be deleted (soft-deleted, so readDir excludes them)
    const entriesAfter = await readDir(PROJECT_ID, '/');
    expect(entriesAfter).toHaveLength(0);
  });

  it('parallel creates in different directories do not lose updates', async () => {
    await mkdir(PROJECT_ID, '/dir1');
    await mkdir(PROJECT_ID, '/dir2');

    // Create files in different dirs simultaneously
    await Promise.all([
      createFile(PROJECT_ID, '/dir1/a.txt', 'a'),
      createFile(PROJECT_ID, '/dir2/b.txt', 'b'),
    ]);

    const dir1 = await readDir(PROJECT_ID, '/dir1');
    const dir2 = await readDir(PROJECT_ID, '/dir2');
    expect(dir1).toHaveLength(1);
    expect(dir2).toHaveLength(1);
  });

  it('interleaved create and delete on same project serialize correctly', async () => {
    await createFile(PROJECT_ID, '/target.txt', 'original');

    // Start delete and create concurrently
    await Promise.all([
      deleteFile(PROJECT_ID, '/target.txt'),
      createFile(PROJECT_ID, '/other.txt', 'new'),
    ]);

    const entries = await readDir(PROJECT_ID, '/');
    // target.txt should be deleted, other.txt should exist
    const names = entries.map(e => e.name);
    expect(names).toContain('other.txt');
    expect(names).not.toContain('target.txt');
  });
});
