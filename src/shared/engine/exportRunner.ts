/**
 * Wraps `streamExportCSVLines` into a stream of `ExportEvent`s for the
 * `exportData` RPC. The runner buffers CSV lines into roughly-sized byte
 * chunks and emits one `chunk` event per buffer flush, plus a `progress`
 * event per record and a final `done` event with the suggested filename.
 *
 * The frontend reassembles the chunks into a `Blob` and triggers the
 * download anchor — the DOM stays on the main thread even though the CSV
 * generation runs on the backend.
 */

import type { EncryptionCore } from '../services/encryption/encryptionCore';
import type { UnifiedStorage } from '../services/storage/unifiedStorage';
import { streamExportCSVLines } from './dataExport';
import type { ExportEvent } from '../protocol/protocol';

/** Soft cap on bytes per chunk. Larger chunks reduce envelope overhead. */
const CHUNK_BYTE_TARGET = 64 * 1024;

export async function* runExport(
  storage: UnifiedStorage,
  encryption: EncryptionCore
): AsyncGenerator<ExportEvent, void, void> {
  const adapter = storage.getAdapter();
  const encoder = new TextEncoder();
  let buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let processed = 0;

  for await (const line of streamExportCSVLines(adapter, encryption)) {
    const bytes = encoder.encode(line);
    buffered.push(bytes);
    bufferedBytes += bytes.byteLength;
    processed++;

    // Skip the header line in the count we report to the UI.
    if (processed > 1) {
      yield { type: 'progress', processed: processed - 1 };
    }

    if (bufferedBytes >= CHUNK_BYTE_TARGET) {
      yield { type: 'chunk', data: concat(buffered, bufferedBytes) };
      buffered = [];
      bufferedBytes = 0;
    }
  }

  if (bufferedBytes > 0) {
    yield { type: 'chunk', data: concat(buffered, bufferedBytes) };
  }

  const date = new Date().toISOString().split('T')[0];
  yield {
    type: 'done',
    suggestedName: `gremlinofa-backup-${date}.csv`,
    mimeType: 'text/csv;charset=utf-8;',
  };
}

/** Concatenate the buffered chunks into a single contiguous Uint8Array. */
function concat(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
