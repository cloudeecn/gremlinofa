/**
 * Web Worker transport for `GremlinClient`.
 *
 * The main thread spawns the worker, waits for the one-shot `worker_ready`
 * signal, and then communicates with the worker via the standard protocol
 * envelopes (`request`, `response`, `stream_event`, `stream_end`, `error`).
 *
 * The transport queues every RPC except `init` until `init` has succeeded
 * — the worker rejects everything else with `code: 'NOT_INITIALIZED'`
 * before that point. The bootstrap is purely the protocol's `init`
 * method; no localStorage snapshot is posted across the boundary.
 *
 * Phase 2 will swap this for `WebSocketTransport`. The wire format and the
 * `Transport` interface are the same — only the framing changes.
 */

import type {
  ErrorEnvelope,
  GremlinMethods,
  MethodParams,
  MethodResult,
  RequestEnvelope,
  ResponseEnvelope,
  StreamEndEnvelope,
  StreamEventEnvelope,
  Transport,
} from '../../../shared/protocol/protocol';
import { ProtocolError } from '../../../shared/protocol/protocolError';
import type { StorageConfig } from '../../lib/localStorageBoot';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingStream {
  push: (envelope: StreamEventEnvelope | StreamEndEnvelope) => void;
  reject: (error: Error) => void;
}

type WorkerOutgoing =
  | RequestEnvelope
  | { kind: 'stream_cancel'; requestId: string }
  | { kind: 'worker_config'; storageConfig: StorageConfig };

type WorkerIncoming =
  | { kind: 'worker_ready' }
  | ResponseEnvelope
  | StreamEventEnvelope
  | StreamEndEnvelope
  | ErrorEnvelope;

export class WorkerTransport implements Transport {
  private readonly worker: Worker;
  private requestCounter = 0;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly pendingStreams = new Map<string, PendingStream>();
  /** Resolves once the worker has posted `worker_ready`. */
  private readyPromise: Promise<void>;
  /** Resolves once `init` has been awaited successfully. */
  private initPromise: Promise<void>;
  private resolveInit: (() => void) | null = null;
  private rejectInit: ((err: Error) => void) | null = null;

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.addEventListener('message', this.handleMessage);

    this.readyPromise = new Promise<void>(resolve => {
      const onReady = (ev: MessageEvent<WorkerIncoming>) => {
        if (ev.data.kind === 'worker_ready') {
          this.worker.removeEventListener('message', onReady);
          resolve();
        }
      };
      this.worker.addEventListener('message', onReady);
    });

    this.initPromise = new Promise<void>((resolve, reject) => {
      this.resolveInit = resolve;
      this.rejectInit = reject;
    });
  }

  // ==========================================================================
  // Transport
  // ==========================================================================

  /**
   * Post the storage config to the worker via the out-of-band
   * `worker_config` envelope. Must be called before `init` — the worker
   * stashes the config on its `GremlinServer` instance and reads it
   * inside the `init` handler when constructing the deferred-mode
   * `BackendDeps` bundle. Awaits the worker_ready handshake so the
   * envelope arrives in order.
   */
  async configureWorker(storageConfig: StorageConfig): Promise<void> {
    await this.readyPromise;
    this.send({ kind: 'worker_config', storageConfig });
  }

  async request<M extends keyof GremlinMethods>(
    method: M,
    params: MethodParams<M>
  ): Promise<MethodResult<M>> {
    await this.readyPromise;
    if (method !== 'init') {
      // Block every other RPC until `init` returns successfully.
      await this.initPromise;
    }
    const requestId = `req_${++this.requestCounter}`;
    return new Promise<MethodResult<M>>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve: v => {
          resolve(v as MethodResult<M>);
          // First successful `init` unblocks the queue.
          if (method === 'init' && this.resolveInit) {
            const r = this.resolveInit;
            this.resolveInit = null;
            this.rejectInit = null;
            r();
          }
        },
        reject: err => {
          reject(err);
          if (method === 'init' && this.rejectInit) {
            const r = this.rejectInit;
            this.rejectInit = null;
            this.resolveInit = null;
            r(err);
          }
        },
      });
      this.send({ kind: 'request', requestId, method, params });
    });
  }

  async *stream<M extends keyof GremlinMethods>(
    method: M,
    params: MethodParams<M>
  ): AsyncGenerator<StreamEventEnvelope<M> | StreamEndEnvelope, void, void> {
    await this.readyPromise;
    await this.initPromise;
    const requestId = `req_${++this.requestCounter}`;
    const queue: (StreamEventEnvelope | StreamEndEnvelope)[] = [];
    let resolveNext: (() => void) | null = null;
    let streamError: Error | null = null;
    let ended = false;

    this.pendingStreams.set(requestId, {
      push: env => {
        queue.push(env);
        if (env.kind === 'stream_end') {
          ended = true;
        }
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r();
        }
      },
      reject: err => {
        streamError = err;
        ended = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r();
        }
      },
    });

    this.send({ kind: 'request', requestId, method, params });

    try {
      while (true) {
        if (queue.length > 0) {
          const env = queue.shift()!;
          yield env as StreamEventEnvelope<M> | StreamEndEnvelope;
          if (env.kind === 'stream_end') {
            return;
          }
          continue;
        }
        if (streamError) {
          throw streamError;
        }
        if (ended) {
          return;
        }
        await new Promise<void>(resolve => {
          resolveNext = resolve;
        });
      }
    } finally {
      this.pendingStreams.delete(requestId);
      // If the consumer broke out of the loop early (e.g. they aborted on
      // their side), tell the worker so it can stop generating events.
      if (!ended) {
        this.send({ kind: 'stream_cancel', requestId });
      }
    }
  }

  // ==========================================================================
  // Message dispatch
  // ==========================================================================

  private handleMessage = (ev: MessageEvent<WorkerIncoming>): void => {
    const msg = ev.data;
    switch (msg.kind) {
      case 'response': {
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          this.pendingRequests.delete(msg.requestId);
          pending.resolve(msg.result);
        }
        return;
      }
      case 'error': {
        const err = new ProtocolError(msg.code, msg.message, msg.data);
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          this.pendingRequests.delete(msg.requestId);
          pending.reject(err);
          return;
        }
        const stream = this.pendingStreams.get(msg.requestId);
        if (stream) {
          stream.reject(err);
        }
        return;
      }
      case 'stream_event':
      case 'stream_end': {
        const stream = this.pendingStreams.get(msg.requestId);
        if (stream) {
          stream.push(msg);
        }
        return;
      }
      case 'worker_ready':
        // Handled by the one-shot listener registered in the constructor.
        return;
    }
  };

  private send(msg: WorkerOutgoing): void {
    this.worker.postMessage(msg);
  }

  /** Tear down the worker; useful in tests. */
  dispose(): void {
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.terminate();
  }
}
