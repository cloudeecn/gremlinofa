/**
 * Unit tests for Data Export
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { exportDataToCSV } from '../dataExport';
import type { StorageAdapter, ExportPage, ExportRow } from '../../services/storage/StorageAdapter';
import { Tables } from '../../services/storage/StorageAdapter';

describe('dataExport', () => {
  let mockAdapter: StorageAdapter;

  beforeEach(() => {
    // Create mock adapter with exportPaginated
    mockAdapter = {
      initialize: vi.fn(),
      save: vi.fn(),
      get: vi.fn(),
      query: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
      clearAll: vi.fn(),
      exportPaginated: vi.fn(),
      batchSave: vi.fn(),
      batchGet: vi.fn(),
      getStorageQuota: vi.fn().mockResolvedValue(null),
    };
  });

  describe('exportDataToCSV', () => {
    it('should export data with correct CSV header', async () => {
      // Mock empty database
      setupMockDatabase({});

      const csv = await exportDataToCSV(mockAdapter);

      expect(csv.split('\n')[0]).toBe(
        'tableName,id,encryptedData,timestamp,parentId,unencryptedData'
      );
    });

    it('should export tables in correct order', async () => {
      setupMockDatabase({
        [Tables.METADATA]: [
          {
            id: 'encryption_salt',
            encryptedData: '__METADATA__',
            unencryptedData: JSON.stringify({ value: 'test-salt' }),
          },
        ],
        [Tables.API_DEFINITIONS]: [{ id: 'api-1', encryptedData: 'encrypted-api-data' }],
        [Tables.PROJECTS]: [{ id: 'proj-1', encryptedData: 'encrypted-project-data' }],
        [Tables.CHATS]: [
          {
            id: 'chat-1',
            encryptedData: 'encrypted-chat-data',
            parentId: 'proj-1',
          },
        ],
        [Tables.MESSAGES]: [
          {
            id: 'msg-1',
            encryptedData: 'encrypted-message-data',
            parentId: 'chat-1',
          },
        ],
      });

      const csv = await exportDataToCSV(mockAdapter);
      const lines = csv.split('\n');

      // Check order: header, metadata, api_definitions, projects, chats, messages
      expect(lines[1]).toContain(Tables.METADATA);
      expect(lines[2]).toContain(Tables.API_DEFINITIONS);
      expect(lines[3]).toContain(Tables.PROJECTS);
      expect(lines[4]).toContain(Tables.CHATS);
      expect(lines[5]).toContain(Tables.MESSAGES);
    });

    it('should filter out default API definitions', async () => {
      setupMockDatabase({
        [Tables.API_DEFINITIONS]: [
          { id: 'api_default_something', encryptedData: 'default-data' },
          { id: 'user-api-1', encryptedData: 'user-data' },
        ],
      });

      const csv = await exportDataToCSV(mockAdapter);

      // Should only include user-defined API definition
      expect(csv).toContain('user-api-1');
      expect(csv).not.toContain('api_default_something');
    });

    it('should include all fields in CSV', async () => {
      setupMockDatabase({
        [Tables.CHATS]: [
          {
            id: 'chat-1',
            encryptedData: 'encrypted-data',
            timestamp: '2024-01-01T00:00:00Z',
            parentId: 'project-1',
          },
        ],
      });

      const csv = await exportDataToCSV(mockAdapter);
      const lines = csv.split('\n');

      const chatLine = lines[1];
      expect(chatLine).toContain(Tables.CHATS);
      expect(chatLine).toContain('chat-1');
      expect(chatLine).toContain('encrypted-data');
      expect(chatLine).toContain('2024-01-01T00:00:00Z');
      expect(chatLine).toContain('project-1');
    });

    it('should handle records with missing optional fields', async () => {
      setupMockDatabase({
        [Tables.PROJECTS]: [
          {
            id: 'proj-1',
            encryptedData: 'encrypted-data',
            // No timestamp or parentId
          },
        ],
      });

      const csv = await exportDataToCSV(mockAdapter);
      const lines = csv.split('\n');

      // Should not throw and should include the record
      expect(lines[1]).toContain('proj-1');
      expect(lines[1]).toContain('encrypted-data');
    });

    it('should properly escape CSV special characters', async () => {
      setupMockDatabase({
        [Tables.PROJECTS]: [
          {
            id: 'proj-1',
            encryptedData: 'data with "quotes" and, commas',
          },
        ],
      });

      const csv = await exportDataToCSV(mockAdapter);

      // CSV should properly escape the data
      expect(csv).toContain('"data with ""quotes"" and, commas"');
    });

    it('should handle empty tables', async () => {
      setupMockDatabase({
        [Tables.METADATA]: [],
        [Tables.API_DEFINITIONS]: [],
        [Tables.PROJECTS]: [],
        [Tables.CHATS]: [],
        [Tables.MESSAGES]: [],
      });

      const csv = await exportDataToCSV(mockAdapter);

      // Should only have header
      expect(csv.split('\n').length).toBe(1);
      expect(csv.split('\n')[0]).toContain('tableName');
    });

    it('should handle multiple records per table', async () => {
      setupMockDatabase({
        [Tables.PROJECTS]: [
          { id: 'proj-1', encryptedData: 'data-1' },
          { id: 'proj-2', encryptedData: 'data-2' },
          { id: 'proj-3', encryptedData: 'data-3' },
        ],
      });

      const csv = await exportDataToCSV(mockAdapter);
      const lines = csv.split('\n');

      expect(lines.length).toBe(4); // header + 3 projects
      expect(csv).toContain('proj-1');
      expect(csv).toContain('proj-2');
      expect(csv).toContain('proj-3');
    });

    it('should preserve unencryptedData field', async () => {
      setupMockDatabase({
        [Tables.METADATA]: [
          {
            id: 'test-key',
            encryptedData: '__METADATA__',
            unencryptedData: JSON.stringify({ value: 'test-value' }),
          },
        ],
      });

      const csv = await exportDataToCSV(mockAdapter);

      // JSON string should be CSV-escaped (quotes doubled and wrapped)
      expect(csv).toContain('"{""value"":""test-value""}"');
    });

    it('should handle pagination with multiple pages', async () => {
      // Test that pagination works correctly
      const records = Array.from({ length: 250 }, (_, i) => ({
        id: `msg-${i.toString().padStart(3, '0')}`,
        encryptedData: `data-${i}`,
        parentId: 'chat-1',
      }));

      // Mock with pagination (200 per page)
      vi.mocked(mockAdapter.exportPaginated).mockImplementation(
        async (table: string, afterId?: string): Promise<ExportPage> => {
          if (table === Tables.MESSAGES) {
            const startIdx = afterId ? records.findIndex(r => r.id === afterId) + 1 : 0;
            const pageRows = records.slice(startIdx, startIdx + 200);
            const hasMore = startIdx + 200 < records.length;
            return { rows: pageRows, hasMore };
          }
          return { rows: [], hasMore: false };
        }
      );

      const csv = await exportDataToCSV(mockAdapter);
      const lines = csv.split('\n');

      // Should have all 250 records + header
      expect(lines.length).toBe(251);
      expect(csv).toContain('msg-000');
      expect(csv).toContain('msg-249');
    });

    it('should work with any adapter implementing StorageAdapter', async () => {
      // Verify it doesn't require IndexedDBAdapter specifically
      const genericAdapter: StorageAdapter = {
        initialize: vi.fn(),
        save: vi.fn(),
        get: vi.fn(),
        query: vi.fn(),
        delete: vi.fn(),
        deleteMany: vi.fn(),
        count: vi.fn(),
        clearAll: vi.fn(),
        exportPaginated: vi.fn().mockResolvedValue({ rows: [], hasMore: false }),
        batchSave: vi.fn(),
        batchGet: vi.fn(),
        getStorageQuota: vi.fn().mockResolvedValue(null),
      };

      const csv = await exportDataToCSV(genericAdapter);

      // Should work without errors
      expect(csv.split('\n')[0]).toContain('tableName');
    });
  });

  /**
   * Helper to setup mock database with exportPaginated
   */
  function setupMockDatabase(tables: Record<string, Partial<ExportRow>[]>) {
    vi.mocked(mockAdapter.exportPaginated).mockImplementation(
      async (table: string): Promise<ExportPage> => {
        const records = tables[table] || [];
        return {
          rows: records.map(r => ({
            id: r.id || '',
            encryptedData: r.encryptedData || '',
            timestamp: r.timestamp,
            parentId: r.parentId,
            unencryptedData: r.unencryptedData,
          })),
          hasMore: false,
        };
      }
    );
  }
});
