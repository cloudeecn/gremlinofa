/**
 * Unit tests for Data Import
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { importDataFromFile } from '../dataImport';
import { EncryptionService } from '../../services/encryption/encryptionService';
import { Tables } from '../../services/storage/StorageAdapter';
import type {
  StorageAdapter,
  BatchSaveRow,
  BatchSaveResult,
} from '../../services/storage/StorageAdapter';

// Mock EncryptionService
vi.mock('../../services/encryption/encryptionService');

/**
 * Helper to convert CSV string to File object for testing
 */
function csvToFile(csvContent: string): File {
  return new File([csvContent], 'test.csv', { type: 'text/csv' });
}

/**
 * Helper to build CSV content from records
 */
function buildCSV(
  records: Array<{
    tableName: string;
    id: string;
    encryptedData: string;
    timestamp?: string;
    parentId?: string;
    unencryptedData?: string;
  }>
): string {
  const header = 'tableName,id,encryptedData,timestamp,parentId,unencryptedData';
  const rows = records.map(r => {
    const escapeCsv = (val: string | undefined): string => {
      if (!val) return '';
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };

    return [
      r.tableName,
      r.id,
      r.encryptedData,
      r.timestamp || '',
      r.parentId || '',
      escapeCsv(r.unencryptedData),
    ].join(',');
  });

  return [header, ...rows].join('\n');
}

