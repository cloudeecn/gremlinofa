/**
 * Wraps `streamExportCSVLines` into a stream of `ExportEvent`s for the
 * `exportData` RPC. The runner buffers CSV lines into roughly-sized byte
 * chunks and emits one `chunk` event per buffer flush, `progress` events
 * (the first record, then at most one per 100 ms, then the final count
 * before `done`), and a final `done` event with the suggested filename.
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

/**
 * Minimum gap between `progress` events. Each one crosses the worker/WebSocket
 * boundary and re-renders the Data Manager page; the UI can't show more than a
 * few updates a second anyway.
 */
const PROGRESS_INTERVAL_MS = 100;

export async function* runExport(
  storage: UnifiedStorage,
  encryption: EncryptionCore
): AsyncGenerator<ExportEvent, void, void> {
  const adapter = storage.getAdapter();
  const encoder = new TextEncoder();
  let buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let lines = 0;
  let reportedRecords = 0;
  let lastProgressAt = -Infinity;

  for await (const line of streamExportCSVLines(adapter, encryption)) {
    const bytes = encoder.encode(line);
    buffered.push(bytes);
    bufferedBytes += bytes.byteLength;
    lines++;

    // Skip the header line in the count we report to the UI.
    const records = lines - 1;
    if (records > 0) {
      const now = Date.now();
      if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        lastProgressAt = now;
        reportedRecords = records;
        yield { type: 'progress', processed: records };
      }
    }

    if (bufferedBytes >= CHUNK_BYTE_TARGET) {
      yield { type: 'chunk', data: concat(buffered, bufferedBytes) };
      buffered = [];
      bufferedBytes = 0;
    }
  }

  const totalRecords = Math.max(0, lines - 1);
  if (totalRecords > reportedRecords) {
    yield { type: 'progress', processed: totalRecords };
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
