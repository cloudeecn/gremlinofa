/**
 * End-to-end roundtrip test for data export/import
 * Verifies data integrity through the export → import cycle
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { exportDataToCSV } from '../dataExport';
import { importDataFromFile } from '../dataImport';
import type {
  StorageAdapter,
  ExportPage,
  ExportRow,
  BatchSaveRow,
  BatchSaveResult,
} from '../../services/storage/StorageAdapter';
import { Tables } from '../../services/storage/StorageAdapter';
import { EncryptionService } from '../../services/encryption/encryptionService';

// Mock EncryptionService
vi.mock('../../services/encryption/encryptionService');

/**
 * Helper to convert CSV string to File object
 */
function csvToFile(csvContent: string): File {
  return new File([csvContent], 'backup.csv', { type: 'text/csv' });
}

/**
 * Generate mock data for testing
 */
function generateMockData() {
  const data: Record<string, ExportRow[]> = {
    [Tables.METADATA]: [
      {
        id: 'app_version',
        encryptedData: '__METADATA__',
        unencryptedData: JSON.stringify({ value: '1.0.0' }),
      },
      {
        id: 'last_sync',
        encryptedData: '__METADATA__',
        unencryptedData: JSON.stringify({ value: '2024-01-01T00:00:00Z' }),
      },
      {
        id: 'user_prefs',
        encryptedData: '__METADATA__',
        unencryptedData: JSON.stringify({ theme: 'dark', language: 'en' }),
      },
    ],
    [Tables.API_DEFINITIONS]: [
      {
        id: 'api_custom_openai',
        encryptedData: 'encrypted:{"name":"Custom OpenAI","apiKey":"sk-xxx"}',
        timestamp: '2024-01-01T10:00:00Z',
      },
      {
        id: 'api_anthropic',
        encryptedData: 'encrypted:{"name":"Anthropic","apiKey":"sk-ant-xxx"}',
        timestamp: '2024-01-01T11:00:00Z',
      },
      {
        id: 'api_openrouter',
        encryptedData: 'encrypted:{"name":"OpenRouter","apiKey":"sk-or-xxx"}',
        timestamp: '2024-01-01T12:00:00Z',
      },
    ],
    [Tables.PROJECTS]: [
      {
        id: 'proj_1',
        encryptedData: 'encrypted:{"name":"Project Alpha","icon":"🚀"}',
        timestamp: '2024-01-01T10:00:00Z',
      },
      {
        id: 'proj_2',
        encryptedData: 'encrypted:{"name":"Project Beta","icon":"🔬"}',
        timestamp: '2024-01-02T10:00:00Z',
      },
      {
        id: 'proj_3',
        encryptedData: 'encrypted:{"name":"Project Gamma","icon":"📊"}',
        timestamp: '2024-01-03T10:00:00Z',
      },
    ],
    [Tables.CHATS]: [
      {
        id: 'chat_1a',
        encryptedData: 'encrypted:{"title":"Chat 1 in Alpha"}',
        parentId: 'proj_1',
        timestamp: '2024-01-01T11:00:00Z',
      },
      {
        id: 'chat_1b',
        encryptedData: 'encrypted:{"title":"Chat 2 in Alpha"}',
        parentId: 'proj_1',
        timestamp: '2024-01-01T12:00:00Z',
      },
      {
        id: 'chat_2a',
        encryptedData: 'encrypted:{"title":"Chat 1 in Beta"}',
        parentId: 'proj_2',
        timestamp: '2024-01-02T11:00:00Z',
      },
    ],
    [Tables.MESSAGES]: [],
    [Tables.ATTACHMENTS]: [
      {
        id: 'attach_1',
        encryptedData: 'encrypted:base64imagedata1',
        parentId: 'msg_user_1',
        timestamp: '2024-01-01T11:01:00Z',
      },
      {
        id: 'attach_2',
        encryptedData: 'encrypted:base64imagedata2',
        parentId: 'msg_user_50',
        timestamp: '2024-01-01T11:30:00Z',
      },
      {
        id: 'attach_3',
        encryptedData: 'encrypted:base64imagedata3',
        parentId: 'msg_user_100',
        timestamp: '2024-01-01T12:00:00Z',
      },
    ],
  };

  // Generate 210 messages across chats
  for (let i = 0; i < 210; i++) {
    const chatId = i < 100 ? 'chat_1a' : i < 150 ? 'chat_1b' : 'chat_2a';
    const isUser = i % 2 === 0;
    const msgType = isUser ? 'user' : 'assistant';

    data[Tables.MESSAGES].push({
      id: `msg_${msgType}_${i}`,
      encryptedData: `encrypted:{"role":"${msgType}","content":"Message ${i} content with special chars: quotes \\"here\\" and commas, here"}`,
      parentId: chatId,
      timestamp: new Date(2024, 0, 1, 11, Math.floor(i / 60), i % 60).toISOString(),
    });
  }

  return data;
}