describe('dataImport', () => {
  let mockAdapter: StorageAdapter;
  let mockSourceEncryption: any;
  let mockAppEncryption: any;
  let batchSaveTracker: { table: string; rows: BatchSaveRow[]; skipExisting: boolean }[];

  beforeEach(() => {
    batchSaveTracker = [];

    // Create mock adapter with batchSave
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
      batchGet: vi.fn(),
      batchSave: vi
        .fn()
        .mockImplementation(
          async (
            table: string,
            rows: BatchSaveRow[],
            skipExisting: boolean
          ): Promise<BatchSaveResult> => {
            batchSaveTracker.push({ table, rows: [...rows], skipExisting });
            // Default: save all
            return { saved: rows.length, skipped: 0 };
          }
        ),
    };

    // Create mock encryption services
    mockSourceEncryption = {
      initializeWithCEK: vi.fn().mockResolvedValue(undefined),
      decrypt: vi.fn().mockImplementation(async (data: string) => {
        return `decrypted:${data}`;
      }),
      encrypt: vi.fn(),
      hasSameKeyAs: vi.fn().mockReturnValue(false), // Different keys = re-encrypt
    };

    mockAppEncryption = {
      initializeWithCEK: vi.fn(),
      decrypt: vi.fn(),
      encrypt: vi.fn().mockImplementation(async (data: string) => {
        return `re-encrypted:${data}`;
      }),
    };

    // Mock EncryptionService constructor to return our mock
    (EncryptionService as any).mockImplementation(function (this: any) {
      return mockSourceEncryption;
    });
  });

  describe('importDataFromFile', () => {
    it('should throw error for empty CSV', async () => {
      const file = csvToFile('');

      await expect(
        importDataFromFile(mockAdapter, file, 'source-cek', mockAppEncryption)
      ).rejects.toThrow('CSV file is empty');
    });

    it('should throw error for invalid CSV header', async () => {
      const file = csvToFile('wrong,header,format\ndata,values,here');

      await expect(
        importDataFromFile(mockAdapter, file, 'source-cek', mockAppEncryption)
      ).rejects.toThrow('Invalid CSV header');
    });

    it('should initialize source encryption with provided CEK', async () => {
      const csv = buildCSV([
        {
          tableName: Tables.PROJECTS,
          id: 'proj-1',
          encryptedData: 'encrypted-project-data',
        },
      ]);

      // Mock no existing records
      vi.mocked(mockAdapter.get).mockResolvedValue(null);

      await importDataFromFile(mockAdapter, csvToFile(csv), 'source-cek-value', mockAppEncryption);

      // Should initialize with source CEK
      expect(mockSourceEncryption.initializeWithCEK).toHaveBeenCalledWith('source-cek-value');
    });

    it('should re-encrypt and import data records via batchSave', async () => {
      const csv = buildCSV([
        {
          tableName: Tables.PROJECTS,
          id: 'proj-1',
          encryptedData: 'encrypted-project-data',
        },
      ]);

      // Mock no existing records
      vi.mocked(mockAdapter.get).mockResolvedValue(null);

      const result = await importDataFromFile(
        mockAdapter,
        csvToFile(csv),
        'source-cek',
        mockAppEncryption
      );

      // Should decrypt with source encryption
      expect(mockSourceEncryption.decrypt).toHaveBeenCalledWith('encrypted-project-data');

      // Should re-encrypt with app encryption
      expect(mockAppEncryption.encrypt).toHaveBeenCalledWith('decrypted:encrypted-project-data');

      // Should save via batchSave
      expect(batchSaveTracker.length).toBe(1);
      expect(batchSaveTracker[0].table).toBe(Tables.PROJECTS);
      expect(batchSaveTracker[0].rows[0].id).toBe('proj-1');
      expect(batchSaveTracker[0].rows[0].encryptedData).toBe(
        're-encrypted:decrypted:encrypted-project-data'
      );
      expect(batchSaveTracker[0].skipExisting).toBe(true);

      expect(result.imported).toBe(1);
    });

    it('should handle duplicate IDs via batchSave skipExisting', async () => {
      const csv = buildCSV([
        {
          tableName: Tables.PROJECTS,
          id: 'proj-1',
          encryptedData: 'encrypted-data',
        },
        {
          tableName: Tables.PROJECTS,
          id: 'proj-2',
          encryptedData: 'encrypted-data-2',
        },
      ]);

      // Mock batchSave to report 1 saved, 1 skipped
      vi.mocked(mockAdapter.batchSave).mockResolvedValue({ saved: 1, skipped: 1 });

      const result = await importDataFromFile(
        mockAdapter,
        csvToFile(csv),
        'source-cek',
        mockAppEncryption
      );

      // batchSave with skipExisting=true handles duplicates
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it('should preserve optional fields (timestamp, parentId, unencryptedData)', async () => {
      const csv = buildCSV([
        {
          tableName: Tables.CHATS,
          id: 'chat-1',
          encryptedData: 'encrypted-data',
          timestamp: '2024-01-01T00:00:00Z',
          parentId: 'proj-1',
        },
      ]);

      // Mock no existing records
      vi.mocked(mockAdapter.get).mockResolvedValue(null);

      await importDataFromFile(mockAdapter, csvToFile(csv), 'source-cek', mockAppEncryption);

      // Should save with optional fields via batchSave
      expect(batchSaveTracker.length).toBe(1);
      expect(batchSaveTracker[0].rows[0].timestamp).toBe('2024-01-01T00:00:00Z');
      expect(batchSaveTracker[0].rows[0].parentId).toBe('proj-1');
    });

    it('should handle metadata records without re-encryption', async () => {
      const csv = buildCSV([
        {
          tableName: Tables.METADATA,
          id: 'other-meta',
          encryptedData: '__METADATA__',
          unencryptedData: JSON.stringify({ value: 'meta-value' }),
        },
      ]);

      // Mock no existing records
      vi.mocked(mockAdapter.get).mockResolvedValue(null);

      await importDataFromFile(mockAdapter, csvToFile(csv), 'source-cek', mockAppEncryption);

      // Should not decrypt/re-encrypt __METADATA__ placeholder
      expect(mockSourceEncryption.decrypt).not.toHaveBeenCalled();
      expect(mockAppEncryption.encrypt).not.toHaveBeenCalled();

      // Should save with original encryptedData via batchSave
      expect(batchSaveTracker.length).toBe(1);
      expect(batchSaveTracker[0].rows[0].encryptedData).toBe('__METADATA__');
      expect(batchSaveTracker[0].rows[0].unencryptedData).toBe(
        JSON.stringify({ value: 'meta-value' })
      );
    });

    it('should collect errors and continue import on failure', async () => {
      const csv = buildCSV([
        {
          tableName: Tables.PROJECTS,
          id: 'proj-1',
          encryptedData: 'valid-data',
        },
        {
          tableName: Tables.PROJECTS,
          id: 'proj-2',
          encryptedData: 'invalid-data',
        },
        {
          tableName: Tables.PROJECTS,
          id: 'proj-3',
          encryptedData: 'valid-data-2',
        },
      ]);

      // Mock no existing records
      vi.mocked(mockAdapter.get).mockResolvedValue(null);

      // Mock decrypt to fail for proj-2
      vi.mocked(mockSourceEncryption.decrypt).mockImplementation(async (data: string) => {
        if (data === 'invalid-data') {
          throw new Error('Decryption failed');
        }
        return `decrypted:${data}`;
      });

      const result = await importDataFromFile(
        mockAdapter,
        csvToFile(csv),
        'source-cek',
        mockAppEncryption
      );

      // Should import proj-1 and proj-3, error on proj-2
      expect(result.imported).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('projects/proj-2');
      expect(result.errors[0]).toContain('Decryption failed');
    });

    it('should flush batch on table boundary', async () => {
      const csv = buildCSV([
        {
          tableName: Tables.API_DEFINITIONS,
          id: 'api-1',
          encryptedData: 'api-data',
        },
        {
          tableName: Tables.PROJECTS,
          id: 'proj-1',
          encryptedData: 'project-data',
        },
        {
          tableName: Tables.CHATS,
          id: 'chat-1',
          encryptedData: 'chat-data',
          parentId: 'proj-1',
        },
      ]);

      // Mock no existing records
      vi.mocked(mockAdapter.get).mockResolvedValue(null);

      await importDataFromFile(mockAdapter, csvToFile(csv), 'source-cek', mockAppEncryption);

      // Should have 3 batchSave calls (one per table)
      expect(batchSaveTracker.length).toBe(3);
      expect(batchSaveTracker[0].table).toBe(Tables.API_DEFINITIONS);
      expect(batchSaveTracker[1].table).toBe(Tables.PROJECTS);
      expect(batchSaveTracker[2].table).toBe(Tables.CHATS);
    });

    it('should skip malformed rows with insufficient columns', async () => {
      // Build CSV manually to include malformed row
      const csv = [
        'tableName,id,encryptedData,timestamp,parentId,unencryptedData',
        `${Tables.PROJECTS},proj-1,data`, // Only 3 columns (malformed)
        `${Tables.PROJECTS},proj-2,valid-data,,,`,
      ].join('\n');

      // Mock no existing records
      vi.mocked(mockAdapter.get).mockResolvedValue(null);

      const result = await importDataFromFile(
        mockAdapter,
        csvToFile(csv),
        'source-cek',
        mockAppEncryption
      );

      // Should skip malformed row and import proj-2
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1); // Malformed row is counted as skipped

      // Should only have proj-2 in batchSave
      expect(batchSaveTracker.length).toBe(1);
      expect(batchSaveTracker[0].rows[0].id).toBe('proj-2');
    });

    it('should overwrite api_definition when local has empty credentials', async () => {
      const csv = buildCSV([
        {
          tableName: Tables.API_DEFINITIONS,
          id: 'api-default-1',
          encryptedData: 'imported-api-data',
        },
      ]);

      // Mock existing record with empty credentials
      vi.mocked(mockAdapter.get).mockResolvedValue({
        encryptedData: 'local-encrypted-data',
      });

      // Mock app encryption to decrypt local record with empty credentials
      vi.mocked(mockAppEncryption.decrypt).mockResolvedValue(
        JSON.stringify({ id: 'api-default-1', apiKey: '', baseUrl: '' })
      );

      const result = await importDataFromFile(
        mockAdapter,
        csvToFile(csv),
        'source-cek',
        mockAppEncryption
      );

      // Should import (overwrite) the api_definition
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);

      // Should have batchSave call with the record
      expect(batchSaveTracker.length).toBe(1);
      expect(batchSaveTracker[0].rows[0].id).toBe('api-default-1');
    });

    it('should skip api_definition when local has credentials', async () => {
      const csv = buildCSV([
        {
          tableName: Tables.API_DEFINITIONS,
          id: 'api-with-key',
          encryptedData: 'imported-api-data',
        },
      ]);

      // Mock existing record with credentials
      vi.mocked(mockAdapter.get).mockResolvedValue({
        encryptedData: 'local-encrypted-data',
      });

      // Mock app encryption to decrypt local record with filled credentials
      vi.mocked(mockAppEncryption.decrypt).mockResolvedValue(
        JSON.stringify({ id: 'api-with-key', apiKey: 'sk-xxx', baseUrl: '' })
      );

      const result = await importDataFromFile(
        mockAdapter,
        csvToFile(csv),
        'source-cek',
        mockAppEncryption
      );

      // Should skip the api_definition
      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);

      // Should NOT have batchSave calls
      expect(batchSaveTracker.length).toBe(0);
    });

    it('should skip api_definition when local has baseUrl but no apiKey', async () => {
      const csv = buildCSV([
        {
          tableName: Tables.API_DEFINITIONS,
          id: 'api-with-url',
          encryptedData: 'imported-api-data',
        },
      ]);

      // Mock existing record with baseUrl filled
      vi.mocked(mockAdapter.get).mockResolvedValue({
        encryptedData: 'local-encrypted-data',
      });

      // Mock app encryption to decrypt local record with baseUrl only
      vi.mocked(mockAppEncryption.decrypt).mockResolvedValue(
        JSON.stringify({ id: 'api-with-url', apiKey: '', baseUrl: 'https://custom.api.com' })
      );

      const result = await importDataFromFile(
        mockAdapter,
        csvToFile(csv),
        'source-cek',
        mockAppEncryption
      );

      // Should skip because local has baseUrl
      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);

      // Should NOT have batchSave calls
      expect(batchSaveTracker.length).toBe(0);
    });

    it('should report progress during import', async () => {
      // Generate 100+ records to trigger progress reporting
      const records = [];
      for (let i = 0; i < 120; i++) {
        records.push({
          tableName: Tables.MESSAGES,
          id: `msg-${i}`,
          encryptedData: `data-${i}`,
          parentId: 'chat-1',
        });
      }
      const csv = buildCSV(records);

      // Mock no existing records
      vi.mocked(mockAdapter.get).mockResolvedValue(null);

      const progressCalls: any[] = [];
      await importDataFromFile(
        mockAdapter,
        csvToFile(csv),
        'source-cek',
        mockAppEncryption,
        progress => progressCalls.push({ ...progress })
      );

      // Should have progress reports (every 50 rows) + final
      expect(progressCalls.length).toBeGreaterThan(1);

      // Final progress should match totals
      const finalProgress = progressCalls[progressCalls.length - 1];
      expect(finalProgress.imported).toBe(120);
      expect(finalProgress.skipped).toBe(0);
      expect(finalProgress.errors).toBe(0);
    });

    it('should batch records together before flushing', async () => {
      // Generate more than BATCH_SIZE (100) records
      const records = [];
      for (let i = 0; i < 150; i++) {
        records.push({
          tableName: Tables.MESSAGES,
          id: `msg-${i}`,
          encryptedData: `data-${i}`,
          parentId: 'chat-1',
        });
      }
      const csv = buildCSV(records);

      // Mock no existing records
      vi.mocked(mockAdapter.get).mockResolvedValue(null);

      await importDataFromFile(mockAdapter, csvToFile(csv), 'source-cek', mockAppEncryption);

      // Should have 2 batchSave calls (100 + 50)
      expect(batchSaveTracker.length).toBe(2);
      expect(batchSaveTracker[0].rows.length).toBe(100);
      expect(batchSaveTracker[1].rows.length).toBe(50);
    });
  });
});
