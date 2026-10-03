/**
 * Web Worker transport for `GremlinClient`.
 *
 * The main thread spawns the worker, waits for the one-shot `worker_ready`
 * signal, and then communicates with the worker via the standard protocol
 * envelopes (`request`, `response`, `stream_event`, `stream_end`, `error`).
 *
 * The transport queues every RPC outside `INIT_EXEMPT_METHODS` until
 * `init` has succeeded — the worker rejects everything else with
 * `code: 'NOT_INITIALIZED'` before that point. The exempt set (defined in
 * `shared/protocol/methods`) covers `init` itself plus the dormant-callable
 * CEK helpers that OOBE invokes before the worker has been initialized.
 * The bootstrap is purely the protocol's `init` method; no localStorage
 * snapshot is posted across the boundary.
 *
 * Phase 2 will swap this for `WebSocketTransport`. The wire format and the
 * `Transport` interface are the same — only the framing changes.
 */

import {
  INIT_EXEMPT_METHODS,
  type ErrorEnvelope,
  type GremlinMethods,
  type MethodParams,
  type MethodResult,
  type RequestEnvelope,
  type ResponseEnvelope,
  type StreamEndEnvelope,
  type StreamEventEnvelope,
  type Transport,
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
  /** Fails the ready gate; null once it settled. */
  private rejectReady: ((err: Error) => void) | null = null;
  /** Resolves once `init` has been awaited successfully. */
  private initPromise: Promise<void>;
  private resolveInit: (() => void) | null = null;
  private rejectInit: ((err: Error) => void) | null = null;

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleError);
    this.worker.addEventListener('messageerror', this.handleMessageError);

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.rejectReady = reject;
      const onReady = (ev: MessageEvent<WorkerIncoming>) => {
        if (ev.data.kind === 'worker_ready') {
          this.worker.removeEventListener('message', onReady);
          this.rejectReady = null;
          resolve();
        }
      };
      this.worker.addEventListener('message', onReady);
    });
    // Same unhandled-rejection guard as the init gate
    this.readyPromise.catch(() => {});

    this.initPromise = this.createInitGate();
  }

  /**
   * Build a fresh init gate. The detached `.catch` keeps a failed init from
   * surfacing as an unhandled promise rejection when no non-exempt RPC
   * happens to be awaiting the gate at that moment.
   */
  private createInitGate(): Promise<void> {
    const gate = new Promise<void>((resolve, reject) => {
      this.resolveInit = resolve;
      this.rejectInit = reject;
    });
    gate.catch(() => {});
    return gate;
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
    if (!INIT_EXEMPT_METHODS.has(method as string)) {
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
            // Re-arm the gate so a retried `init` (e.g. the user fixing
            // their OOBE input) isn't poisoned by this failure — without
            // this, every later stream()/request() replays the stale error.
            this.initPromise = this.createInitGate();
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

  /**
   * Before `worker_ready`, an error event means the worker script never ran
   * (chunk 404, parse error, throw during module eval): fail every caller
   * instead of leaving boot waiting forever. After it, the error is an
   * uncaught exception in a running worker; its requests settle on their own.
   */
  private handleError = (ev: Event): void => {
    const { message, filename, lineno } = ev as Partial<ErrorEvent>;
    if (this.rejectReady) {
      const reject = this.rejectReady;
      this.rejectReady = null;
      const where = filename ? ` (${filename}:${lineno ?? 0})` : '';
      reject(
        new Error(`Backend worker failed to start: ${message || 'script failed to load'}${where}`)
      );
      return;
    }
    console.error('[WorkerTransport] Uncaught error in the backend worker:', message);
  };

  /** A reply that can't be deserialized is lost, and its caller with it. */
  private handleMessageError = (): void => {
    console.error('[WorkerTransport] A message from the backend worker could not be deserialized');
  };

  private send(msg: WorkerOutgoing): void {
    this.worker.postMessage(msg);
  }

  /** Tear down the worker; used by transport rebind and tests. */
  dispose(): void {
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleError);
    this.worker.removeEventListener('messageerror', this.handleMessageError);
    this.worker.terminate();
    const err = new Error('transport disposed');
    // Callers still parked on a gate aren't in pendingRequests yet
    if (this.rejectReady) {
      const reject = this.rejectReady;
      this.rejectReady = null;
      reject(err);
    }
    if (this.rejectInit) {
      const reject = this.rejectInit;
      this.rejectInit = null;
      this.resolveInit = null;
      reject(err);
    }
    for (const pending of this.pendingRequests.values()) {
      pending.reject(err);
    }
    this.pendingRequests.clear();
    for (const stream of this.pendingStreams.values()) {
      stream.reject(err);
    }
    this.pendingStreams.clear();
  }
}
