import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CachedStorageAdapter } from '../adapters/CachedStorageAdapter';
import type { StorageAdapter } from '../StorageAdapter';

function createMockAdapter(): StorageAdapter {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    query: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteMany: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0),
    clearAll: vi.fn().mockResolvedValue(undefined),
    exportPaginated: vi.fn().mockResolvedValue({ rows: [], hasMore: false }),
    batchSave: vi.fn().mockResolvedValue({ saved: 0, skipped: 0 }),
    batchGet: vi.fn().mockResolvedValue({ rows: [] }),
    getStorageQuota: vi.fn().mockResolvedValue(null),
  };
}

const RECORD = { encryptedData: 'enc-data', timestamp: '2024-01-01', unencryptedData: 'meta' };

describe('CachedStorageAdapter', () => {
  let inner: StorageAdapter;
  let cached: CachedStorageAdapter;

  beforeEach(() => {
    vi.restoreAllMocks();
    inner = createMockAdapter();
    cached = new CachedStorageAdapter(inner);
  });

  describe('get() caching', () => {
    it('returns cached value on second call without hitting inner adapter', async () => {
      vi.mocked(inner.get).mockResolvedValue(RECORD);

      const first = await cached.get('chats', 'c1');
      const second = await cached.get('chats', 'c1');

      expect(first).toEqual(RECORD);
      expect(second).toEqual(RECORD);
      expect(inner.get).toHaveBeenCalledTimes(1);
    });

    it('caches null results to avoid repeated misses', async () => {
      vi.mocked(inner.get).mockResolvedValue(null);

      const first = await cached.get('chats', 'missing');
      const second = await cached.get('chats', 'missing');

      expect(first).toBeNull();
      expect(second).toBeNull();
      expect(inner.get).toHaveBeenCalledTimes(1);
    });

    it('cache expires after TTL — inner adapter called again', async () => {
      vi.mocked(inner.get).mockResolvedValue(RECORD);

      await cached.get('chats', 'c1');
      expect(inner.get).toHaveBeenCalledTimes(1);

      // Advance past 10s TTL
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11_000);

      await cached.get('chats', 'c1');
      expect(inner.get).toHaveBeenCalledTimes(2);
    });

    it('does not mix keys across tables', async () => {
      vi.mocked(inner.get)
        .mockResolvedValueOnce({ encryptedData: 'chat-data' })
        .mockResolvedValueOnce({ encryptedData: 'msg-data' });

      const chat = await cached.get('chats', 'x1');
      const msg = await cached.get('messages', 'x1');

      expect(chat).toEqual({ encryptedData: 'chat-data' });
      expect(msg).toEqual({ encryptedData: 'msg-data' });
      expect(inner.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('write invalidation', () => {
    it('save() invalidates the cached key', async () => {
      vi.mocked(inner.get).mockResolvedValue(RECORD);
      await cached.get('chats', 'c1');
      expect(inner.get).toHaveBeenCalledTimes(1);

      await cached.save('chats', 'c1', 'new-data', {});

      // Next get should hit inner again
      await cached.get('chats', 'c1');
      expect(inner.get).toHaveBeenCalledTimes(2);
    });

    it('delete() invalidates the cached key', async () => {
      vi.mocked(inner.get).mockResolvedValue(RECORD);
      await cached.get('chats', 'c1');

      await cached.delete('chats', 'c1');

      await cached.get('chats', 'c1');
      expect(inner.get).toHaveBeenCalledTimes(2);
    });

    it('deleteMany() flushes all keys for that table', async () => {
      vi.mocked(inner.get).mockResolvedValue(RECORD);
      await cached.get('chats', 'c1');
      await cached.get('chats', 'c2');
      await cached.get('messages', 'm1');
      expect(inner.get).toHaveBeenCalledTimes(3);

      await cached.deleteMany('chats', { parentId: 'p1' });

      // chats entries flushed, messages untouched
      await cached.get('chats', 'c1');
      await cached.get('chats', 'c2');
      await cached.get('messages', 'm1');
      expect(inner.get).toHaveBeenCalledTimes(5); // 2 new chat calls, messages still cached
    });

    it('batchSave() invalidates each affected key', async () => {
      vi.mocked(inner.get).mockResolvedValue(RECORD);
      await cached.get('chats', 'c1');
      await cached.get('chats', 'c2');
      await cached.get('chats', 'c3');

      await cached.batchSave(
        'chats',
        [
          { id: 'c1', encryptedData: 'x' },
          { id: 'c3', encryptedData: 'y' },
        ],
        false
      );

      // c1 and c3 invalidated, c2 still cached
      await cached.get('chats', 'c1');
      await cached.get('chats', 'c2');
      await cached.get('chats', 'c3');
      expect(inner.get).toHaveBeenCalledTimes(5); // 3 original + c1 + c3 re-fetched
    });

    it('clearAll() flushes entire cache', async () => {
      vi.mocked(inner.get).mockResolvedValue(RECORD);
      await cached.get('chats', 'c1');
      await cached.get('messages', 'm1');

      await cached.clearAll();

      await cached.get('chats', 'c1');
      await cached.get('messages', 'm1');
      expect(inner.get).toHaveBeenCalledTimes(4);
    });
  });

  describe('passthrough methods', () => {
    it('query() delegates directly without caching', async () => {
      const rows = [{ encryptedData: 'data' }];
      vi.mocked(inner.query).mockResolvedValue(rows);

      const result = await cached.query('chats', { parentId: 'p1' });

      expect(result).toBe(rows);
      expect(inner.query).toHaveBeenCalledWith('chats', { parentId: 'p1' });
    });

    it('exportPaginated() delegates directly', async () => {
      await cached.exportPaginated('chats', 'after-id', ['id']);
      expect(inner.exportPaginated).toHaveBeenCalledWith('chats', 'after-id', ['id']);
    });

    it('batchGet() delegates directly', async () => {
      await cached.batchGet('chats', ['c1', 'c2']);
      expect(inner.batchGet).toHaveBeenCalledWith('chats', ['c1', 'c2'], undefined);
    });

    it('count() delegates directly', async () => {
      await cached.count('chats');
      expect(inner.count).toHaveBeenCalledWith('chats', undefined);
    });

    it('initialize() delegates to inner', async () => {
      await cached.initialize();
      expect(inner.initialize).toHaveBeenCalled();
    });
  });

  describe('lazy sweep', () => {
    it('clears expired entries when sweep interval has elapsed', async () => {
      vi.mocked(inner.get).mockResolvedValue(RECORD);

      // Populate cache
      await cached.get('chats', 'c1');
      await cached.get('chats', 'c2');
      expect(inner.get).toHaveBeenCalledTimes(2);

      // Advance past TTL (10s) but before sweep interval (20s)
      const baseNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(baseNow + 12_000);

      // c1 expired — get detects it and re-fetches
      await cached.get('chats', 'c1');
      expect(inner.get).toHaveBeenCalledTimes(3);

      // Advance past sweep interval (20s from creation)
      vi.mocked(Date.now).mockReturnValue(baseNow + 21_000);

      // Trigger sweep via a write
      await cached.save('chats', 'c3', 'data', {});

      // c2 was cached at baseNow with expiry baseNow+10_000 → swept
      // c1 was re-cached at baseNow+12_000 with expiry baseNow+22_000 → still valid
      await cached.get('chats', 'c1');
      await cached.get('chats', 'c2');
      expect(inner.get).toHaveBeenCalledTimes(4); // only c2 re-fetched
    });

    it('does not sweep if interval has not elapsed', async () => {
      vi.mocked(inner.get).mockResolvedValue(RECORD);
      await cached.get('chats', 'c1');

      // Advance only 5s — well within sweep interval
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_000);
      await cached.save('chats', 'c2', 'data', {});

      // c1 should still be cached (not swept, and TTL not expired)
      await cached.get('chats', 'c1');
      expect(inner.get).toHaveBeenCalledTimes(1);
    });
  });
});