describe('Data Export/Import Roundtrip', () => {
  let mockExportAdapter: StorageAdapter;
  let mockImportAdapter: StorageAdapter;
  let mockData: Record<string, ExportRow[]>;
  let mockSourceEncryption: any;
  let mockAppEncryption: any;
  let importedRecords: Map<string, Map<string, ExportRow>>;

  beforeEach(() => {
    mockData = generateMockData();
    importedRecords = new Map();

    // Create mock export adapter with exportPaginated
    mockExportAdapter = {
      initialize: vi.fn(),
      save: vi.fn(),
      get: vi.fn(),
      query: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
      clearAll: vi.fn(),
      exportPaginated: vi.fn().mockImplementation(async (table: string): Promise<ExportPage> => {
        const records = mockData[table] || [];
        return {
          rows: records,
          hasMore: false,
        };
      }),
      batchSave: vi.fn(),
      batchGet: vi.fn(),
    };

    // Create mock import adapter with batchSave
    mockImportAdapter = {
      initialize: vi.fn(),
      save: vi.fn(),
      get: vi.fn().mockImplementation(async (tableName: string, id: string) => {
        const table = importedRecords.get(tableName);
        return table?.get(id) || null;
      }),
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
            tableName: string,
            rows: BatchSaveRow[],
            skipExisting: boolean
          ): Promise<BatchSaveResult> => {
            if (!importedRecords.has(tableName)) {
              importedRecords.set(tableName, new Map());
            }
            const table = importedRecords.get(tableName)!;

            let saved = 0;
            let skipped = 0;

            for (const row of rows) {
              if (skipExisting && table.has(row.id)) {
                skipped++;
              } else {
                table.set(row.id, {
                  id: row.id,
                  encryptedData: row.encryptedData,
                  timestamp: row.timestamp,
                  parentId: row.parentId,
                  unencryptedData: row.unencryptedData,
                });
                saved++;
              }
            }

            return { saved, skipped };
          }
        ),
    };

    // Create mock encryption services (passthrough for same-key scenario)
    mockSourceEncryption = {
      initializeWithCEK: vi.fn().mockResolvedValue(undefined),
      decrypt: vi.fn().mockImplementation(async (data: string) => data),
      encrypt: vi.fn().mockImplementation(async (data: string) => data),
      hasSameKeyAs: vi.fn().mockReturnValue(true), // Same key = no re-encryption
    };

    mockAppEncryption = {
      initializeWithCEK: vi.fn(),
      decrypt: vi.fn().mockImplementation(async (data: string) => data),
      encrypt: vi.fn().mockImplementation(async (data: string) => data),
    };

    // Mock EncryptionService constructor (must use function for 'new' keyword)
    (EncryptionService as any).mockImplementation(function (this: any) {
      return mockSourceEncryption;
    });
  });

  /**
   * Helper to get all records from import adapter
   */
  function getAllRecords(tableName: string): ExportRow[] {
    const table = importedRecords.get(tableName);
    return table ? Array.from(table.values()) : [];
  }

  it('should export and import 210+ records with data integrity preserved', async () => {
    // Step 1: Export all data to CSV
    const csv = await exportDataToCSV(mockExportAdapter);

    // Verify export produced content
    const lines = csv.split('\n');
    expect(lines.length).toBeGreaterThan(210); // Header + all records

    // Verify header
    expect(lines[0]).toBe('tableName,id,encryptedData,timestamp,parentId,unencryptedData');

    // Step 2: Import the CSV into empty database
    const file = csvToFile(csv);
    const result = await importDataFromFile(mockImportAdapter, file, 'test-cek', mockAppEncryption);

    // Calculate expected totals (excluding default API definitions which are filtered on export)
    const expectedTotal =
      mockData[Tables.METADATA].length +
      mockData[Tables.API_DEFINITIONS].length +
      mockData[Tables.PROJECTS].length +
      mockData[Tables.CHATS].length +
      mockData[Tables.MESSAGES].length +
      mockData[Tables.ATTACHMENTS].length;

    expect(result.imported).toBe(expectedTotal);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Step 3: Verify all data was imported correctly
    const importedMetadata = getAllRecords(Tables.METADATA);
    const importedApiDefs = getAllRecords(Tables.API_DEFINITIONS);
    const importedProjects = getAllRecords(Tables.PROJECTS);
    const importedChats = getAllRecords(Tables.CHATS);
    const importedMessages = getAllRecords(Tables.MESSAGES);
    const importedAttachments = getAllRecords(Tables.ATTACHMENTS);

    // Verify record counts
    expect(importedMetadata.length).toBe(mockData[Tables.METADATA].length);
    expect(importedApiDefs.length).toBe(mockData[Tables.API_DEFINITIONS].length);
    expect(importedProjects.length).toBe(mockData[Tables.PROJECTS].length);
    expect(importedChats.length).toBe(mockData[Tables.CHATS].length);
    expect(importedMessages.length).toBe(mockData[Tables.MESSAGES].length);
    expect(importedAttachments.length).toBe(mockData[Tables.ATTACHMENTS].length);

    // Verify specific records match
    const originalProject = mockData[Tables.PROJECTS][0];
    const importedProject = importedProjects.find((p: ExportRow) => p.id === originalProject.id);
    expect(importedProject).toBeDefined();
    expect(importedProject!.encryptedData).toBe(originalProject.encryptedData);
    expect(importedProject!.timestamp).toBe(originalProject.timestamp);

    // Verify message with special characters preserved
    const originalMsg = mockData[Tables.MESSAGES][0];
    const importedMsg = importedMessages.find((m: ExportRow) => m.id === originalMsg.id);
    expect(importedMsg).toBeDefined();
    expect(importedMsg!.encryptedData).toBe(originalMsg.encryptedData);
    expect(importedMsg!.parentId).toBe(originalMsg.parentId);

    // Verify metadata with JSON in unencryptedData preserved
    const originalMeta = mockData[Tables.METADATA][2]; // user_prefs
    const importedMeta = importedMetadata.find((m: ExportRow) => m.id === originalMeta.id);
    expect(importedMeta).toBeDefined();
    expect(importedMeta!.unencryptedData).toBe(originalMeta.unencryptedData);
  });

  it('should handle re-import with duplicate skipping', async () => {
    // Export original data
    const csv = await exportDataToCSV(mockExportAdapter);

    // First import
    const file1 = csvToFile(csv);
    const result1 = await importDataFromFile(
      mockImportAdapter,
      file1,
      'test-cek',
      mockAppEncryption
    );

    const totalRecords = result1.imported;
    expect(totalRecords).toBeGreaterThan(210);

    // Second import of same data - should skip all
    const file2 = csvToFile(csv);
    const result2 = await importDataFromFile(
      mockImportAdapter,
      file2,
      'test-cek',
      mockAppEncryption
    );

    expect(result2.imported).toBe(0);
    expect(result2.skipped).toBe(totalRecords);
    expect(result2.errors).toHaveLength(0);
  });

  it('should correctly count records per table', async () => {
    const csv = await exportDataToCSV(mockExportAdapter);

    // Count records per table in exported CSV
    const lines = csv.split('\n').slice(1); // Skip header
    const tableCounts: Record<string, number> = {};

    for (const line of lines) {
      if (!line.trim()) continue;
      const tableName = line.split(',')[0];
      tableCounts[tableName] = (tableCounts[tableName] || 0) + 1;
    }

    // Verify counts match source data
    expect(tableCounts[Tables.METADATA]).toBe(3);
    expect(tableCounts[Tables.API_DEFINITIONS]).toBe(3);
    expect(tableCounts[Tables.PROJECTS]).toBe(3);
    expect(tableCounts[Tables.CHATS]).toBe(3);
    expect(tableCounts[Tables.MESSAGES]).toBe(210);
    expect(tableCounts[Tables.ATTACHMENTS]).toBe(3);
  });

  it('should preserve CSV special characters through roundtrip', async () => {
    // Add a record with special characters
    mockData[Tables.PROJECTS].push({
      id: 'proj_special',
      encryptedData: 'encrypted:{"name":"Project with, commas and \\"quotes\\""}',
      timestamp: '2024-01-04T10:00:00Z',
    });

    // Export
    const csv = await exportDataToCSV(mockExportAdapter);

    // Import
    const file = csvToFile(csv);
    await importDataFromFile(mockImportAdapter, file, 'test-cek', mockAppEncryption);

    // Verify special characters preserved
    const imported = getAllRecords(Tables.PROJECTS);
    const specialProject = imported.find((p: ExportRow) => p.id === 'proj_special');
    expect(specialProject).toBeDefined();
    expect(specialProject!.encryptedData).toBe(
      'encrypted:{"name":"Project with, commas and \\"quotes\\""}'
    );
  });

  it('should handle empty tables gracefully', async () => {
    // Create data with empty chats and messages
    mockData[Tables.CHATS] = [];
    mockData[Tables.MESSAGES] = [];
    mockData[Tables.ATTACHMENTS] = [];

    const csv = await exportDataToCSV(mockExportAdapter);
    const file = csvToFile(csv);
    const result = await importDataFromFile(mockImportAdapter, file, 'test-cek', mockAppEncryption);

    // Should import only non-empty tables
    const expectedTotal =
      mockData[Tables.METADATA].length +
      mockData[Tables.API_DEFINITIONS].length +
      mockData[Tables.PROJECTS].length;

    expect(result.imported).toBe(expectedTotal);
    expect(result.errors).toHaveLength(0);
  });
});

