/**
 * Data Export Utility
 * Exports all database tables to CSV format using streaming via exportPaginated()
 */

import type { EncryptionService } from '../services/encryption/encryptionService';
import type { StorageAdapter, ExportRow } from '../services/storage/StorageAdapter';
import { Tables } from '../services/storage/StorageAdapter';
import { buildCSVLine } from './csvHelper';

/**
 * Table order for export (metadata first for import compatibility)
 */
const EXPORT_TABLES = [
  Tables.METADATA,
  Tables.API_DEFINITIONS,
  Tables.PROJECTS,
  Tables.CHATS,
  Tables.MINION_CHATS,
  Tables.MESSAGES,
  Tables.ATTACHMENTS,
  Tables.MEMORIES,
];

/**
 * Check if a default API definition has credentials filled
 */
async function hasDefaultApiCredentials(
  encryptedData: string,
  encryptionService: EncryptionService
): Promise<boolean> {
  try {
    const decrypted = await encryptionService.decrypt(encryptedData);
    const apiDef = JSON.parse(decrypted);
    // Include if apiKey OR baseUrl has a non-default value
    // xAI default baseUrl is 'https://api.x.ai/v1', others are empty
    const hasApiKey = !!apiDef.apiKey;
    const hasCustomBaseUrl =
      !!apiDef.baseUrl && apiDef.baseUrl !== '' && apiDef.baseUrl !== 'https://api.x.ai/v1';
    return hasApiKey || hasCustomBaseUrl;
  } catch {
    // If decryption fails, skip the record
    return false;
  }
}

/**
 * Async generator that streams CSV lines from the database
 * Uses adapter.exportPaginated() for unified streaming from any adapter type
 * Memory footprint: ~1 page of records at a time
 *
 * @param adapter - Storage adapter (IndexedDBAdapter or RemoteStorageAdapter)
 * @param encryptionService - Optional encryption service to include default API definitions with credentials
 * @yields CSV lines (including newline character)
 */
export async function* streamExportCSVLines(
  adapter: StorageAdapter,
  encryptionService?: EncryptionService
): AsyncGenerator<string, void, unknown> {
  console.debug('[DataExport] Starting streaming data export...');

  // Yield CSV header
  yield buildCSVLine([
    'tableName',
    'id',
    'encryptedData',
    'timestamp',
    'parentId',
    'unencryptedData',
  ]) + '\n';

  // Stream records from each table using exportPaginated()
  for (const table of EXPORT_TABLES) {
    console.debug(`[DataExport] Streaming table: ${table}`);
    let count = 0;
    let afterId: string | undefined;

    // Paginate through all records in this table
    do {
      const page = await adapter.exportPaginated(table, afterId);

      for (const record of page.rows) {
        // For default API definitions, only include if they have credentials
        if (table === Tables.API_DEFINITIONS && record.id.startsWith('api_default')) {
          // Skip if no encryption service provided (legacy behavior)
          if (!encryptionService) {
            continue;
          }
          // Check if this default has credentials filled
          const hasCredentials = await hasDefaultApiCredentials(
            record.encryptedData,
            encryptionService
          );
          if (!hasCredentials) {
            console.debug(
              `[DataExport] Skipping default API definition without credentials: ${record.id}`
            );
            continue;
          }
          console.debug(
            `[DataExport] Including default API definition with credentials: ${record.id}`
          );
        }

        const line = buildCSVLine([
          table,
          record.id || '',
          record.encryptedData || '',
          record.timestamp || '',
          record.parentId || '',
          record.unencryptedData || '',
        ]);

        yield line + '\n';
        count++;
      }

      // Update cursor for next page
      afterId = page.rows.at(-1)?.id;

      // Continue if there are more pages
      if (!page.hasMore) {
        break;
      }
    } while (true);

    console.debug(`[DataExport] Exported ${count} records from ${table}`);
  }

  console.debug('[DataExport] Streaming export complete!');
}

/**
 * Legacy: Export all data to CSV format (non-streaming)
 * Kept for backwards compatibility with existing tests
 * For large databases, use streamExportCSVLines() instead
 *
 * @param adapter - Storage adapter for direct database access
 * @param encryptionService - Optional encryption service to include default API definitions with credentials
 * @returns CSV string with all data
 */
export async function exportDataToCSV(
  adapter: StorageAdapter,
  encryptionService?: EncryptionService
): Promise<string> {
  const lines: string[] = [];

  for await (const line of streamExportCSVLines(adapter, encryptionService)) {
    lines.push(line);
  }

  // Join without extra newlines since each line already has \n
  // Trim trailing newline for backward compatibility with tests
  return lines.join('').replace(/\n$/, '');
}

/**
 * Progress callback for streaming export
 */
export type ExportProgressCallback = (count: number) => void;

/**
 * Create a Blob from streaming export with chunked assembly
 * Memory-efficient: accumulates small chunks instead of one giant array
 *
 * @param adapter - Storage adapter
 * @param encryptionService - Optional encryption service to include default API definitions with credentials
 * @param chunkSize - Number of lines per chunk (default: 100)
 * @param onProgress - Optional progress callback (called with record count)
 * @returns Blob containing the CSV data
 */
export async function createExportBlob(
  adapter: StorageAdapter,
  encryptionService?: EncryptionService,
  chunkSize: number = 100,
  onProgress?: ExportProgressCallback
): Promise<Blob> {
  const chunks: Blob[] = [];
  let currentChunk: string[] = [];
  let recordCount = 0;

  for await (const line of streamExportCSVLines(adapter, encryptionService)) {
    currentChunk.push(line);
    recordCount++;

    // Report progress (skip header line)
    if (onProgress && recordCount > 1) {
      onProgress(recordCount - 1); // -1 to exclude header
    }

    if (currentChunk.length >= chunkSize) {
      // Create a blob from current chunk and let the strings be GC'd
      chunks.push(new Blob(currentChunk, { type: 'text/plain' }));
      currentChunk = [];
    }
  }

  // Handle remaining lines
  if (currentChunk.length > 0) {
    chunks.push(new Blob(currentChunk, { type: 'text/plain' }));
  }

  // Combine all chunks into final blob
  // This is a metadata operation - doesn't copy all data into memory
  return new Blob(chunks, { type: 'text/csv;charset=utf-8;' });
}

// Re-export ExportRow type for consumers that need it
export type { ExportRow };
