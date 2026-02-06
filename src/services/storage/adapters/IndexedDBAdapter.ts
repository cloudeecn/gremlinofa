/**
 * IndexedDB Storage Adapter for Web and Android
 * Stores encrypted data in IndexedDB (encryption handled by encryptionService)
 */

import type {
  BatchGetResult,
  BatchSaveResult,
  BatchSaveRow,
  ColumnName,
  ExportPage,
  ExportRow,
  PartialExportRow,
  QueryFilters,
  RecordMetadata,
  StorageAdapter,
} from '../StorageAdapter';
import { Tables } from '../StorageAdapter';

interface StoredRecord {
  id: string;
  encryptedData: string;
  timestamp?: string;
  parentId?: string;
  unencryptedData?: string;
}

/**
 * Filter a record to only include specified columns
 * Returns full record if columns is undefined/empty
 */
function filterColumns(row: ExportRow, columns?: ColumnName[]): PartialExportRow {
  if (!columns || columns.length === 0) {
    return row;
  }

  const result: PartialExportRow = {};
  for (const col of columns) {
    if (col in row) {
      result[col] = row[col];
    }
  }
  return result;
}

function persistStorage() {
  navigator.storage?.persisted().then(persisted => {
    if (!persisted) {
      navigator.storage
        .persist()
        ?.then(isSuccess => {
          if (!isSuccess) console.warn('Unable to mark storage as persistant.');
        })
        .catch(e => {
          console.warn('Unable to mark storage as persistant.', e);
        });
    }
  });
}

export class IndexedDBAdapter implements StorageAdapter {
  private db: IDBDatabase | null = null;
  private readonly DB_NAME = 'chatbot';
  private readonly DB_VERSION = 6;