/**
 * Cross-adapter roundtrip tests
 * Verifies data can be exported from one adapter type and imported to another
 * This tests the full export/import pipeline with realistic adapter behavior
 */
describe('Cross-Adapter Export/Import', () => {
  /**
   * Mock adapter factory that simulates both IndexedDB and Remote behavior
   * Uses the same interface but with different internal storage
   */
  function createMockStorageAdapter(name: string) {
    const storage: Record<string, Map<string, ExportRow>> = {
      [Tables.METADATA]: new Map(),
      [Tables.API_DEFINITIONS]: new Map(),
      [Tables.PROJECTS]: new Map(),
      [Tables.CHATS]: new Map(),
      [Tables.MESSAGES]: new Map(),
      [Tables.ATTACHMENTS]: new Map(),
    };

    return {
      name,
      initialize: vi.fn(),
      save: vi
        .fn()
        .mockImplementation(
          async (
            table: string,
            id: string,
            encryptedData: string,
            metadata: { timestamp?: string; parentId?: string; unencryptedData?: string }
          ) => {
            if (!storage[table]) storage[table] = new Map();
            storage[table].set(id, {
              id,
              encryptedData,
              timestamp: metadata.timestamp,
              parentId: metadata.parentId,
              unencryptedData: metadata.unencryptedData,
            });
          }
        ),
      get: vi.fn().mockImplementation(async (table: string, id: string) => {
        const record = storage[table]?.get(id);
        if (!record) return null;
        return {
          encryptedData: record.encryptedData,
          unencryptedData: record.unencryptedData,
        };
      }),
      query: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
      clearAll: vi.fn().mockImplementation(async () => {
        Object.values(storage).forEach(table => table.clear());
      }),
      exportPaginated: vi.fn().mockImplementation(async (table: string, afterId?: string) => {
        const tableMap = storage[table];
        if (!tableMap) return { rows: [], hasMore: false };

        // Sort records by ID and apply cursor
        let rows = Array.from(tableMap.values()).sort((a, b) => a.id.localeCompare(b.id));

        if (afterId) {
          const idx = rows.findIndex(r => r.id === afterId);
          rows = idx >= 0 ? rows.slice(idx + 1) : rows.filter(r => r.id > afterId);
        }

        // Simulate pagination with 50 records per page for testing
        const PAGE_SIZE = 50;
        const hasMore = rows.length > PAGE_SIZE;
        return {
          rows: rows.slice(0, PAGE_SIZE),
          hasMore,
        };
      }),
      batchSave: vi
        .fn()
        .mockImplementation(
          async (
            table: string,
            rows: BatchSaveRow[],
            skipExisting: boolean
          ): Promise<BatchSaveResult> => {
            if (!storage[table]) storage[table] = new Map();
            const tableMap = storage[table];

            let saved = 0;
            let skipped = 0;

            for (const row of rows) {
              if (skipExisting && tableMap.has(row.id)) {
                skipped++;
              } else {
                tableMap.set(row.id, {
                  id: row.id,
                  encryptedData: row.encryptedData,
                  timestamp: row.timestamp,
                  parentId: row.parentId,
                  unencryptedData: row.unencryptedData,
                });
                saved++;
              }
            }

            return { saved, skipped };
          }
        ),
      batchGet: vi.fn().mockResolvedValue({ rows: [] }),
      // Expose internal storage for test verification
      _getStorage: () => storage,
      _getRecordCount: () => {
        let count = 0;
        Object.values(storage).forEach(table => {
          count += table.size;
        });
        return count;
      },
    } as StorageAdapter & {
      name: string;
      _getStorage: () => Record<string, Map<string, ExportRow>>;
      _getRecordCount: () => number;
    };
  }

  /**
   * Seed an adapter with test data
   */
  async function seedTestData(adapter: ReturnType<typeof createMockStorageAdapter>) {
    const testData: Record<string, ExportRow[]> = {
      [Tables.METADATA]: [
        { id: 'app_version', encryptedData: '__METADATA__', unencryptedData: '{"value":"2.0.0"}' },
      ],
      [Tables.API_DEFINITIONS]: [
        {
          id: 'api_custom_test',
          encryptedData: 'encrypted:{"name":"Test API","apiKey":"test-key"}',
          timestamp: '2024-01-01T10:00:00Z',
        },
      ],
      [Tables.PROJECTS]: [
        {
          id: 'proj_1',
          encryptedData: 'encrypted:{"name":"Project One","icon":"🎯"}',
          timestamp: '2024-01-01T10:00:00Z',
        },
        {
          id: 'proj_2',
          encryptedData: 'encrypted:{"name":"Project Two","icon":"🔥"}',
          timestamp: '2024-01-02T10:00:00Z',
        },
      ],
      [Tables.CHATS]: [
        {
          id: 'chat_1',
          encryptedData: 'encrypted:{"title":"Chat One"}',
          parentId: 'proj_1',
          timestamp: '2024-01-01T11:00:00Z',
        },
        {
          id: 'chat_2',
          encryptedData: 'encrypted:{"title":"Chat Two"}',
          parentId: 'proj_2',
          timestamp: '2024-01-02T11:00:00Z',
        },
      ],
      [Tables.MESSAGES]: [],
      [Tables.ATTACHMENTS]: [
        {
          id: 'attach_1',
          encryptedData: 'encrypted:base64data',
          parentId: 'msg_user_0',
          timestamp: '2024-01-01T11:01:00Z',
        },
      ],
    };

    // Generate 100 messages for a more realistic test
    for (let i = 0; i < 100; i++) {
      const chatId = i < 50 ? 'chat_1' : 'chat_2';
      const role = i % 2 === 0 ? 'user' : 'assistant';
      testData[Tables.MESSAGES].push({
        id: `msg_${role}_${i}`,
        encryptedData: `encrypted:{"role":"${role}","content":"Message ${i}"}`,
        parentId: chatId,
        timestamp: new Date(2024, 0, 1, 11, Math.floor(i / 60), i % 60).toISOString(),
      });
    }

    // Seed data into adapter
    for (const [table, records] of Object.entries(testData)) {
      for (const record of records) {
        await adapter.save(table, record.id, record.encryptedData, {
          timestamp: record.timestamp,
          parentId: record.parentId,
          unencryptedData: record.unencryptedData,
        });
      }
    }

    return testData;
  }

  let mockSourceEncryption: any;
  let mockAppEncryption: any;

  beforeEach(() => {
    // Create mock encryption services (passthrough for testing)
    mockSourceEncryption = {
      initializeWithCEK: vi.fn().mockResolvedValue(undefined),
      decrypt: vi.fn().mockImplementation(async (data: string) => data),
      encrypt: vi.fn().mockImplementation(async (data: string) => data),
      hasSameKeyAs: vi.fn().mockReturnValue(true),
    };

    mockAppEncryption = {
      initializeWithCEK: vi.fn(),
      decrypt: vi.fn().mockImplementation(async (data: string) => data),
      encrypt: vi.fn().mockImplementation(async (data: string) => data),
    };

    (EncryptionService as any).mockImplementation(function (this: any) {
      return mockSourceEncryption;
    });
  });

  it('should export from "IndexedDB" and import to "RemoteStorage"', async () => {
    // Create two mock adapters simulating different storage backends
    const indexedDBAdapter = createMockStorageAdapter('IndexedDB');
    const remoteAdapter = createMockStorageAdapter('RemoteStorage');

    // Seed IndexedDB with test data
    const originalData = await seedTestData(indexedDBAdapter);

    // Calculate expected record count
    const expectedCount = Object.values(originalData).reduce((sum, arr) => sum + arr.length, 0);

    // Export from IndexedDB
    const csv = await exportDataToCSV(indexedDBAdapter);

    // Import to RemoteStorage
    const file = csvToFile(csv);
    const result = await importDataFromFile(remoteAdapter, file, 'test-cek', mockAppEncryption);

    // Verify import succeeded
    expect(result.imported).toBe(expectedCount);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify data integrity - compare records
    const remoteStorage = remoteAdapter._getStorage();

    // Check projects
    expect(remoteStorage[Tables.PROJECTS].size).toBe(2);
    const proj1 = remoteStorage[Tables.PROJECTS].get('proj_1');
    expect(proj1?.encryptedData).toBe('encrypted:{"name":"Project One","icon":"🎯"}');

    // Check messages
    expect(remoteStorage[Tables.MESSAGES].size).toBe(100);

    // Check attachments
    expect(remoteStorage[Tables.ATTACHMENTS].size).toBe(1);
  });

  it('should export from "RemoteStorage" and import to "IndexedDB"', async () => {
    // Create two mock adapters
    const remoteAdapter = createMockStorageAdapter('RemoteStorage');
    const indexedDBAdapter = createMockStorageAdapter('IndexedDB');

    // Seed RemoteStorage with test data
    const originalData = await seedTestData(remoteAdapter);
    const expectedCount = Object.values(originalData).reduce((sum, arr) => sum + arr.length, 0);

    // Export from RemoteStorage
    const csv = await exportDataToCSV(remoteAdapter);

    // Import to IndexedDB
    const file = csvToFile(csv);
    const result = await importDataFromFile(indexedDBAdapter, file, 'test-cek', mockAppEncryption);

    // Verify import succeeded
    expect(result.imported).toBe(expectedCount);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify data integrity
    const indexedDBStorage = indexedDBAdapter._getStorage();
    expect(indexedDBStorage[Tables.PROJECTS].size).toBe(2);
    expect(indexedDBStorage[Tables.MESSAGES].size).toBe(100);
    expect(indexedDBStorage[Tables.CHATS].size).toBe(2);
  });

  it('should handle bidirectional sync scenario', async () => {
    // Scenario: Export from IndexedDB → RemoteStorage → Back to new IndexedDB
    const sourceAdapter = createMockStorageAdapter('Source');
    const middleAdapter = createMockStorageAdapter('Middle');
    const targetAdapter = createMockStorageAdapter('Target');

    // Seed source with data
    const originalData = await seedTestData(sourceAdapter);
    const expectedCount = Object.values(originalData).reduce((sum, arr) => sum + arr.length, 0);

    // Step 1: Export from source, import to middle
    const csv1 = await exportDataToCSV(sourceAdapter);
    const file1 = csvToFile(csv1);
    await importDataFromFile(middleAdapter, file1, 'test-cek', mockAppEncryption);

    // Step 2: Export from middle, import to target
    const csv2 = await exportDataToCSV(middleAdapter);
    const file2 = csvToFile(csv2);
    const result = await importDataFromFile(targetAdapter, file2, 'test-cek', mockAppEncryption);

    // Verify final state matches original
    expect(result.imported).toBe(expectedCount);

    // Deep compare specific records
    const sourceStorage = sourceAdapter._getStorage();
    const targetStorage = targetAdapter._getStorage();

    for (const table of Object.keys(sourceStorage)) {
      expect(targetStorage[table].size).toBe(sourceStorage[table].size);

      for (const [id, sourceRecord] of sourceStorage[table]) {
        const targetRecord = targetStorage[table].get(id);
        expect(targetRecord).toBeDefined();
        expect(targetRecord?.encryptedData).toBe(sourceRecord.encryptedData);
        expect(targetRecord?.timestamp).toBe(sourceRecord.timestamp);
        expect(targetRecord?.parentId).toBe(sourceRecord.parentId);
        expect(targetRecord?.unencryptedData).toBe(sourceRecord.unencryptedData);
      }
    }
  });

  it('should handle pagination correctly during cross-adapter export', async () => {
    // Create adapters with larger dataset to trigger pagination
    const sourceAdapter = createMockStorageAdapter('Source');
    const targetAdapter = createMockStorageAdapter('Target');

    // Seed with 150 messages (exceeds the mock's 50-per-page limit)
    const storage = sourceAdapter._getStorage();
    for (let i = 0; i < 150; i++) {
      storage[Tables.MESSAGES].set(`msg_${String(i).padStart(5, '0')}`, {
        id: `msg_${String(i).padStart(5, '0')}`,
        encryptedData: `encrypted:message-${i}`,
        parentId: 'chat_1',
        timestamp: new Date(2024, 0, 1, 11, 0, i).toISOString(),
      });
    }

    // Export (should internally handle pagination)
    const csv = await exportDataToCSV(sourceAdapter);

    // Verify CSV contains all records
    const lines = csv.split('\n');
    const messageLines = lines.filter(line => line.startsWith('messages,'));
    expect(messageLines.length).toBe(150);

    // Import to target
    const file = csvToFile(csv);
    const result = await importDataFromFile(targetAdapter, file, 'test-cek', mockAppEncryption);

    expect(result.imported).toBe(150);
    expect(targetAdapter._getStorage()[Tables.MESSAGES].size).toBe(150);
  });

  it('should preserve data integrity with special characters in cross-adapter transfer', async () => {
    const sourceAdapter = createMockStorageAdapter('Source');
    const targetAdapter = createMockStorageAdapter('Target');

    // Add records with special characters that could break CSV
    const storage = sourceAdapter._getStorage();
    storage[Tables.PROJECTS].set('proj_special', {
      id: 'proj_special',
      encryptedData:
        'encrypted:{"name":"Test with, comma and \\"quotes\\"","desc":"Line1\\nLine2"}',
      timestamp: '2024-01-01T10:00:00Z',
    });
    storage[Tables.METADATA].set('meta_special', {
      id: 'meta_special',
      encryptedData: '__METADATA__',
      unencryptedData: '{"json":"with,comma","nested":{"key":"value\\"quoted\\""}}',
    });

    // Export and import
    const csv = await exportDataToCSV(sourceAdapter);
    const file = csvToFile(csv);
    await importDataFromFile(targetAdapter, file, 'test-cek', mockAppEncryption);

    // Verify special characters preserved
    const targetStorage = targetAdapter._getStorage();
    const proj = targetStorage[Tables.PROJECTS].get('proj_special');
    expect(proj?.encryptedData).toBe(
      'encrypted:{"name":"Test with, comma and \\"quotes\\"","desc":"Line1\\nLine2"}'
    );

    const meta = targetStorage[Tables.METADATA].get('meta_special');
    expect(meta?.unencryptedData).toBe(
      '{"json":"with,comma","nested":{"key":"value\\"quoted\\""}}'
    );
  });
});
