/**
 * VFS Migration Tests
 *
 * Tests for migrating old memory system data to VFS
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock encryption service before imports
vi.mock('../../encryption/encryptionService', () => ({
  encryptionService: {
    initialize: vi.fn(),
    encrypt: vi.fn((data: string) => Promise.resolve(`encrypted:${data}`)),
    decrypt: vi.fn((data: string) =>
      Promise.resolve(data.startsWith('encrypted:') ? data.slice(10) : data)
    ),
    encryptWithCompression: vi.fn((data: string) => Promise.resolve(`compressed:${data}`)),
    decryptWithDecompression: vi.fn((data: string) =>
      Promise.resolve(data.startsWith('compressed:') ? data.slice(11) : data)
    ),
  },
}));

// In-memory storage mock for VFS operations (shared with adapter mock)
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

import { migrateProjectMemories, migrateAllMemories } from '../migration';
import * as vfs from '../vfsService';
import { encryptionService } from '../../encryption/encryptionService';
import type { StorageAdapter, ExportPage, BatchSaveResult } from '../../storage/StorageAdapter';

// Helper to create mock adapter
function createMockAdapter(data: Record<string, Record<string, unknown>> = {}): StorageAdapter {
  const storage: Record<string, Record<string, unknown>> = { ...data };

  return {
    initialize: vi.fn(),
    save: vi.fn(async (table: string, id: string, encryptedData: string, metadata) => {
      if (!storage[table]) storage[table] = {};
      storage[table][id] = { encryptedData, ...metadata };
    }),
    get: vi.fn(async (table: string, id: string) => {
      const record = storage[table]?.[id];
      if (!record) return null;
      return record as { encryptedData: string; unencryptedData?: string };
    }),
    query: vi.fn(async () => []),
    delete: vi.fn(async (table: string, id: string) => {
      if (storage[table]) delete storage[table][id];
    }),
    deleteMany: vi.fn(async (table: string, filters) => {
      if (storage[table] && filters.parentId) {
        for (const id of Object.keys(storage[table])) {
          const record = storage[table][id] as { parentId?: string };
          if (record.parentId === filters.parentId) {
            delete storage[table][id];
          }
        }
      }
    }),
    count: vi.fn(async () => 0),
    clearAll: vi.fn(async () => {
      for (const table of Object.keys(storage)) {
        storage[table] = {};
      }
    }),
    exportPaginated: vi.fn(async (table: string): Promise<ExportPage> => {
      const records = storage[table] || {};
      const rows = Object.entries(records).map(([id, record]) => {
        const rec = record as Record<string, unknown>;
        return {
          id,
          encryptedData: rec.encryptedData as string,
          timestamp: rec.timestamp as string | undefined,
          parentId: rec.parentId as string | undefined,
        };
      });
      return { rows, hasMore: false };
    }),
    batchSave: vi.fn(async (): Promise<BatchSaveResult> => ({ saved: 0, skipped: 0 })),
    batchGet: vi.fn(async () => ({ rows: [] })),
    getStorageQuota: vi.fn().mockResolvedValue(null),
  };
}

describe('VFS Migration', () => {
  beforeEach(async () => {
    // Clear in-memory storage for VFS
    mockStorage.clear();
    // Initialize encryption service
    await encryptionService.initialize();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('migrateProjectMemories', () => {
    it('skips migration when VFS data already exists', async () => {
      const adapter = createMockAdapter({
        vfs_meta: {
          vfs_meta_project123: {
            encryptedData: 'compressed:{"children":{},"orphans":[]}',
          },
        },
      });

      const result = await migrateProjectMemories(adapter, 'project123');

      expect(result.projectId).toBe('project123');
      expect(result.journalEntriesReplayed).toBe(0);
      expect(result.filesCreated).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('skips migration when no old data exists', async () => {
      const adapter = createMockAdapter({});

      const result = await migrateProjectMemories(adapter, 'project123');

      expect(result.projectId).toBe('project123');
      expect(result.journalEntriesReplayed).toBe(0);
      expect(result.filesCreated).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('migrates old memories without journal', async () => {
      const oldMemories = {
        files: {
          '/memories/notes.md': {
            content: '# My Notes\nSome content here',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-02T00:00:00Z',
          },
          '/memories/todo.txt': {
            content: '- Task 1\n- Task 2',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        },
      };

      const adapter = createMockAdapter({
        memories: {
          project123: {
            encryptedData: `compressed:${JSON.stringify(oldMemories)}`,
          },
        },
      });

      const result = await migrateProjectMemories(adapter, 'project123');

      expect(result.projectId).toBe('project123');
      expect(result.journalEntriesReplayed).toBe(0);
      expect(result.filesCreated).toBe(2);
      expect(result.filesUpdated).toBe(0);
      expect(result.filesDeleted).toBe(0);
      expect(result.errors).toHaveLength(0);

      // Verify files were created
      expect(await vfs.exists('project123', '/memories/notes.md')).toBe(true);
      expect(await vfs.exists('project123', '/memories/todo.txt')).toBe(true);

      // Verify content
      expect(await vfs.readFile('project123', '/memories/notes.md')).toBe(
        '# My Notes\nSome content here'
      );
      expect(await vfs.readFile('project123', '/memories/todo.txt')).toBe('- Task 1\n- Task 2');

      // Verify old data was cleaned up
      expect(adapter.delete).toHaveBeenCalledWith('memories', 'project123');
      expect(adapter.deleteMany).toHaveBeenCalledWith('memory_journals', {
        parentId: 'project123',
      });
    });

    it('replays journal entries to build version history', async () => {
      const oldMemories = {
        files: {
          '/memories/notes.md': {
            content: 'Final content v3',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-03T00:00:00Z',
          },
        },
      };

      const journalEntries = [
        {
          id: 'jrnl_001',
          encryptedData: `compressed:${JSON.stringify({
            command: 'create',
            path: '/memories/notes.md',
            file_text: 'Initial content v1',
          })}`,
          timestamp: '2024-01-01T00:00:00Z',
          parentId: 'project123',
        },
        {
          id: 'jrnl_002',
          encryptedData: `compressed:${JSON.stringify({
            command: 'str_replace',
            path: '/memories/notes.md',
            old_str: 'v1',
            new_str: 'v2',
          })}`,
          timestamp: '2024-01-02T00:00:00Z',
          parentId: 'project123',
        },
      ];

      const adapter = createMockAdapter({
        memories: {
          project123: {
            encryptedData: `compressed:${JSON.stringify(oldMemories)}`,
          },
        },
        memory_journals: Object.fromEntries(journalEntries.map(e => [e.id, { ...e }])),
      });

      const result = await migrateProjectMemories(adapter, 'project123');

      expect(result.journalEntriesReplayed).toBe(2);
      expect(result.filesCreated).toBe(0); // Created via journal replay
      expect(result.filesUpdated).toBe(1); // Final sync updated to v3
      expect(result.errors).toHaveLength(0);

      // Verify final content matches current memories
      expect(await vfs.readFile('project123', '/memories/notes.md')).toBe('Final content v3');

      // Verify version history was created
      const fileId = await vfs.getFileId('project123', '/memories/notes.md');
      expect(fileId).toBeTruthy();

      const versions = await vfs.listVersions('project123', fileId!);
      expect(versions.length).toBeGreaterThan(1);
    });

    it('handles path normalization for old format paths', async () => {
      const oldMemories = {
        files: {
          // Old format without /memories prefix
          'notes.md': {
            content: 'Content without prefix',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
          // Old format with /memories prefix
          '/memories/other.md': {
            content: 'Content with prefix',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        },
      };

      const adapter = createMockAdapter({
        memories: {
          project456: {
            encryptedData: `compressed:${JSON.stringify(oldMemories)}`,
          },
        },
      });

      const result = await migrateProjectMemories(adapter, 'project456');

      expect(result.filesCreated).toBe(2);
      expect(result.errors).toHaveLength(0);

      // Both should be accessible under /memories
      expect(await vfs.exists('project456', '/memories/notes.md')).toBe(true);
      expect(await vfs.exists('project456', '/memories/other.md')).toBe(true);
    });

    it('deletes VFS files that do not exist in current memories', async () => {
      // First, create a file via journal that won't be in final memories
      const journalEntries = [
        {
          id: 'jrnl_001',
          encryptedData: `compressed:${JSON.stringify({
            command: 'create',
            path: '/memories/deleted.md',
            file_text: 'This will be deleted',
          })}`,
          timestamp: '2024-01-01T00:00:00Z',
          parentId: 'project789',
        },
        {
          id: 'jrnl_002',
          encryptedData: `compressed:${JSON.stringify({
            command: 'create',
            path: '/memories/kept.md',
            file_text: 'This will be kept',
          })}`,
          timestamp: '2024-01-02T00:00:00Z',
          parentId: 'project789',
        },
      ];

      // Current memories only has kept.md
      const oldMemories = {
        files: {
          '/memories/kept.md': {
            content: 'This will be kept',
            createdAt: '2024-01-02T00:00:00Z',
            updatedAt: '2024-01-02T00:00:00Z',
          },
        },
      };

      const adapter = createMockAdapter({
        memories: {
          project789: {
            encryptedData: `compressed:${JSON.stringify(oldMemories)}`,
          },
        },
        memory_journals: Object.fromEntries(journalEntries.map(e => [e.id, { ...e }])),
      });

      const result = await migrateProjectMemories(adapter, 'project789');

      expect(result.journalEntriesReplayed).toBe(2);
      expect(result.filesDeleted).toBe(1); // deleted.md removed

      // deleted.md should be soft-deleted
      expect(await vfs.exists('project789', '/memories/deleted.md')).toBe(false);
      // kept.md should still exist
      expect(await vfs.exists('project789', '/memories/kept.md')).toBe(true);
    });

    it('handles journal errors gracefully', async () => {
      const journalEntries = [
        {
          id: 'jrnl_001',
          encryptedData: `compressed:${JSON.stringify({
            command: 'str_replace',
            path: '/memories/nonexistent.md',
            old_str: 'foo',
            new_str: 'bar',
          })}`,
          timestamp: '2024-01-01T00:00:00Z',
          parentId: 'project_err',
        },
      ];

      const oldMemories = {
        files: {},
      };

      const adapter = createMockAdapter({
        memories: {
          project_err: {
            encryptedData: `compressed:${JSON.stringify(oldMemories)}`,
          },
        },
        memory_journals: Object.fromEntries(journalEntries.map(e => [e.id, { ...e }])),
      });

      const result = await migrateProjectMemories(adapter, 'project_err');

      // Should still succeed - errors are logged but not fatal
      expect(result.journalEntriesReplayed).toBe(1);
      expect(result.errors).toHaveLength(0); // VfsError is caught and logged
    });
  });

  describe('migrateAllMemories', () => {
    it('returns empty stats when no old data exists', async () => {
      const adapter = createMockAdapter({});

      const stats = await migrateAllMemories(adapter);

      expect(stats.migrated).toBe(0);
      expect(stats.skipped).toBe(0);
      expect(stats.errors).toHaveLength(0);
    });

    it('migrates multiple projects', async () => {
      const adapter = createMockAdapter({
        memories: {
          proj1: {
            encryptedData: `compressed:${JSON.stringify({
              files: {
                '/memories/a.md': {
                  content: 'Project 1 file',
                  createdAt: '2024-01-01T00:00:00Z',
                  updatedAt: '2024-01-01T00:00:00Z',
                },
              },
            })}`,
          },
          proj2: {
            encryptedData: `compressed:${JSON.stringify({
              files: {
                '/memories/b.md': {
                  content: 'Project 2 file',
                  createdAt: '2024-01-01T00:00:00Z',
                  updatedAt: '2024-01-01T00:00:00Z',
                },
              },
            })}`,
          },
        },
      });

      const stats = await migrateAllMemories(adapter);

      expect(stats.migrated).toBe(2);
      expect(stats.skipped).toBe(0);
      expect(stats.errors).toHaveLength(0);

      // Verify both projects were migrated
      expect(await vfs.exists('proj1', '/memories/a.md')).toBe(true);
      expect(await vfs.exists('proj2', '/memories/b.md')).toBe(true);
    });

    it('discovers projects from memory_journals too', async () => {
      const adapter = createMockAdapter({
        memory_journals: {
          jrnl_001: {
            encryptedData: `compressed:${JSON.stringify({
              command: 'create',
              path: '/memories/orphan.md',
              file_text: 'Created via journal only',
            })}`,
            timestamp: '2024-01-01T00:00:00Z',
            parentId: 'proj_orphan',
          },
        },
      });

      const stats = await migrateAllMemories(adapter);

      // Should find project from journal even without memories record
      expect(stats.migrated).toBe(1);
    });
  });
});
