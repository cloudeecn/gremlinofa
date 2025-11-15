/**
 * Unit tests for RemoteStorageAdapter
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RemoteStorageAdapter } from '../adapters/RemoteStorageAdapter';

describe('RemoteStorageAdapter', () => {
  let adapter: RemoteStorageAdapter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockFetch: any;

  const mockUserId = 'a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd';
  const mockPassword = 'test-password';
  const mockBaseUrl = 'https://example.com/storage';

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    adapter = new RemoteStorageAdapter(mockBaseUrl, mockUserId, mockPassword);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create adapter instance', () => {
      // We can't directly access private properties, but we can verify the adapter is created
      expect(adapter).toBeDefined();
    });
  });

  describe('buildUrl', () => {
    it('should build URL with baseUrl', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });

      await adapter.initialize();

      expect(mockFetch).toHaveBeenCalledWith(`${mockBaseUrl}/health`);
    });

    it('should use relative path when baseUrl is empty', async () => {
      const relativeAdapter = new RemoteStorageAdapter('', mockUserId, mockPassword);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });

      await relativeAdapter.initialize();

      expect(mockFetch).toHaveBeenCalledWith('/health');
    });

    it('should strip trailing slash from baseUrl', async () => {
      const trailingSlashAdapter = new RemoteStorageAdapter(
        'https://example.com/',
        mockUserId,
        mockPassword
      );
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });

      await trailingSlashAdapter.initialize();

      expect(mockFetch).toHaveBeenCalledWith('https://example.com/health');
    });
  });

  describe('initialize', () => {
    it('should verify connection with health check', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });

      await expect(adapter.initialize()).resolves.toBeUndefined();
      expect(mockFetch).toHaveBeenCalledWith(`${mockBaseUrl}/health`);
    });

    it('should throw on health check HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
      });

      await expect(adapter.initialize()).rejects.toThrow('Health check failed');
    });

    it('should throw on unexpected health status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'error' }),
      });

      await expect(adapter.initialize()).rejects.toThrow('unexpected status');
    });

    it('should throw on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      await expect(adapter.initialize()).rejects.toThrow('Failed to connect to storage backend');
    });
  });

  describe('save', () => {
    it('should PUT record with correct payload', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await adapter.save('projects', 'proj-123', 'encrypted-data', {
        timestamp: '2024-01-15T10:30:00.000Z',
        parentId: 'parent-123',
        unencryptedData: '{"version":1}',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/projects/proj-123`,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            encryptedData: 'encrypted-data',
            timestamp: '2024-01-15T10:30:00.000Z',
            parentId: 'parent-123',
            unencryptedData: '{"version":1}',
          }),
        })
      );
    });

    it('should include auth header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await adapter.save('projects', 'proj-123', 'data', {});

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Basic ${btoa(`${mockUserId}:${mockPassword}`)}`,
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should throw on error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'Invalid table' }),
      });

      await expect(adapter.save('invalid', 'id', 'data', {})).rejects.toThrow('Invalid table');
    });
  });

  describe('get', () => {
    it('should GET record by ID', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            encryptedData: 'encrypted-value',
            unencryptedData: '{"v":1}',
          }),
      });

      const result = await adapter.get('projects', 'proj-123');

      expect(result).toEqual({
        encryptedData: 'encrypted-value',
        unencryptedData: '{"v":1}',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/projects/proj-123`,
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should return null for 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await adapter.get('projects', 'non-existent');

      expect(result).toBeNull();
    });

    it('should throw on other errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Server error' }),
      });

      await expect(adapter.get('projects', 'proj-123')).rejects.toThrow('Server error');
    });
  });

  describe('query', () => {
    it('should GET all records from table', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { encryptedData: 'data1' },
            { encryptedData: 'data2', unencryptedData: 'meta2' },
          ]),
      });

      const result = await adapter.query('projects');

      expect(result).toEqual([
        { encryptedData: 'data1', unencryptedData: undefined },
        { encryptedData: 'data2', unencryptedData: 'meta2' },
      ]);
      expect(mockFetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/projects`,
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should include parentId filter in query string', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      await adapter.query('chats', { parentId: 'proj-123' });

      expect(mockFetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/chats?parentId=proj-123`,
        expect.any(Object)
      );
    });

    it('should include orderBy and orderDirection', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      await adapter.query('messages', {
        parentId: 'chat-1',
        orderBy: 'timestamp',
        orderDirection: 'desc',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/messages?parentId=chat-1&orderBy=timestamp&orderDirection=desc`,
        expect.any(Object)
      );
    });
  });

  describe('delete', () => {
    it('should DELETE record by ID', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await adapter.delete('projects', 'proj-123');

      expect(mockFetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/projects/proj-123`,
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  describe('deleteMany', () => {
    it('should DELETE records with parentId filter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await adapter.deleteMany('messages', { parentId: 'chat-123' });

      expect(mockFetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/messages?parentId=chat-123`,
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('should throw if parentId not provided', async () => {
      await expect(adapter.deleteMany('messages', {})).rejects.toThrow(
        'parentId is required for deleteMany'
      );
    });

    it('should encode special characters in parentId', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await adapter.deleteMany('messages', { parentId: 'chat with spaces' });

      expect(mockFetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/messages?parentId=chat%20with%20spaces`,
        expect.any(Object)
      );
    });
  });

  describe('count', () => {
    it('should GET count for table', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ count: 42 }),
      });

      const result = await adapter.count('projects');

      expect(result).toBe(42);
      expect(mockFetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/projects/_count`,
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should include parentId filter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ count: 5 }),
      });

      const result = await adapter.count('messages', { parentId: 'chat-1' });

      expect(result).toBe(5);
      expect(mockFetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/messages/_count?parentId=chat-1`,
        expect.any(Object)
      );
    });
  });

  describe('clearAll', () => {
    it('should POST to clear-all endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await adapter.clearAll();

      expect(mockFetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/_clear-all`,
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  describe('error handling', () => {
    it('should extract error message from JSON response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'Custom error message' }),
      });

      await expect(adapter.save('projects', 'id', 'data', {})).rejects.toThrow(
        'Custom error message'
      );
    });

    it('should fallback to HTTP status on non-JSON error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('Not JSON')),
      });

      await expect(adapter.save('projects', 'id', 'data', {})).rejects.toThrow('HTTP 500');
    });
  });

  describe('exportPaginated', () => {
    it('should GET all records from _export endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            rows: [
              { id: 'id1', encryptedData: 'data1', timestamp: '2024-01-15T10:00:00Z' },
              { id: 'id2', encryptedData: 'data2', parentId: 'parent1' },
            ],
            hasMore: false,
          }),
      });

      const result = await adapter.exportPaginated('projects');

      expect(result).toEqual({
        rows: [
          { id: 'id1', encryptedData: 'data1', timestamp: '2024-01-15T10:00:00Z' },
          { id: 'id2', encryptedData: 'data2', parentId: 'parent1' },
        ],
        hasMore: false,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/projects/_export`,
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should include afterId cursor in query string', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ rows: [], hasMore: false }),
      });

      await adapter.exportPaginated('messages', 'cursor-123');

      expect(mockFetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/messages/_export?afterId=cursor-123`,
        expect.any(Object)
      );
    });

    it('should return hasMore=true when more records exist', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            rows: [{ id: 'id1', encryptedData: 'data1' }],
            hasMore: true,
          }),
      });

      const result = await adapter.exportPaginated('projects');

      expect(result.hasMore).toBe(true);
    });

    it('should return empty rows on empty table', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ rows: [], hasMore: false }),
      });

      const result = await adapter.exportPaginated('projects');

      expect(result).toEqual({ rows: [], hasMore: false });
    });

    it('should throw on error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Export failed' }),
      });

      await expect(adapter.exportPaginated('projects')).rejects.toThrow('Export failed');
    });

    it('should include columns parameter in query string', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            rows: [{ id: 'id1', timestamp: '2024-01-15T10:00:00Z', parentId: 'parent1' }],
            hasMore: false,
          }),
      });

      await adapter.exportPaginated('messages', undefined, ['id', 'timestamp', 'parentId']);

      expect(mockFetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/messages/_export?columns=id%2Ctimestamp%2CparentId`,
        expect.any(Object)
      );
    });

    it('should include both afterId and columns in query string', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ rows: [], hasMore: false }),
      });

      await adapter.exportPaginated('messages', 'cursor-123', ['id', 'timestamp']);

      expect(mockFetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/messages/_export?afterId=cursor-123&columns=id%2Ctimestamp`,
        expect.any(Object)
      );
    });
  });

  describe('batchSave', () => {
    it('should POST multiple records to _batch endpoint', async () => {
      const rows = [
        { id: 'id1', encryptedData: 'data1', timestamp: '2024-01-15T10:00:00Z' },
        { id: 'id2', encryptedData: 'data2', parentId: 'parent1' },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ saved: 2, skipped: 0 }),
      });

      const result = await adapter.batchSave('projects', rows, true);

      expect(result).toEqual({ saved: 2, skipped: 0 });
      expect(mockFetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/projects/_batch`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ rows, skipExisting: true }),
        })
      );
    });

    it('should pass skipExisting=false for upsert mode', async () => {
      const rows = [{ id: 'id1', encryptedData: 'data1' }];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ saved: 1, skipped: 0 }),
      });

      await adapter.batchSave('projects', rows, false);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ rows, skipExisting: false }),
        })
      );
    });

    it('should return skipped count when skipExisting is true', async () => {
      const rows = [
        { id: 'existing-id', encryptedData: 'data1' },
        { id: 'new-id', encryptedData: 'data2' },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ saved: 1, skipped: 1 }),
      });

      const result = await adapter.batchSave('projects', rows, true);

      expect(result).toEqual({ saved: 1, skipped: 1 });
    });

    it('should handle empty rows array', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ saved: 0, skipped: 0 }),
      });

      const result = await adapter.batchSave('projects', [], true);

      expect(result).toEqual({ saved: 0, skipped: 0 });
    });

    it('should throw on error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'Batch save failed' }),
      });

      await expect(adapter.batchSave('projects', [], true)).rejects.toThrow('Batch save failed');
    });

    it('should include auth header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ saved: 0, skipped: 0 }),
      });

      await adapter.batchSave('projects', [], true);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Basic ${btoa(`${mockUserId}:${mockPassword}`)}`,
            'Content-Type': 'application/json',
          }),
        })
      );
    });
  });

  describe('batchGet', () => {
    it('should GET multiple records by IDs from _batch endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            rows: [
              { id: 'id1', encryptedData: 'data1', timestamp: '2024-01-15T10:00:00Z' },
              { id: 'id2', encryptedData: 'data2', parentId: 'parent1' },
            ],
          }),
      });

      const result = await adapter.batchGet('projects', ['id1', 'id2']);

      expect(result).toEqual({
        rows: [
          { id: 'id1', encryptedData: 'data1', timestamp: '2024-01-15T10:00:00Z' },
          { id: 'id2', encryptedData: 'data2', parentId: 'parent1' },
        ],
      });
      expect(mockFetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/projects/_batch?ids=id1%2Cid2`,
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should include columns parameter in query string', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            rows: [{ id: 'id1', timestamp: '2024-01-15T10:00:00Z' }],
          }),
      });

      await adapter.batchGet('projects', ['id1'], ['id', 'timestamp']);

      expect(mockFetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/projects/_batch?ids=id1&columns=id%2Ctimestamp`,
        expect.any(Object)
      );
    });

    it('should return empty rows for empty IDs array without calling API', async () => {
      const result = await adapter.batchGet('projects', []);

      expect(result).toEqual({ rows: [] });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return only found rows (missing IDs silently omitted)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            rows: [{ id: 'id1', encryptedData: 'data1' }],
          }),
      });

      const result = await adapter.batchGet('projects', ['id1', 'missing-id']);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].id).toBe('id1');
    });

    it('should throw on error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Batch get failed' }),
      });

      await expect(adapter.batchGet('projects', ['id1'])).rejects.toThrow('Batch get failed');
    });

    it('should include auth header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ rows: [] }),
      });

      await adapter.batchGet('projects', ['id1']);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Basic ${btoa(`${mockUserId}:${mockPassword}`)}`,
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should make single request when IDs fit within URL limit', async () => {
      // 40 short IDs (each ~5 chars) = ~200 chars total, well under 1700
      const shortIds = Array.from({ length: 40 }, (_, i) => `id${i}`);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            rows: shortIds.map(id => ({ id, encryptedData: `data-${id}` })),
          }),
      });

      const result = await adapter.batchGet('projects', shortIds);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.rows).toHaveLength(40);
    });

    it('should chunk IDs when total length exceeds 1700 chars', async () => {
      // Create 50 IDs of ~40 chars each = 2000+ chars total
      // Should result in multiple chunks
      const longIds = Array.from(
        { length: 50 },
        (_, i) => `project_${'a'.repeat(30)}${i.toString().padStart(2, '0')}`
      );

      // Mock responses for each chunk (we expect at least 2 chunks)
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              rows: longIds.slice(0, 25).map(id => ({ id, encryptedData: `data-${id}` })),
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              rows: longIds.slice(25).map(id => ({ id, encryptedData: `data-${id}` })),
            }),
        });

      const result = await adapter.batchGet('projects', longIds);

      // Should have made multiple requests
      expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
      // Results should be merged
      expect(result.rows).toHaveLength(50);
    });

    it('should merge results from multiple chunks correctly', async () => {
      // Create IDs that will require 3 chunks
      const longIds = Array.from(
        { length: 100 },
        (_, i) => `msg_${'x'.repeat(30)}${i.toString().padStart(3, '0')}`
      );

      // Each ID is ~36 chars + comma = 37 chars
      // 1700 / 37 ≈ 45 IDs per chunk
      // 100 IDs should be ~3 chunks

      const chunk1 = longIds.slice(0, 45).map(id => ({ id, encryptedData: `data-${id}` }));
      const chunk2 = longIds.slice(45, 90).map(id => ({ id, encryptedData: `data-${id}` }));
      const chunk3 = longIds.slice(90).map(id => ({ id, encryptedData: `data-${id}` }));

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ rows: chunk1 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ rows: chunk2 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ rows: chunk3 }),
        });

      const result = await adapter.batchGet('messages', longIds);

      // Should have all 100 results merged
      expect(result.rows).toHaveLength(100);
      // Verify order is preserved (flatMap maintains order)
      expect(result.rows[0].id).toBe(longIds[0]);
      expect(result.rows[99].id).toBe(longIds[99]);
    });

    it('should chunk based on accumulated string length, not count', async () => {
      // Create IDs that total > 1700 chars to force chunking
      // 50 IDs of ~40 chars each = 2000+ chars total
      const longIds = Array.from(
        { length: 50 },
        (_, i) => `project_${'z'.repeat(30)}${i.toString().padStart(2, '0')}`
      );

      // Should chunk based on actual string length
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            rows: [], // Empty for simplicity - we just care about request count
          }),
      });

      await adapter.batchGet('projects', longIds);

      // Multiple calls expected due to length-based chunking
      expect(mockFetch.mock.calls.length).toBeGreaterThan(1);

      // Verify each request's IDs param is under the limit
      for (const call of mockFetch.mock.calls) {
        const url = call[0] as string;
        const idsParam = new URL(url, 'http://test').searchParams.get('ids') || '';
        // Each chunk's IDs string should be ≤ 1700 chars
        expect(idsParam.length).toBeLessThanOrEqual(1700);
      }
    });
  });
});
