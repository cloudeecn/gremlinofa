/**
 * Extracted worker handler logic — the message routing, stream dispatch,
 * and adapter registration that previously lived as module-level code in
 * `gremlinWorker.ts`. Parameterized on a `WorkerScope` interface so the
 * same code can be driven from a real `DedicatedWorkerGlobalScope` (prod)
 * or a lightweight test harness (see `workerHandler.integration.test.ts`).
 */

import { GremlinServer, ProtocolError } from '../shared/engine/GremlinServer';
import { STREAM_METHODS } from '../shared/protocol/streamMethods';
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
import { RemoteVfsAdapter } from '../shared/services/vfs/RemoteVfsAdapter';

/**
 * Minimal subset of `DedicatedWorkerGlobalScope` that the handler needs.
 * Tests can supply a plain object satisfying this interface.
 */
export interface WorkerScope {
  postMessage(msg: unknown): void;
  addEventListener(type: 'message', handler: (ev: MessageEvent) => void): void;
}

interface StreamCancelMessage {
  kind: 'stream_cancel';
  requestId: string;
}

interface WorkerConfigMessage {
  kind: 'worker_config';
  storageConfig: StorageConfig;
}

type IncomingMessage = RequestEnvelope | StreamCancelMessage | WorkerConfigMessage;

/**
 * Wire up a `GremlinServer` to the given scope's message channel. Returns
 * the server instance so callers (tests) can inspect or stub its internals.
 */
export function createWorkerHandler(scope: WorkerScope): GremlinServer {
  const server: GremlinServer = new GremlinServer(null);

  server.setBootstrapAdapterFactories({
    createStorageAdapter,
    createVfsAdapter,
    buildMigrationSourceAdapter: async (project, sourceEncryption) => {
      if (!project.remoteVfsUrl) throw new Error('Project has no remote VFS URL');
      const userId = await sourceEncryption.deriveUserId();
      return new RemoteVfsAdapter({
        baseUrl: project.remoteVfsUrl,
        userId,
        password: project.remoteVfsPassword ?? '',
        projectId: project.id,
      });
    },
  });

  const activeStreams = new Map<string, AbortController>();

  function postEnvelope(
    envelope: ResponseEnvelope | StreamEventEnvelope | StreamEndEnvelope | ErrorEnvelope
  ): void {
    scope.postMessage(envelope);
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

  scope.addEventListener('message', (ev: MessageEvent<IncomingMessage>) => {
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
        server.setBootstrapStorageConfig(msg.storageConfig);
        break;
    }
  });

  // Tell the main thread we're ready to accept envelopes.
  scope.postMessage({ kind: 'worker_ready' });

  return server;
}
