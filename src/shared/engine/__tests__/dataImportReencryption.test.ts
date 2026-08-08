/**
 * Cross-CEK re-encryption with REAL crypto.
 *
 * The compressed-row regression this pins down: rows written via
 * `encryptWithCompression` decrypt to raw `"GZ" + gzip` bytes. The import
 * re-encryption path used to round-trip them through the string
 * `decrypt()`/`encrypt()` pair, whose TextDecoder step replaced the binary
 * payload with U+FFFD — silently destroying every VFS file, message, and
 * model cache imported across differing CEKs. The fix re-encrypts raw
 * bytes (`decryptToBytes` → `encryptBytes`), preserving each row's payload
 * exactly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { importDataFromFile } from '../dataImport';
import { Tables } from '../../services/storage/StorageAdapter';
import type { StorageAdapter, BatchSaveRow } from '../../services/storage/StorageAdapter';
import { EncryptionCore } from '../../services/encryption/encryptionCore';
import { buildCSVLine } from '../lib/csvHelper';

const SOURCE_CEK = 'a'.repeat(52);
const APP_CEK = 'b'.repeat(52);

function csvToFile(rows: string[]): File {
  const header = buildCSVLine([
    'tableName',
    'id',
    'encryptedData',
    'timestamp',
    'parentId',
    'unencryptedData',
  ]);
  return new File([[header, ...rows].join('\n')], 'backup.csv', { type: 'text/csv' });
}

describe('dataImport re-encryption (real crypto)', () => {
  let sourceCore: EncryptionCore;
  let appCore: EncryptionCore;
  let savedRows: Map<string, BatchSaveRow>;
  let adapter: StorageAdapter;

  beforeEach(async () => {
    sourceCore = new EncryptionCore();
    await sourceCore.initializeWithCEK(SOURCE_CEK);
    appCore = new EncryptionCore();
    await appCore.initializeWithCEK(APP_CEK);

    savedRows = new Map();
    adapter = {
      get: async () => null,
      batchSave: async (_table: string, rows: BatchSaveRow[]) => {
        for (const row of rows) savedRows.set(row.id, row);
        return { saved: rows.length, skipped: 0 };
      },
    } as unknown as StorageAdapter;
  });

  it('preserves compressed rows byte-exactly across differing CEKs', async () => {
    const messagePayload = JSON.stringify({
      id: 'msg-1',
      role: 'assistant',
      content: 'long compressible content '.repeat(80),
    });
    const compressed = await sourceCore.encryptWithCompression(messagePayload, true);
    const plain = await sourceCore.encrypt(JSON.stringify({ id: 'proj-1', name: 'Project' }));

    const file = csvToFile([
      buildCSVLine([Tables.PROJECTS, 'proj-1', plain, '', '', '']),
      buildCSVLine([Tables.MESSAGES, 'msg-1', compressed, '', 'chat-1', '']),
    ]);

    const result = await importDataFromFile(adapter, file, SOURCE_CEK, appCore);
    expect(result.imported).toBe(2);
    expect(result.errors).toEqual([]);

    // The compressed row survives the re-encryption and still carries its
    // "GZ" prefix under the app key.
    const msgRow = savedRows.get('msg-1')!;
    const msgBytes = await appCore.decryptToBytes(msgRow.encryptedData);
    expect(msgBytes[0]).toBe(71); // 'G'
    expect(msgBytes[1]).toBe(90); // 'Z'
    expect(await appCore.decryptWithDecompression(msgRow.encryptedData)).toBe(messagePayload);

    // The plain row stays plain.
    const projRow = savedRows.get('proj-1')!;
    const projJson = await appCore.decryptWithDecompression(projRow.encryptedData);
    expect(JSON.parse(projJson).name).toBe('Project');
  });

  it('copies ciphertext verbatim when source and app CEKs match', async () => {
    const compressed = await appCore.encryptWithCompression('same-key payload', true);
    const file = csvToFile([
      buildCSVLine([Tables.MESSAGES, 'msg-2', compressed, '', 'chat-1', '']),
    ]);

    const result = await importDataFromFile(adapter, file, APP_CEK, appCore);
    expect(result.imported).toBe(1);
    expect(savedRows.get('msg-2')!.encryptedData).toBe(compressed);
  });
});
