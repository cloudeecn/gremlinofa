/**
 * Data Import Utility
 * Imports data from CSV format with re-encryption
 * Uses streaming to support large files on memory-constrained devices (iOS)
 * Uses batch operations for faster imports
 */

import { EncryptionService } from '../services/encryption/encryptionService';
import type { StorageAdapter, BatchSaveRow } from '../services/storage/StorageAdapter';
import { Tables } from '../services/storage/StorageAdapter';
import { streamCSVRows } from './csvHelper';

interface ImportRecord {
  tableName: string;
  id: string;
  encryptedData: string;
  timestamp?: string;
  parentId?: string;
  unencryptedData?: string;
}

/**
 * Progress callback for streaming import
 */
export interface ImportProgress {
  processed: number;
  imported: number;
  skipped: number;
  errors: number;
  /** Estimated total (may be undefined if unknown) */
  estimatedTotal?: number;
}

export type ImportProgressCallback = (progress: ImportProgress) => void;

/**
 * Expected CSV header for validation
 */
const EXPECTED_HEADER = [
  'tableName',
  'id',
  'encryptedData',
  'timestamp',
  'parentId',
  'unencryptedData',
];

/**
 * Batch size for import operations
 * Records are accumulated and saved in batches for better performance
 */
const BATCH_SIZE = 100;

/**
 * Parse a CSV row into an ImportRecord
 */
function parseRow(row: string[]): ImportRecord | null {
  if (row.length < 6) {
    return null;
  }

  return {
    tableName: row[0],
    id: row[1],
    encryptedData: row[2],
    timestamp: row[3] || undefined,
    parentId: row[4] || undefined,
    unencryptedData: row[5] || undefined,
  };
}

/**
 * Import data from CSV format (streaming version with batch operations)
 * Re-encrypts data with the app's current CEK
 * Skips records with duplicate IDs
 * Memory-efficient: processes file in chunks, never loads entire file into memory
 * Performance-optimized: uses batchSave() for faster imports
 *
 * @param adapter - Storage adapter for direct database access
 * @param file - CSV file to import
 * @param sourceCEK - CEK from the source database (base32 or base64)
 * @param appEncryptionService - App's encryption service (for re-encryption)
 * @param onProgress - Optional progress callback
 * @returns Object with counts of imported and skipped records
 */
