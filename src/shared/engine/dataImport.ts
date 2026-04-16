/**
 * Data Import Runtime
 *
 * Imports data from CSV format with re-encryption. Streams the input file
 * (so iOS / memory-constrained devices don't need to load the whole CSV into
 * RAM) and saves rows in batches via `adapter.batchSave()`.
 *
 * Lives in `src/backend/` because it pulls in storage + encryption — frontend
 * code drives it through the `gremlinClient.importData` RPC (in
 * `src/backend/importRunner.ts`) and uses the type-only progress callback
 * declared in `src/types/data.ts`.
 */

import { EncryptionCore } from '../services/encryption/encryptionCore';
import type { StorageAdapter, BatchSaveRow } from '../services/storage/StorageAdapter';
import { Tables } from '../services/storage/StorageAdapter';
import { streamCSVRows } from './lib/csvHelper';
import type { ImportProgressCallback } from '../protocol/types/data';

interface ImportRecord {
  tableName: string;
  id: string;
  encryptedData: string;
  timestamp?: string;
  parentId?: string;
  unencryptedData?: string;
}

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
 * Import data from a CSV bundle, decrypting each row with a temporary
 * `EncryptionCore` constructed from `sourceCEK` and re-encrypting under
 * the active app encryption core. The active core is **never mutated** —
 * the source CEK is held only by the disposable `sourceEncryption`
 * instance, which goes out of scope when the function returns.
 *
 * Skips records with duplicate IDs (per the existing storage adapter
 * `skipExisting` semantics). Memory-efficient: streams the file row by
 * row. Performance-optimized: batches `batchSave` writes.
 *
 * @param adapter - Storage adapter for direct database access
 * @param file - CSV file (or Blob) to import
 * @param sourceCEK - CEK from the source database (base32 or base64)
 * @param appEncryption - Active app encryption core (read-only — never mutated)
 * @param onProgress - Optional progress callback
 * @returns Object with counts of imported and skipped records
 */
export async function importDataFromFile(
  adapter: StorageAdapter,
  file: Blob,
  sourceCEK: string,
  appEncryption: EncryptionCore,
  onProgress?: ImportProgressCallback
): Promise<{ imported: number; skipped: number; errors: string[] }> {
  console.debug('[DataImport] Starting streaming data import with batch operations...');

  // Build a disposable source core from the supplied CEK. The active app
  // core is never mutated — every decrypt round-trip below goes through
  // `sourceEncryption`, every re-encrypt goes through `appEncryption`.
  const sourceEncryption = new EncryptionCore();
  await sourceEncryption.initializeWithCEK(sourceCEK);
  console.debug('[DataImport] Source encryption initialized with provided CEK');

  // Compare CEKs to determine if we can skip re-encryption
  const shouldSkipReEncryption = sourceEncryption.hasSameKeyAs(appEncryption);

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
            const existingDef = JSON.parse(await appEncryption.decrypt(existing.encryptedData));
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
          finalEncryptedData = await appEncryption.encrypt(decryptedJson);
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
 * Migrate data from CSV format (full restoration mode) — streaming.
 * Clears the database and re-encrypts every imported row under the
 * **active** app encryption core. The active core is never mutated; the
 * source CEK is held only by the disposable temp core inside
 * `importDataFromFile`.
 *
 * To change identity (i.e. adopt the source CEK as the new app CEK), the
 * caller must `purgeAllData` first and re-bootstrap with a new `init` —
 * this function intentionally no longer hot-swaps the active CEK.
 * WARNING: this still deletes all current database rows.
 *
 * @param adapter - Storage adapter for direct database access
 * @param file - CSV file to import
 * @param sourceCEK - CEK from the source database (base32 or base64)
 * @param appEncryption - Active app encryption core (read-only — never mutated)
 * @param onProgress - Optional progress callback
 * @returns Object with counts of imported and skipped records
 */
export async function migrateDataFromFile(
  adapter: StorageAdapter,
  file: Blob,
  sourceCEK: string,
  appEncryption: EncryptionCore,
  onProgress?: ImportProgressCallback
): Promise<{ imported: number; skipped: number; errors: string[] }> {
  console.debug(
    '[DataImport] Starting MIGRATION MODE — will clear all data and re-encrypt from backup'
  );

  // First, validate the CSV by reading just the header
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

  console.debug('[DataImport] CSV validated, clearing all database rows...');

  // Clear all data from the database. The active encryption core is
  // intentionally NOT touched — we keep decrypting/re-encrypting
  // through it below.
  await adapter.clearAll();

  console.debug('[DataImport] Rows cleared, re-encrypting source bundle under active CEK...');

  // Run the streaming import. The temp `EncryptionCore` constructed
  // inside handles the source CEK; the active app core re-encrypts.
  return importDataFromFile(adapter, file, sourceCEK, appEncryption, onProgress);
}
