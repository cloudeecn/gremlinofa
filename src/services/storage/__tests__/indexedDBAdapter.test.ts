/**
 * Unit tests for IndexedDBAdapter
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { IndexedDBAdapter } from '../adapters/IndexedDBAdapter';
import { Tables } from '../StorageAdapter';

// Set up fake-indexeddb globally
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
});

afterEach(async () => {
  // Clean up IndexedDB
  const databases = await indexedDB.databases?.();
  if (databases) {
    for (const db of databases) {
      if (db.name) {
        indexedDB.deleteDatabase(db.name);
      }
    }
  }
});

describe('IndexedDBAdapter', () => {
  let adapter: IndexedDBAdapter;

  beforeEach(async () => {
    adapter = new IndexedDBAdapter();
    await adapter.initialize();
  });

  describe('exportPaginated', () => {
    it('should return empty rows on empty table', async () => {
      const result = await adapter.exportPaginated(Tables.PROJECTS);

      expect(result).toEqual({ rows: [], hasMore: false });
    });

    it('should filter columns when columns parameter is provided', async () => {
      await adapter.save(Tables.PROJECTS, 'proj-1', 'encrypted-data-1', {
        timestamp: '2024-01-15T10:00:00Z',
        parentId: 'parent-1',
        unencryptedData: '{"version":1}',
      });

      // Request only id and timestamp columns
      const result = await adapter.exportPaginated(Tables.PROJECTS, undefined, ['id', 'timestamp']);

      expect(result.hasMore).toBe(false);
      expect(result.rows).toHaveLength(1);

      const row = result.rows[0];
      expect(row.id).toBe('proj-1');
      expect(row.timestamp).toBe('2024-01-15T10:00:00Z');
      // These should NOT be present
      expect(row.encryptedData).toBeUndefined();
      expect(row.parentId).toBeUndefined();
      expect(row.unencryptedData).toBeUndefined();
    });

    it('should return all columns when columns parameter is empty array', async () => {
      await adapter.save(Tables.PROJECTS, 'proj-1', 'encrypted-data-1', {
        timestamp: '2024-01-15T10:00:00Z',
      });

      const result = await adapter.exportPaginated(Tables.PROJECTS, undefined, []);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].id).toBe('proj-1');
      expect(result.rows[0].encryptedData).toBe('encrypted-data-1');
      expect(result.rows[0].timestamp).toBe('2024-01-15T10:00:00Z');
    });

    it('should return all columns when columns parameter is undefined', async () => {
      await adapter.save(Tables.PROJECTS, 'proj-1', 'encrypted-data-1', {
        timestamp: '2024-01-15T10:00:00Z',
      });

      const result = await adapter.exportPaginated(Tables.PROJECTS);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].id).toBe('proj-1');
      expect(result.rows[0].encryptedData).toBe('encrypted-data-1');
      expect(result.rows[0].timestamp).toBe('2024-01-15T10:00:00Z');
    });

    it('should return all records when under limit', async () => {
      // Insert test records
      await adapter.save(Tables.PROJECTS, 'proj-1', 'encrypted-data-1', {
        timestamp: '2024-01-15T10:00:00Z',
      });
      await adapter.save(Tables.PROJECTS, 'proj-2', 'encrypted-data-2', {
        timestamp: '2024-01-15T11:00:00Z',
        parentId: 'parent-1',
      });
      await adapter.save(Tables.PROJECTS, 'proj-3', 'encrypted-data-3', {
        unencryptedData: '{"version":1}',
      });

      const result = await adapter.exportPaginated(Tables.PROJECTS);

      expect(result.hasMore).toBe(false);
      expect(result.rows).toHaveLength(3);

      // Results should be sorted by id (primary key order)
      const ids = result.rows.map(r => r.id);
      expect(ids).toContain('proj-1');
      expect(ids).toContain('proj-2');
      expect(ids).toContain('proj-3');

      // Check that metadata is included
      const proj2 = result.rows.find(r => r.id === 'proj-2');
      expect(proj2).toBeDefined();
      expect(proj2?.encryptedData).toBe('encrypted-data-2');
      expect(proj2?.timestamp).toBe('2024-01-15T11:00:00Z');
      expect(proj2?.parentId).toBe('parent-1');

      const proj3 = result.rows.find(r => r.id === 'proj-3');
      expect(proj3?.unencryptedData).toBe('{"version":1}');
    });

    it('should respect afterId cursor and return remaining records', async () => {
      // Insert records with sortable IDs
      await adapter.save(Tables.MESSAGES, 'msg-a', 'data-a', {});
      await adapter.save(Tables.MESSAGES, 'msg-b', 'data-b', {});
      await adapter.save(Tables.MESSAGES, 'msg-c', 'data-c', {});
      await adapter.save(Tables.MESSAGES, 'msg-d', 'data-d', {});

      // Get records after 'msg-b' (exclusive)
      const result = await adapter.exportPaginated(Tables.MESSAGES, 'msg-b');

      expect(result.hasMore).toBe(false);
      // Should only include msg-c and msg-d
      expect(result.rows).toHaveLength(2);

      const ids = result.rows.map(r => r.id);
      expect(ids).not.toContain('msg-a');
      expect(ids).not.toContain('msg-b');
      expect(ids).toContain('msg-c');
      expect(ids).toContain('msg-d');
    });

    it('should return hasMore=true when row limit reached', async () => {
      // We need to override the row limit for testing
      // Since we can't easily access private static, we'll insert 201 records
      const promises = [];
      for (let i = 0; i < 201; i++) {
        const id = `msg-${String(i).padStart(5, '0')}`;
        promises.push(adapter.save(Tables.MESSAGES, id, 'data', {}));
      }
      await Promise.all(promises);

      const result = await adapter.exportPaginated(Tables.MESSAGES);

      expect(result.hasMore).toBe(true);
      expect(result.rows).toHaveLength(200);
    });

    it('should support pagination through multiple pages', async () => {
      // Insert 250 records
      const promises = [];
      for (let i = 0; i < 250; i++) {
        const id = `rec-${String(i).padStart(5, '0')}`;
        promises.push(adapter.save(Tables.PROJECTS, id, `data-${i}`, {}));
      }
      await Promise.all(promises);

      // First page
      const page1 = await adapter.exportPaginated(Tables.PROJECTS);
      expect(page1.hasMore).toBe(true);
      expect(page1.rows).toHaveLength(200);

      // Second page using last ID as cursor
      const lastId = page1.rows[page1.rows.length - 1].id;
      const page2 = await adapter.exportPaginated(Tables.PROJECTS, lastId);

      expect(page2.hasMore).toBe(false);
      expect(page2.rows).toHaveLength(50);

      // Verify no overlap
      const page1Ids = new Set(page1.rows.map(r => r.id));
      for (const row of page2.rows) {
        expect(page1Ids.has(row.id)).toBe(false);
      }
    });

    it('should return empty when afterId is past all records', async () => {
      await adapter.save(Tables.PROJECTS, 'proj-1', 'data', {});
      await adapter.save(Tables.PROJECTS, 'proj-2', 'data', {});

      // Use an afterId that's greater than all records
      const result = await adapter.exportPaginated(Tables.PROJECTS, 'zzz-9999');

      expect(result).toEqual({ rows: [], hasMore: false });
    });
  });

  describe('batchSave', () => {
    it('should return {saved: 0, skipped: 0} for empty rows array', async () => {
      const result = await adapter.batchSave(Tables.PROJECTS, [], true);

      expect(result).toEqual({ saved: 0, skipped: 0 });
    });

    it('should insert multiple records', async () => {
      const rows = [
        { id: 'proj-1', encryptedData: 'data-1', timestamp: '2024-01-15T10:00:00Z' },
        { id: 'proj-2', encryptedData: 'data-2', parentId: 'parent-1' },
        { id: 'proj-3', encryptedData: 'data-3', unencryptedData: '{"v":1}' },
      ];

      const result = await adapter.batchSave(Tables.PROJECTS, rows, false);

      expect(result).toEqual({ saved: 3, skipped: 0 });

      // Verify records were saved
      const saved1 = await adapter.get(Tables.PROJECTS, 'proj-1');
      expect(saved1?.encryptedData).toBe('data-1');

      const saved2 = await adapter.get(Tables.PROJECTS, 'proj-2');
      expect(saved2?.encryptedData).toBe('data-2');

      const saved3 = await adapter.get(Tables.PROJECTS, 'proj-3');
      expect(saved3?.encryptedData).toBe('data-3');
      expect(saved3?.unencryptedData).toBe('{"v":1}');
    });

    it('should skip existing records when skipExisting is true', async () => {
      // Pre-insert some records
      await adapter.save(Tables.MESSAGES, 'msg-1', 'original-data-1', {});
      await adapter.save(Tables.MESSAGES, 'msg-2', 'original-data-2', {});

      const rows = [
        { id: 'msg-1', encryptedData: 'new-data-1' }, // existing
        { id: 'msg-2', encryptedData: 'new-data-2' }, // existing
        { id: 'msg-3', encryptedData: 'new-data-3' }, // new
      ];

      const result = await adapter.batchSave(Tables.MESSAGES, rows, true);

      expect(result).toEqual({ saved: 1, skipped: 2 });

      // Verify existing records are unchanged
      const saved1 = await adapter.get(Tables.MESSAGES, 'msg-1');
      expect(saved1?.encryptedData).toBe('original-data-1');

      const saved2 = await adapter.get(Tables.MESSAGES, 'msg-2');
      expect(saved2?.encryptedData).toBe('original-data-2');

      // Verify new record was saved
      const saved3 = await adapter.get(Tables.MESSAGES, 'msg-3');
      expect(saved3?.encryptedData).toBe('new-data-3');
    });

    it('should overwrite existing records when skipExisting is false', async () => {
      // Pre-insert some records
      await adapter.save(Tables.MESSAGES, 'msg-1', 'original-data-1', {});
      await adapter.save(Tables.MESSAGES, 'msg-2', 'original-data-2', {});

      const rows = [
        { id: 'msg-1', encryptedData: 'new-data-1' },
        { id: 'msg-2', encryptedData: 'new-data-2' },
        { id: 'msg-3', encryptedData: 'new-data-3' },
      ];

      const result = await adapter.batchSave(Tables.MESSAGES, rows, false);

      expect(result).toEqual({ saved: 3, skipped: 0 });

      // Verify all records were updated/inserted
      const saved1 = await adapter.get(Tables.MESSAGES, 'msg-1');
      expect(saved1?.encryptedData).toBe('new-data-1');

      const saved2 = await adapter.get(Tables.MESSAGES, 'msg-2');
      expect(saved2?.encryptedData).toBe('new-data-2');

      const saved3 = await adapter.get(Tables.MESSAGES, 'msg-3');
      expect(saved3?.encryptedData).toBe('new-data-3');
    });

    it('should handle large batches', async () => {
      const rows = [];
      for (let i = 0; i < 500; i++) {
        rows.push({
          id: `msg-${String(i).padStart(5, '0')}`,
          encryptedData: `data-${i}`,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
        });
      }

      const result = await adapter.batchSave(Tables.MESSAGES, rows, false);

      expect(result).toEqual({ saved: 500, skipped: 0 });

      // Verify count
      const count = await adapter.count(Tables.MESSAGES);
      expect(count).toBe(500);
    });

    it('should preserve all metadata fields', async () => {
      const rows = [
        {
          id: 'msg-full',
          encryptedData: 'encrypted-content',
          timestamp: '2024-01-15T10:30:00Z',
          parentId: 'chat-123',
          unencryptedData: '{"role":"user","hasAttachments":true}',
        },
      ];

      await adapter.batchSave(Tables.MESSAGES, rows, false);

      // Export to verify all fields were saved
      const exported = await adapter.exportPaginated(Tables.MESSAGES);
      expect(exported.rows).toHaveLength(1);

      const saved = exported.rows[0];
      expect(saved.id).toBe('msg-full');
      expect(saved.encryptedData).toBe('encrypted-content');
      expect(saved.timestamp).toBe('2024-01-15T10:30:00Z');
      expect(saved.parentId).toBe('chat-123');
      expect(saved.unencryptedData).toBe('{"role":"user","hasAttachments":true}');
    });

    it('should handle mixed existing and new records with skipExisting true', async () => {
      // Pre-insert every other record
      for (let i = 0; i < 10; i += 2) {
        await adapter.save(Tables.CHATS, `chat-${i}`, `original-${i}`, {});
      }

      const rows = [];
      for (let i = 0; i < 10; i++) {
        rows.push({ id: `chat-${i}`, encryptedData: `new-${i}` });
      }

      const result = await adapter.batchSave(Tables.CHATS, rows, true);

      expect(result.saved).toBe(5); // 5 new records
      expect(result.skipped).toBe(5); // 5 existing records

      // Verify original records unchanged
      const chat0 = await adapter.get(Tables.CHATS, 'chat-0');
      expect(chat0?.encryptedData).toBe('original-0');

      // Verify new records inserted
      const chat1 = await adapter.get(Tables.CHATS, 'chat-1');
      expect(chat1?.encryptedData).toBe('new-1');
    });
  });

  describe('batchGet', () => {
    it('should return empty rows for empty ids array', async () => {
      const result = await adapter.batchGet(Tables.PROJECTS, []);

      expect(result).toEqual({ rows: [] });
    });

    it('should return all matching records', async () => {
      await adapter.save(Tables.MESSAGES, 'msg-1', 'data-1', { timestamp: '2024-01-01T00:00:00Z' });
      await adapter.save(Tables.MESSAGES, 'msg-2', 'data-2', { parentId: 'chat-1' });
      await adapter.save(Tables.MESSAGES, 'msg-3', 'data-3', {});

      const result = await adapter.batchGet(Tables.MESSAGES, ['msg-1', 'msg-3']);

      expect(result.rows).toHaveLength(2);
      const ids = result.rows.map(r => r.id);
      expect(ids).toContain('msg-1');
      expect(ids).toContain('msg-3');
    });

    it('should silently ignore missing IDs', async () => {
      await adapter.save(Tables.MESSAGES, 'msg-1', 'data-1', {});

      const result = await adapter.batchGet(Tables.MESSAGES, ['msg-1', 'msg-nonexistent', 'msg-2']);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].id).toBe('msg-1');
    });

    it('should filter columns when columns parameter is provided', async () => {
      await adapter.save(Tables.PROJECTS, 'proj-1', 'encrypted-data-1', {
        timestamp: '2024-01-15T10:00:00Z',
        parentId: 'parent-1',
        unencryptedData: '{"version":1}',
      });

      // Request only id and encryptedData columns
      const result = await adapter.batchGet(Tables.PROJECTS, ['proj-1'], ['id', 'encryptedData']);

      expect(result.rows).toHaveLength(1);

      const row = result.rows[0];
      expect(row.id).toBe('proj-1');
      expect(row.encryptedData).toBe('encrypted-data-1');
      // These should NOT be present
      expect(row.timestamp).toBeUndefined();
      expect(row.parentId).toBeUndefined();
      expect(row.unencryptedData).toBeUndefined();
    });

    it('should return all columns when columns parameter is empty array', async () => {
      await adapter.save(Tables.PROJECTS, 'proj-1', 'encrypted-data-1', {
        timestamp: '2024-01-15T10:00:00Z',
      });

      const result = await adapter.batchGet(Tables.PROJECTS, ['proj-1'], []);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].id).toBe('proj-1');
      expect(result.rows[0].encryptedData).toBe('encrypted-data-1');
      expect(result.rows[0].timestamp).toBe('2024-01-15T10:00:00Z');
    });

    it('should return all columns when columns parameter is undefined', async () => {
      await adapter.save(Tables.PROJECTS, 'proj-1', 'encrypted-data-1', {
        timestamp: '2024-01-15T10:00:00Z',
        parentId: 'parent-1',
      });

      const result = await adapter.batchGet(Tables.PROJECTS, ['proj-1']);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].id).toBe('proj-1');
      expect(result.rows[0].encryptedData).toBe('encrypted-data-1');
      expect(result.rows[0].timestamp).toBe('2024-01-15T10:00:00Z');
      expect(result.rows[0].parentId).toBe('parent-1');
    });
  });

  describe('integration: exportPaginated + batchSave', () => {
    it('should roundtrip data correctly', async () => {
      // Create original data
      const originalRows = [
        {
          id: 'proj-1',
          encryptedData: 'data-1',
          timestamp: '2024-01-01T00:00:00Z',
        },
        {
          id: 'proj-2',
          encryptedData: 'data-2',
          parentId: 'parent-1',
        },
        {
          id: 'proj-3',
          encryptedData: 'data-3',
          unencryptedData: '{"v":2}',
        },
      ];

      // Save via batchSave
      await adapter.batchSave(Tables.PROJECTS, originalRows, false);

      // Export
      const exported = await adapter.exportPaginated(Tables.PROJECTS);

      // Clear and reimport
      await adapter.clearAll();
      const reimportResult = await adapter.batchSave(Tables.PROJECTS, exported.rows, false);

      expect(reimportResult.saved).toBe(3);

      // Verify data integrity
      const finalExport = await adapter.exportPaginated(Tables.PROJECTS);

      for (const original of originalRows) {
        const reimported = finalExport.rows.find(r => r.id === original.id);
        expect(reimported).toBeDefined();
        expect(reimported?.encryptedData).toBe(original.encryptedData);
        expect(reimported?.timestamp).toBe(original.timestamp);
        expect(reimported?.parentId).toBe(original.parentId);
        expect(reimported?.unencryptedData).toBe(original.unencryptedData);
      }
    });
  });
});
