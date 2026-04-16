/**
 * Wraps `importDataFromFile` / `migrateDataFromFile` into a stream of
 * `ImportProgress` events for the `importData` RPC. The frontend reads the
 * uploaded `File` to a `Uint8Array` first, posts the bytes through, and the
 * runner here wraps them in an in-memory `Blob` so the existing CSV
 * streaming pipeline doesn't need a separate "from bytes" code path.
 *
 * The terminal `done` event carries the final counts so the consumer can
 * collect a result without a separate one-shot result envelope.
 */

import type { EncryptionCore } from '../services/encryption/encryptionCore';
import type { UnifiedStorage } from '../services/storage/unifiedStorage';
import { importDataFromFile, migrateDataFromFile } from './dataImport';
import type { ImportProgress as ImportProgressCount } from '../protocol/types/data';
import type { ImportDataParams, ImportProgress } from '../protocol/protocol';

export async function* runImport(
  storage: UnifiedStorage,
  encryption: EncryptionCore,
  params: ImportDataParams
): AsyncGenerator<ImportProgress, void, void> {
  const adapter = storage.getAdapter();
  const blob = new Blob([new Uint8Array(params.data)], { type: 'text/csv' });

  // Bridge the callback-based progress reporter into a generator queue.
  const queue: ImportProgress[] = [];
  let resolveNext: (() => void) | null = null;
  let done = false;
  let finalResult: { imported: number; skipped: number; errors: string[] } | null = null;
  let runError: unknown = null;

  const push = (event: ImportProgress) => {
    queue.push(event);
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  const onProgress = (p: ImportProgressCount) => {
    push({
      type: 'progress',
      processed: p.processed,
      imported: p.imported,
      skipped: p.skipped,
      errors: p.errors,
      estimatedTotal: p.estimatedTotal,
    });
  };

  const runner =
    params.mode === 'replace'
      ? migrateDataFromFile(adapter, blob, params.sourceCEK, encryption, onProgress)
      : importDataFromFile(adapter, blob, params.sourceCEK, encryption, onProgress);

  // Kick off the importer; collect the result and signal completion via the
  // shared queue. Errors are surfaced as a thrown exception from the loop
  // below so the transport wraps them as `stream_end {error}`.
  runner
    .then(result => {
      finalResult = result;
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    })
    .catch(err => {
      runError = err;
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    });

  while (true) {
    if (queue.length > 0) {
      yield queue.shift()!;
      continue;
    }
    if (done) break;
    await new Promise<void>(resolve => {
      resolveNext = resolve;
    });
  }

  if (runError) {
    throw runError;
  }

  // `runner` resolved without throwing, so finalResult is guaranteed.
  const result = finalResult!;
  yield {
    type: 'done',
    imported: result.imported,
    skipped: result.skipped,
    errors: result.errors,
  };
}
