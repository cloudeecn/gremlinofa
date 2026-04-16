/// <reference lib="webworker" />

/**
 * Web Worker entry for the GremlinOFA backend.
 *
 * The worker boots truly dormant: no `UnifiedStorage` constructed, no
 * encryption initialized, no `LoopRegistry` work happening. Bootstrap is
 * a two-step handshake:
 *
 *   1. The main thread posts a non-protocol `worker_config` message
 *      carrying the `StorageConfig` (read from main-thread localStorage).
 *      The worker stashes it on the `GremlinServer` instance via
 *      `setBootstrapStorageConfig` and waits for `init`.
 *   2. The main thread posts the standard `init` request envelope
 *      (per the protocol in `src/shared/protocol/protocol.ts`) carrying
 *      just `{cek}`. `GremlinServer.init` constructs storage + encryption
 *      from those two pieces and transitions out of dormant.
 *
 * Until both steps complete every other RPC rejects with
 * `code: 'NOT_INITIALIZED'`. The split keeps the typed RPC contract
 * narrow (the server reads only what it can also receive from env vars
 * in Phase 2's Node deployment) while still letting the worker pull its
 * adapter selection from the main thread's localStorage.
 *
 * Phase 1.65 added a third bootstrap channel: this entry imports the
 * worker-side adapter factories from `./adapters/` and registers them
 * via `setBootstrapAdapterFactories` at module load. The dispatcher
 * reads them off `BackendDeps.createStorageAdapter` /
 * `BackendDeps.createVfsAdapter` so `src/shared/` no longer references
 * the browser-only inner adapters.
 */

import { GremlinServer, ProtocolError } from '../shared/engine/GremlinServer';
import type {
  ErrorEnvelope,
  GremlinMethods,
  RequestEnvelope,
  ResponseEnvelope,
  StreamEndEnvelope,
  StreamEventEnvelope,
} from '../shared/protocol/protocol';
import type { StorageConfig } from '../shared/protocol/types/storageConfig';
import { createStorageAdapter } from './adapters/createStorageAdapter';
import { createVfsAdapter } from './adapters/createVfsAdapter';

declare const self: DedicatedWorkerGlobalScope;

interface StreamCancelMessage {
  kind: 'stream_cancel';
  requestId: string;
}

interface WorkerConfigMessage {
  kind: 'worker_config';
  storageConfig: StorageConfig;
}

type IncomingMessage = RequestEnvelope | StreamCancelMessage | WorkerConfigMessage;

// Construct in deferred mode — `_storage` is null until `init` arrives.
const server: GremlinServer = new GremlinServer(null);

// Inject the worker-side adapter factories. Phase 1.65 hoisted both
// `createStorageAdapter` and `createVfsAdapter` out of `src/shared/` so the
// browser-only inner adapters (`IndexedDBAdapter`, `RemoteStorageAdapter`,
// `RemoteVfsAdapter`) can live next to the worker entry. The dispatcher
// reads them off `BackendDeps.createStorageAdapter` / `createVfsAdapter`
// in `init`, `getProjectVfsAdapter`, and `validateRemoteStorage`.
server.setBootstrapAdapterFactories({ createStorageAdapter, createVfsAdapter });

const activeStreams = new Map<string, AbortController>();

function postEnvelope(
  envelope: ResponseEnvelope | StreamEventEnvelope | StreamEndEnvelope | ErrorEnvelope
): void {
  self.postMessage(envelope);
}

async function handleRequest(envelope: RequestEnvelope): Promise<void> {
  const isStream = STREAM_METHODS.has(envelope.method);
  if (isStream) {
    void runStream(envelope);
    return;
  }

  try {
    const result = await server.handleRequest(
      envelope.method as keyof GremlinMethods,
      envelope.params
    );
    postEnvelope({
      kind: 'response',
      requestId: envelope.requestId,
      result,
    });
  } catch (err) {
    postEnvelope(toErrorEnvelope(envelope.requestId, err));
  }
}

/**
 * Drive a streaming dispatch on the server, posting each yielded event back
 * to the main thread as a `stream_event` envelope and finishing with a
 * `stream_end` (or `error`).
 */
async function runStream(envelope: RequestEnvelope): Promise<void> {
  const controller = new AbortController();
  activeStreams.set(envelope.requestId, controller);
  let seq = 0;

  try {
    const gen = server.handleStream(envelope.method as keyof GremlinMethods, envelope.params);
    for await (const event of gen) {
      if (controller.signal.aborted) {
        break;
      }
      postEnvelope({
        kind: 'stream_event',
        requestId: envelope.requestId,
        seq: seq++,
        event,
      } as StreamEventEnvelope);
    }
    postEnvelope({
      kind: 'stream_end',
      requestId: envelope.requestId,
      status: controller.signal.aborted ? 'aborted' : 'complete',
    });
  } catch (err) {
    postEnvelope(toErrorEnvelope(envelope.requestId, err));
    postEnvelope({
      kind: 'stream_end',
      requestId: envelope.requestId,
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    activeStreams.delete(envelope.requestId);
  }
}

function toErrorEnvelope(requestId: string, err: unknown): ErrorEnvelope {
  if (err instanceof ProtocolError) {
    return {
      kind: 'error',
      requestId,
      code: err.code,
      message: err.message,
      data: err.data,
    };
  }
  return {
    kind: 'error',
    requestId,
    code: 'INTERNAL_ERROR',
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * The set of methods that should be dispatched as streams. Mirrors the
 * `streams: never` discriminator on each `GremlinMethods` entry. Kept as a
 * runtime constant because the worker doesn't have type info available at
 * dispatch time.
 */
const STREAM_METHODS = new Set<string>([
  'runLoop',
  'attachChat',
  'subscribeActiveLoops',
  'exportData',
  'importData',
  'vfsCompactProject',
  'exportProject',
]);

self.addEventListener('message', (ev: MessageEvent<IncomingMessage>) => {
  const msg = ev.data;
  switch (msg.kind) {
    case 'request':
      void handleRequest(msg);
      break;
    case 'stream_cancel': {
      const controller = activeStreams.get(msg.requestId);
      if (controller) {
        controller.abort();
      }
      break;
    }
    case 'worker_config':
      // Stash the storage config on the server. `init` reads it when
      // building the deferred-mode `BackendDeps` bundle. Posting twice
      // is allowed — last write wins; the server doesn't act on it
      // until `init` arrives.
      server.setBootstrapStorageConfig(msg.storageConfig);
      break;
  }
});

// Tell the main thread we're ready to accept the `init` envelope. The
// worker transport waits for this signal before sending anything.
self.postMessage({ kind: 'worker_ready' });
