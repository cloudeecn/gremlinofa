import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteStorageAdapter } from '../SqliteStorageAdapter';
import { Tables } from '../../../shared/services/storage/StorageAdapter';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('SqliteStorageAdapter', () => {
  let adapter: SqliteStorageAdapter;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    adapter = new SqliteStorageAdapter(dbPath);
    await adapter.initialize();
  });

  afterEach(() => {
    adapter.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Basic CRUD
  // --------------------------------------------------------------------------

  describe('save and get', () => {
    it('should save and retrieve a record', async () => {
      await adapter.save(Tables.PROJECTS, 'p1', 'encrypted-data', {
        timestamp: '2024-01-01T00:00:00Z',
        parentId: undefined,
        unencryptedData: '{"name":"test"}',
      });

      const result = await adapter.get(Tables.PROJECTS, 'p1');
      expect(result).toEqual({
        encryptedData: 'encrypted-data',
        timestamp: '2024-01-01T00:00:00Z',
        unencryptedData: '{"name":"test"}',
      });
    });

    it('should return null for missing record', async () => {
      const result = await adapter.get(Tables.PROJECTS, 'nonexistent');
      expect(result).toBeNull();
    });

    it('should upsert on duplicate id', async () => {
      await adapter.save(Tables.PROJECTS, 'p1', 'v1', {});
      await adapter.save(Tables.PROJECTS, 'p1', 'v2', {});

      const result = await adapter.get(Tables.PROJECTS, 'p1');
      expect(result?.encryptedData).toBe('v2');
    });
  });

  // --------------------------------------------------------------------------
  // Query
  // --------------------------------------------------------------------------

  describe('query', () => {
    it('should filter by parentId', async () => {
      await adapter.save(Tables.CHATS, 'c1', 'data1', { parentId: 'p1', timestamp: '2024-01-01' });
      await adapter.save(Tables.CHATS, 'c2', 'data2', { parentId: 'p2', timestamp: '2024-01-02' });
      await adapter.save(Tables.CHATS, 'c3', 'data3', { parentId: 'p1', timestamp: '2024-01-03' });

      const results = await adapter.query(Tables.CHATS, { parentId: 'p1' });
      expect(results).toHaveLength(2);
    });

    it('should order by timestamp ascending', async () => {
      await adapter.save(Tables.CHATS, 'c1', 'first', { timestamp: '2024-01-01' });
      await adapter.save(Tables.CHATS, 'c2', 'second', { timestamp: '2024-01-03' });
      await adapter.save(Tables.CHATS, 'c3', 'third', { timestamp: '2024-01-02' });

      const results = await adapter.query(Tables.CHATS, {
        orderBy: 'timestamp',
        orderDirection: 'asc',
      });
      expect(results.map(r => r.encryptedData)).toEqual(['first', 'third', 'second']);
    });
  });

  // --------------------------------------------------------------------------
  // Delete
  // --------------------------------------------------------------------------

  describe('delete', () => {
    it('should delete a single record', async () => {
      await adapter.save(Tables.PROJECTS, 'p1', 'data', {});
      await adapter.delete(Tables.PROJECTS, 'p1');
      expect(await adapter.get(Tables.PROJECTS, 'p1')).toBeNull();
    });
  });

  describe('deleteMany', () => {
    it('should delete records by parentId', async () => {
      await adapter.save(Tables.MESSAGES, 'm1', 'd1', { parentId: 'c1' });
      await adapter.save(Tables.MESSAGES, 'm2', 'd2', { parentId: 'c1' });
      await adapter.save(Tables.MESSAGES, 'm3', 'd3', { parentId: 'c2' });

      await adapter.deleteMany(Tables.MESSAGES, { parentId: 'c1' });
      expect(await adapter.count(Tables.MESSAGES)).toBe(1);
      expect(await adapter.get(Tables.MESSAGES, 'm3')).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Count
  // --------------------------------------------------------------------------

  describe('count', () => {
    it('should count all records', async () => {
      await adapter.save(Tables.PROJECTS, 'p1', 'd1', {});
      await adapter.save(Tables.PROJECTS, 'p2', 'd2', {});
      expect(await adapter.count(Tables.PROJECTS)).toBe(2);
    });

    it('should count records by parentId', async () => {
      await adapter.save(Tables.MESSAGES, 'm1', 'd1', { parentId: 'c1' });
      await adapter.save(Tables.MESSAGES, 'm2', 'd2', { parentId: 'c2' });
      await adapter.save(Tables.MESSAGES, 'm3', 'd3', { parentId: 'c1' });

      expect(await adapter.count(Tables.MESSAGES, { parentId: 'c1' })).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // clearAll
  // --------------------------------------------------------------------------

  describe('clearAll', () => {
    it('should clear all tables', async () => {
      await adapter.save(Tables.PROJECTS, 'p1', 'd1', {});
      await adapter.save(Tables.CHATS, 'c1', 'd2', {});

      await adapter.clearAll();

      expect(await adapter.count(Tables.PROJECTS)).toBe(0);
      expect(await adapter.count(Tables.CHATS)).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // exportPaginated
  // --------------------------------------------------------------------------

  describe('exportPaginated', () => {
    it('should return empty rows on empty table', async () => {
      const result = await adapter.exportPaginated(Tables.PROJECTS);
      expect(result).toEqual({ rows: [], hasMore: false });
    });

    it('should paginate with afterId cursor', async () => {
      for (let i = 1; i <= 5; i++) {
        await adapter.save(Tables.PROJECTS, `p${i}`, `data${i}`, {});
      }

      const page1 = await adapter.exportPaginated(Tables.PROJECTS);
      expect(page1.rows.length).toBe(5);
      expect(page1.hasMore).toBe(false);

      // Fetch after p3
      const page2 = await adapter.exportPaginated(Tables.PROJECTS, 'p3');
      expect(page2.rows.length).toBe(2);
      expect(page2.rows[0].id).toBe('p4');
      expect(page2.rows[1].id).toBe('p5');
    });

    it('should filter columns', async () => {
      await adapter.save(Tables.PROJECTS, 'p1', 'encrypted', {
        timestamp: '2024-01-01',
        parentId: 'parent',
        unencryptedData: '{}',
      });

      const result = await adapter.exportPaginated(Tables.PROJECTS, undefined, ['id', 'timestamp']);
      const row = result.rows[0];
      expect(row.id).toBe('p1');
      expect(row.timestamp).toBe('2024-01-01');
      expect(row.encryptedData).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // batchSave
  // --------------------------------------------------------------------------

  describe('batchSave', () => {
    it('should save multiple records in a batch', async () => {
      const rows = [
        { id: 'p1', encryptedData: 'd1' },
        { id: 'p2', encryptedData: 'd2' },
        { id: 'p3', encryptedData: 'd3' },
      ];

      const result = await adapter.batchSave(Tables.PROJECTS, rows, false);
      expect(result).toEqual({ saved: 3, skipped: 0 });
      expect(await adapter.count(Tables.PROJECTS)).toBe(3);
    });

    it('should skip existing records when skipExisting=true', async () => {
      await adapter.save(Tables.PROJECTS, 'p1', 'existing', {});

      const rows = [
        { id: 'p1', encryptedData: 'new' },
        { id: 'p2', encryptedData: 'd2' },
      ];

      const result = await adapter.batchSave(Tables.PROJECTS, rows, true);
      expect(result).toEqual({ saved: 1, skipped: 1 });

      // Existing record should not be overwritten
      const existing = await adapter.get(Tables.PROJECTS, 'p1');
      expect(existing?.encryptedData).toBe('existing');
    });

    it('should overwrite existing records when skipExisting=false', async () => {
      await adapter.save(Tables.PROJECTS, 'p1', 'old', {});

      const rows = [{ id: 'p1', encryptedData: 'new' }];
      await adapter.batchSave(Tables.PROJECTS, rows, false);

      const updated = await adapter.get(Tables.PROJECTS, 'p1');
      expect(updated?.encryptedData).toBe('new');
    });

    it('should return zero counts for empty batch', async () => {
      const result = await adapter.batchSave(Tables.PROJECTS, [], false);
      expect(result).toEqual({ saved: 0, skipped: 0 });
    });
  });

  // --------------------------------------------------------------------------
  // batchGet
  // --------------------------------------------------------------------------

  describe('batchGet', () => {
    it('should fetch multiple records by IDs', async () => {
      await adapter.save(Tables.PROJECTS, 'p1', 'd1', {});
      await adapter.save(Tables.PROJECTS, 'p2', 'd2', {});
      await adapter.save(Tables.PROJECTS, 'p3', 'd3', {});

      const result = await adapter.batchGet(Tables.PROJECTS, ['p1', 'p3']);
      expect(result.rows).toHaveLength(2);
    });

    it('should silently skip missing IDs', async () => {
      await adapter.save(Tables.PROJECTS, 'p1', 'd1', {});

      const result = await adapter.batchGet(Tables.PROJECTS, ['p1', 'nonexistent']);
      expect(result.rows).toHaveLength(1);
    });

    it('should return empty for empty ID list', async () => {
      const result = await adapter.batchGet(Tables.PROJECTS, []);
      expect(result.rows).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // getStorageQuota
  // --------------------------------------------------------------------------

  describe('getStorageQuota', () => {
    it('should return usage and quota', async () => {
      const quota = await adapter.getStorageQuota();
      expect(quota).not.toBeNull();
      expect(quota!.usage).toBeGreaterThan(0);
      expect(quota!.quota).toBe(Infinity);
    });
  });

  // --------------------------------------------------------------------------
  // Initialize idempotency
  // --------------------------------------------------------------------------

  describe('initialize', () => {
    it('should be idempotent', async () => {
      // Already initialized in beforeEach, calling again should not throw
      await adapter.initialize();
      await adapter.save(Tables.PROJECTS, 'p1', 'data', {});
      expect(await adapter.count(Tables.PROJECTS)).toBe(1);
    });
  });
});