export async function importDataFromFile(
  adapter: StorageAdapter,
  file: File,
  sourceCEK: string,
  appEncryptionService: EncryptionService,
  onProgress?: ImportProgressCallback
): Promise<{ imported: number; skipped: number; errors: string[] }> {
  console.debug('[DataImport] Starting streaming data import with batch operations...');

  // Initialize source encryption with provided CEK
  const sourceEncryption = new EncryptionService();
  await sourceEncryption.initializeWithCEK(sourceCEK);
  console.debug('[DataImport] Source encryption initialized with provided CEK');

  // Compare CEKs to determine if we can skip re-encryption
  const shouldSkipReEncryption = sourceEncryption.hasSameKeyAs(appEncryptionService);

  if (shouldSkipReEncryption) {
    console.debug('[DataImport] CEKs match - importing data as-is (no re-encryption)');
  } else {
    console.debug('[DataImport] CEKs differ - will re-encrypt all data');
  }

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];
  let rowIndex = 0;
  let headerValidated = false;

  // Batch state
  let currentTable = '';
  let batch: BatchSaveRow[] = [];

  // Estimate total rows based on average row size (rough estimate for progress)
  // Typical row is ~500 bytes for small records, ~2KB for messages with content
  const estimatedTotal = Math.floor(file.size / 1000);

  /**
   * Flush the current batch to storage
   */
  const flushBatch = async () => {
    if (batch.length > 0 && currentTable) {
      console.debug(`[DataImport] Flushing batch of ${batch.length} records to ${currentTable}`);
      const result = await adapter.batchSave(currentTable, batch, true); // skipExisting for import
      imported += result.saved;
      skipped += result.skipped;
      batch = [];
    }
  };

  // Stream CSV rows from file
  for await (const row of streamCSVRows(file)) {
    rowIndex++;

    // First row is header - validate it
    if (!headerValidated) {
      if (JSON.stringify(row) !== JSON.stringify(EXPECTED_HEADER)) {
        throw new Error('Invalid CSV header. Expected: ' + EXPECTED_HEADER.join(','));
      }
      headerValidated = true;
      continue;
    }

    // Parse the row
    const record = parseRow(row);
    if (!record) {
      console.warn(`[DataImport] Skipping malformed row ${rowIndex}: insufficient columns`);
      skipped++;
      continue;
    }

    // Flush batch if table changes
    if (record.tableName !== currentTable) {
      await flushBatch();
      currentTable = record.tableName;
    }

    try {
      // Special handling for api_definitions - need to check credentials
      if (record.tableName === Tables.API_DEFINITIONS) {
        const existing = await adapter.get(record.tableName, record.id);
        if (existing) {
          try {
            const existingDef = JSON.parse(
              await appEncryptionService.decrypt(existing.encryptedData)
            );
            const localHasEmptyCredentials = !existingDef.apiKey && !existingDef.baseUrl;

            if (!localHasEmptyCredentials) {
              console.debug(
                `[DataImport] Skipping api_definition (local has credentials): ${record.id}`
              );
              skipped++;
              continue;
            }
            // Fall through - will be added to batch and overwritten
            console.debug(
              `[DataImport] Overwriting api_definition with empty credentials: ${record.id}`
            );
          } catch {
            // If we can't decrypt/parse the existing record, skip it to be safe
            console.debug(
              `[DataImport] Skipping api_definition (unable to check credentials): ${record.id}`
            );
            skipped++;
            continue;
          }
        }
      }

      // Re-encrypt data (or skip if CEKs match)
      let finalEncryptedData = record.encryptedData;

      // Only process encrypted data (not placeholders like '__METADATA__')
      if (record.encryptedData && record.encryptedData !== '__METADATA__') {
        if (shouldSkipReEncryption) {
          // CEKs match - use encrypted data as-is (optimization for sync/migration)
          finalEncryptedData = record.encryptedData;
        } else {
          // CEKs differ - decrypt and re-encrypt
          const decryptedJson = await sourceEncryption.decrypt(record.encryptedData);
          finalEncryptedData = await appEncryptionService.encrypt(decryptedJson);
        }
      }

      // Add to batch
      batch.push({
        id: record.id,
        encryptedData: finalEncryptedData,
        timestamp: record.timestamp,
        parentId: record.parentId,
        unencryptedData: record.unencryptedData,
      });

      // Flush batch if it reaches the limit
      if (batch.length >= BATCH_SIZE) {
        await flushBatch();
      }

      // Report progress every 50 records (based on rows processed)
      if (onProgress && rowIndex % 50 === 0) {
        onProgress({
          processed: imported + skipped + errors.length + batch.length,
          imported,
          skipped,
          errors: errors.length,
          estimatedTotal,
        });
      }
    } catch (error) {
      const errorMsg = `${record.tableName}/${record.id}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      console.error(`[DataImport] Error processing record ${errorMsg}`);
      errors.push(errorMsg);
    }
  }

  // Flush any remaining records in the batch
  await flushBatch();

  // Validate that we got at least the header
  if (!headerValidated) {
    throw new Error('CSV file is empty');
  }

  // Final progress report
  if (onProgress) {
    onProgress({
      processed: imported + skipped + errors.length,
      imported,
      skipped,
      errors: errors.length,
    });
  }

  console.debug(
    `[DataImport] Import complete! Imported: ${imported}, Skipped: ${skipped}, Errors: ${errors.length}`
  );

  return { imported, skipped, errors };
}

/**
 * Migrate data from CSV format (full restoration mode) - streaming version
 * This clears all existing data and imports with the source credentials
 * WARNING: This deletes all current data including CEK!
 *
 * @param adapter - Storage adapter for direct database access
 * @param file - CSV file to import
 * @param sourceCEK - CEK from the source database (base32 or base64)
 * @param appEncryptionService - App's encryption service (will be re-initialized)
 * @param onProgress - Optional progress callback
 * @returns Object with counts of imported and skipped records
 */
export async function migrateDataFromFile(
  adapter: StorageAdapter,
  file: File,
  sourceCEK: string,
  appEncryptionService: EncryptionService,
  onProgress?: ImportProgressCallback
): Promise<{ imported: number; skipped: number; errors: string[] }> {
  console.debug(
    '[DataImport] Starting MIGRATION MODE - will clear all data and restore from backup'
  );

  // First, validate the CSV by reading just the header
  // Stream first row only to validate
  let headerValidated = false;
  for await (const row of streamCSVRows(file)) {
    if (JSON.stringify(row) !== JSON.stringify(EXPECTED_HEADER)) {
      throw new Error('Invalid CSV header. Expected: ' + EXPECTED_HEADER.join(','));
    }
    headerValidated = true;
    break; // Only need to check header
  }

  if (!headerValidated) {
    throw new Error('CSV file is empty');
  }

  console.debug('[DataImport] CSV validated, clearing all app data...');

  // Clear all data from database
  await adapter.clearAll();

  // Clear CEK from localStorage
  await appEncryptionService.clearCEK();

  console.debug('[DataImport] App data cleared, setting up new CEK...');

  // Import the source CEK
  await appEncryptionService.importCEK(sourceCEK);

  console.debug('[DataImport] Encryption re-initialized with source CEK');

  // Now run streaming import (which will skip re-encryption since CEKs match)
  return importDataFromFile(adapter, file, sourceCEK, appEncryptionService, onProgress);
}
