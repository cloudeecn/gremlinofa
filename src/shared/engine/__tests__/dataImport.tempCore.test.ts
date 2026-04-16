/**
 * Phase 1.5 invariant: `importDataFromFile` builds a *disposable* source
 * `EncryptionCore` from the supplied CEK, decrypts each row through it,
 * and re-encrypts under the active app encryption core. The active core
 * is **never** mutated — neither `initializeWithCEK`, nor `forget`, nor
 * `clearCEK` is called on it.
 *
 * The legacy implementation of `migrateDataFromFile` used to hot-swap
 * the active CEK to the source CEK; this test pins the new contract so
 * a regression there fails loudly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { importDataFromFile } from '../dataImport';
import { EncryptionCore } from '../../services/encryption/encryptionCore';
import { Tables } from '../../services/storage/StorageAdapter';
import type {
  StorageAdapter,
  BatchSaveRow,
  BatchSaveResult,
} from '../../services/storage/StorageAdapter';

const SOURCE_CEK = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';
const ACTIVE_CEK = 'stuvwxyz234567abcdefghijklmnopqrstuvwxyz234567abcdef';

function csvToFile(csvContent: string): File {
  return new File([csvContent], 'test.csv', { type: 'text/csv' });
}

describe('importDataFromFile — temp source core (Phase 1.5)', () => {
  let mockAdapter: StorageAdapter;
  let activeCore: EncryptionCore;

  beforeEach(async () => {
    activeCore = new EncryptionCore();
    await activeCore.initializeWithCEK(ACTIVE_CEK);

    mockAdapter = {
      initialize: vi.fn(),
      save: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      query: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
      clearAll: vi.fn(),
      exportPaginated: vi.fn(),
      batchGet: vi.fn(),
      getStorageQuota: vi.fn().mockResolvedValue(null),
      batchSave: vi.fn().mockImplementation(
        async (_table: string, rows: BatchSaveRow[]): Promise<BatchSaveResult> => ({
          saved: rows.length,
          skipped: 0,
        })
      ),
    };
  });

  it('decrypts source rows with the source CEK and re-encrypts with the active CEK', async () => {
    // Build a source core to encrypt the test row, then ship the
    // ciphertext through the importer with the source CEK string and
    // the active core. The importer should decrypt with the temp source
    // core (constructed from SOURCE_CEK) and re-encrypt with `activeCore`.
    const sourceCore = new EncryptionCore();
    await sourceCore.initializeWithCEK(SOURCE_CEK);

    const plaintext = JSON.stringify({ name: 'test project' });
    const sourceCiphertext = await sourceCore.encrypt(plaintext);

    const csv =
      'tableName,id,encryptedData,timestamp,parentId,unencryptedData\n' +
      `${Tables.PROJECTS},proj_1,${sourceCiphertext},2024-01-01T00:00:00Z,,`;

    const result = await importDataFromFile(mockAdapter, csvToFile(csv), SOURCE_CEK, activeCore);

    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Pull the row that landed in storage and verify it decrypts under
    // the active core (not the source core).
    const batchSaveCalls = vi.mocked(mockAdapter.batchSave).mock.calls;
    expect(batchSaveCalls.length).toBe(1);
    const [, savedRows] = batchSaveCalls[0];
    expect(savedRows).toHaveLength(1);
    const savedCiphertext = savedRows[0].encryptedData;
    expect(savedCiphertext).not.toBe(sourceCiphertext); // re-encrypted

    const decoded = await activeCore.decrypt(savedCiphertext);
    expect(decoded).toBe(plaintext);

    // The temp source core decrypts the *original* ciphertext but not
    // the one stored in the destination — the destination row is keyed
    // under the active CEK now.
    await expect(sourceCore.decrypt(savedCiphertext)).rejects.toThrow();
  });

  it('does not call forget() / clearCEK on the active core during import', async () => {
    const forgetSpy = vi.spyOn(activeCore, 'forget');

    // Encrypt a row with the source key first.
    const sourceCore = new EncryptionCore();
    await sourceCore.initializeWithCEK(SOURCE_CEK);
    const sourceCiphertext = await sourceCore.encrypt(JSON.stringify({ name: 'test' }));

    const csv =
      'tableName,id,encryptedData,timestamp,parentId,unencryptedData\n' +
      `${Tables.PROJECTS},proj_1,${sourceCiphertext},2024-01-01T00:00:00Z,,`;

    await importDataFromFile(mockAdapter, csvToFile(csv), SOURCE_CEK, activeCore);

    expect(forgetSpy).not.toHaveBeenCalled();
    // Active core is still keyed and usable.
    expect(activeCore.isInitialized()).toBe(true);
    const probe = await activeCore.encrypt('still works');
    expect(await activeCore.decrypt(probe)).toBe('still works');
  });

  it('shortcuts re-encryption when source CEK matches active CEK', async () => {
    // Build a source core with the same CEK as the active core. The
    // importer's `hasSameKeyAs` check should kick in and write the
    // source ciphertext through unchanged (no decrypt + re-encrypt).
    const sameKeyCore = new EncryptionCore();
    await sameKeyCore.initializeWithCEK(ACTIVE_CEK);
    const ciphertext = await sameKeyCore.encrypt(JSON.stringify({ id: 'p1' }));

    const csv =
      'tableName,id,encryptedData,timestamp,parentId,unencryptedData\n' +
      `${Tables.PROJECTS},proj_1,${ciphertext},2024-01-01T00:00:00Z,,`;

    await importDataFromFile(mockAdapter, csvToFile(csv), ACTIVE_CEK, activeCore);

    const [, savedRows] = vi.mocked(mockAdapter.batchSave).mock.calls[0];
    // Same-key path → ciphertext flows through unchanged.
    expect(savedRows[0].encryptedData).toBe(ciphertext);
  });
});