  async initialize(): Promise<void> {
    // Open IndexedDB
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      request.onerror = () => {
        reject(new Error('Failed to open IndexedDB'));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = event => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create object stores for each table
        const tables = [
          Tables.API_DEFINITIONS,
          Tables.MODELS_CACHE,
          Tables.PROJECTS,
          Tables.CHATS,
          Tables.MINION_CHATS,
          Tables.MESSAGES,
          Tables.ATTACHMENTS,
          Tables.METADATA,
          Tables.MEMORIES,
          Tables.MEMORY_JOURNALS,
          Tables.VFS_META,
          Tables.VFS_FILES,
          Tables.VFS_VERSIONS,
        ];

        for (const table of tables) {
          if (!db.objectStoreNames.contains(table)) {
            const store = db.createObjectStore(table, { keyPath: 'id' });

            // Create indexes for efficient querying
            store.createIndex('timestamp', 'timestamp', { unique: false });
            store.createIndex('parentId', 'parentId', { unique: false });

            // Composite indexes for common queries
            store.createIndex('parentId_timestamp', ['parentId', 'timestamp'], {
              unique: false,
            });
          }
        }
      };
    });
  }

  async save(
    table: string,
    id: string,
    encryptedData: string,
    metadata: RecordMetadata
  ): Promise<void> {
    if (!this.db) {
      throw new Error('IndexedDB not initialized');
    }

    persistStorage();

    const record: StoredRecord = {
      id,
      encryptedData,
      timestamp: metadata.timestamp,
      parentId: metadata.parentId,
      unencryptedData: metadata.unencryptedData,
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(table, 'readwrite');
      const store = transaction.objectStore(table);
      const request = store.put(record);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error(`Failed to save record: ${id}`));
    });
  }

  async get(
    table: string,
    id: string
  ): Promise<{ encryptedData: string; timestamp?: string; unencryptedData?: string } | null> {
    if (!this.db) {
      throw new Error('IndexedDB not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(table, 'readonly');
      const store = transaction.objectStore(table);
      const request = store.get(id);

      request.onsuccess = () => {
        const record = request.result as StoredRecord | undefined;
        if (!record) {
          resolve(null);
        } else {
          resolve({
            encryptedData: record.encryptedData,
            timestamp: record.timestamp,
            unencryptedData: record.unencryptedData,
          });
        }
      };

      request.onerror = () => reject(new Error(`Failed to get record: ${id}`));
    });
  }

  async query(
    table: string,
    filters?: QueryFilters
  ): Promise<Array<{ encryptedData: string; unencryptedData?: string }>> {
    if (!this.db) {
      throw new Error('IndexedDB not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(table, 'readonly');
      const store = transaction.objectStore(table);

      let request: IDBRequest;

      // Use appropriate index based on filters
      if (filters?.parentId) {
        const index = store.index('parentId_timestamp');
        // Use bound() to match all records with this parentId regardless of timestamp
        const range = IDBKeyRange.bound(
          [filters.parentId, ''], // Lower bound: parentId with min timestamp
          [filters.parentId, '\uffff'], // Upper bound: parentId with max timestamp
          false,
          false
        );
        request = index.openCursor(range, filters.orderDirection === 'asc' ? 'next' : 'prev');
      } else if (filters?.orderBy === 'timestamp') {
        const index = store.index('timestamp');
        request = index.openCursor(null, filters.orderDirection === 'asc' ? 'next' : 'prev');
      } else {
        request = store.openCursor();
      }

      const results: Array<{ encryptedData: string; unencryptedData?: string }> = [];

      request.onsuccess = event => {
        const cursor = (event.target as IDBRequest).result as IDBCursorWithValue | null;

        if (cursor) {
          const record = cursor.value as StoredRecord;

          results.push({
            encryptedData: record.encryptedData,
            unencryptedData: record.unencryptedData,
          });
          cursor.continue();
        } else {
          resolve(results);
        }
      };

      request.onerror = () => reject(new Error(`Failed to query records in ${table}`));
    });
  }

  async delete(table: string, id: string): Promise<void> {
    if (!this.db) {
      throw new Error('IndexedDB not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(table, 'readwrite');
      const store = transaction.objectStore(table);
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error(`Failed to delete record: ${id}`));
    });
  }

  async deleteMany(table: string, filters: QueryFilters): Promise<void> {
    if (!this.db) {
      throw new Error('IndexedDB not initialized');
    }

    // Get all matching IDs first
    const ids = await this.queryIds(table, filters);

    // Delete each record
    const promises = ids.map(id => this.delete(table, id));
    await Promise.all(promises);
  }

  async count(table: string, filters?: QueryFilters): Promise<number> {
    if (!this.db) {
      throw new Error('IndexedDB not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(table, 'readonly');
      const store = transaction.objectStore(table);

      let request: IDBRequest;

      if (filters?.parentId) {
        const index = store.index('parentId');
        const range = IDBKeyRange.only(filters.parentId);
        request = index.count(range);
      } else {
        request = store.count();
      }

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(`Failed to count records in ${table}`));
    });
  }

  /**
   * Helper method to get IDs matching filters
   */
  private async queryIds(table: string, filters?: QueryFilters): Promise<string[]> {
    if (!this.db) {
      throw new Error('IndexedDB not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(table, 'readonly');
      const store = transaction.objectStore(table);

      let request: IDBRequest;

      if (filters?.parentId) {
        const index = store.index('parentId');
        const range = IDBKeyRange.only(filters.parentId);
        request = index.openKeyCursor(range);
      } else {
        request = store.openKeyCursor();
      }

      const ids: string[] = [];

      request.onsuccess = event => {
        const cursor = (event.target as IDBRequest).result as IDBCursor | null;

        if (cursor) {
          ids.push(cursor.key as string);
          cursor.continue();
        } else {
          resolve(ids);
        }
      };

      request.onerror = () => reject(new Error(`Failed to query IDs in ${table}`));
    });
  }

  /**
   * Clear all data (for testing/reset)
   */
  async clearAll(): Promise<void> {
    if (!this.db) {
      throw new Error('IndexedDB not initialized');
    }

    const tables = [
      Tables.API_DEFINITIONS,
      Tables.MODELS_CACHE,
      Tables.PROJECTS,
      Tables.CHATS,
      Tables.MESSAGES,
      Tables.ATTACHMENTS,
      Tables.METADATA,
      Tables.MEMORIES,
      Tables.MEMORY_JOURNALS,
    ];

    const promises = tables.map(
      table =>
        new Promise<void>((resolve, reject) => {
          const transaction = this.db!.transaction(table, 'readwrite');
          const store = transaction.objectStore(table);
          const request = store.clear();

          request.onsuccess = () => resolve();
          request.onerror = () => reject(new Error(`Failed to clear ${table}`));
        })
    );

    await Promise.all(promises);
  }

  /** Row limit per page (match remote backend) */
  private static EXPORT_ROW_LIMIT = 200;
  /** Size limit per page in characters (match remote backend) */
  private static EXPORT_SIZE_LIMIT = 20_000_000;

  /**
   * Export records with cursor-based pagination
   * Uses IDBKeyRange.lowerBound for efficient cursor positioning
   * When columns is provided, filters results to only include those columns
   */
  async exportPaginated(
    table: string,
    afterId?: string,
    columns?: ColumnName[]
  ): Promise<ExportPage> {
    if (!this.db) {
      throw new Error('IndexedDB not initialized');
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(table, 'readonly');
      const store = transaction.objectStore(table);

      // Use IDBKeyRange.lowerBound for cursor positioning (exclusive)
      const range = afterId ? IDBKeyRange.lowerBound(afterId, true) : undefined;
      const request = store.openCursor(range);

      const rows: PartialExportRow[] = [];
      let totalSize = 0;

      request.onsuccess = event => {
        const cursor = (event.target as IDBRequest).result as IDBCursorWithValue | null;

        if (cursor) {
          // Check row limit
          if (rows.length >= IndexedDBAdapter.EXPORT_ROW_LIMIT) {
            resolve({ rows: rows as ExportRow[], hasMore: true });
            return;
          }

          const record = cursor.value as StoredRecord;

          // Calculate row size (based on full record for consistent pagination)
          const rowSize =
            record.id.length +
            record.encryptedData.length +
            (record.unencryptedData?.length ?? 0) +
            (record.timestamp?.length ?? 0) +
            (record.parentId?.length ?? 0);

          // Check size limit (allow at least one row)
          if (rows.length > 0 && totalSize + rowSize > IndexedDBAdapter.EXPORT_SIZE_LIMIT) {
            resolve({ rows: rows as ExportRow[], hasMore: true });
            return;
          }

          totalSize += rowSize;

          const fullRow: ExportRow = {
            id: record.id,
            encryptedData: record.encryptedData,
            timestamp: record.timestamp,
            parentId: record.parentId,
            unencryptedData: record.unencryptedData,
          };

          rows.push(filterColumns(fullRow, columns));

          cursor.continue();
        } else {
          // Cursor exhausted
          resolve({ rows: rows as ExportRow[], hasMore: false });
        }
      };

      request.onerror = () => reject(new Error(`Failed to export records from ${table}`));
    });
  }

  /**
   * Batch save multiple records in a single transaction
   * Uses bulk put operations for efficiency
   */
  async batchSave(
    table: string,
    rows: BatchSaveRow[],
    skipExisting: boolean
  ): Promise<BatchSaveResult> {
    if (!this.db) {
      throw new Error('IndexedDB not initialized');
    }

    persistStorage();

    if (rows.length === 0) {
      return { saved: 0, skipped: 0 };
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(table, 'readwrite');
      const store = transaction.objectStore(table);

      let saved = 0;
      let skipped = 0;
      let pending = rows.length;

      const checkComplete = () => {
        if (pending === 0) {
          resolve({ saved, skipped });
        }
      };

      for (const row of rows) {
        if (skipExisting) {
          // Check existence first
          const getRequest = store.get(row.id);
          getRequest.onsuccess = () => {
            if (getRequest.result) {
              // Record exists, skip
              skipped++;
              pending--;
              checkComplete();
            } else {
              // Record doesn't exist, insert
              const putRequest = store.put({
                id: row.id,
                encryptedData: row.encryptedData,
                timestamp: row.timestamp,
                parentId: row.parentId,
                unencryptedData: row.unencryptedData,
              });
              putRequest.onsuccess = () => {
                saved++;
                pending--;
                checkComplete();
              };
              putRequest.onerror = () => {
                pending--;
                checkComplete();
              };
            }
          };
          getRequest.onerror = () => {
            pending--;
            checkComplete();
          };
        } else {
          // Upsert mode - just put
          const putRequest = store.put({
            id: row.id,
            encryptedData: row.encryptedData,
            timestamp: row.timestamp,
            parentId: row.parentId,
            unencryptedData: row.unencryptedData,
          });
          putRequest.onsuccess = () => {
            saved++;
            pending--;
            checkComplete();
          };
          putRequest.onerror = () => {
            pending--;
            checkComplete();
          };
        }
      }

      transaction.onerror = () => reject(new Error(`Failed to batch save to ${table}`));
    });
  }

  /**
   * Batch get multiple records by IDs
   * Uses individual get() calls within a single transaction (idiomatic IndexedDB pattern)
   * When columns is provided, filters results to only include those columns
   */
  async batchGet(table: string, ids: string[], columns?: ColumnName[]): Promise<BatchGetResult> {
    if (!this.db) {
      throw new Error('IndexedDB not initialized');
    }

    if (ids.length === 0) {
      return { rows: [] };
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(table, 'readonly');
      const store = transaction.objectStore(table);

      const rows: PartialExportRow[] = [];
      let pending = ids.length;

      const checkComplete = () => {
        if (pending === 0) {
          resolve({ rows });
        }
      };

      for (const id of ids) {
        const request = store.get(id);
        request.onsuccess = () => {
          const record = request.result as StoredRecord | undefined;
          if (record) {
            const fullRow: ExportRow = {
              id: record.id,
              encryptedData: record.encryptedData,
              timestamp: record.timestamp,
              parentId: record.parentId,
              unencryptedData: record.unencryptedData,
            };
            rows.push(filterColumns(fullRow, columns));
          }
          // Missing IDs are silently ignored (per interface spec)
          pending--;
          checkComplete();
        };
        request.onerror = () => {
          pending--;
          checkComplete();
        };
      }

      transaction.onerror = () => reject(new Error(`Failed to batch get from ${table}`));
    });
  }

  /**
   * Get storage quota information using the Storage API
   * Returns usage and quota in bytes, or null if the API is unavailable
   */
  async getStorageQuota(): Promise<{ usage: number; quota: number } | null> {
    const estimate = (await navigator?.storage?.estimate()) ?? null;

    return {
      usage: estimate.usage ?? NaN,
      quota: estimate.quota ?? NaN,
    };
  }
}
