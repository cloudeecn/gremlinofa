/**
 * WebSocket transport for `GremlinClient`.
 *
 * Connects to the Node server over a WebSocket and communicates using the
 * same protocol envelopes as `WorkerTransport`. Implements auto-reconnect
 * with exponential backoff, heartbeat ping/pong, and an `onReconnect`
 * callback so `GremlinSession` can re-attach chats after a connection drop.
 *
 * `configureWorker` is a no-op — the server reads its storage config from
 * env vars, not from the client.
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
import type { ConnectionState } from '../../../shared/protocol/transport';
import { binaryReplacer, binaryReviver } from '../../../shared/protocol/binaryEncoding';
import { ProtocolError } from '../../../shared/protocol/protocolError';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingStream {
  push: (envelope: StreamEventEnvelope | StreamEndEnvelope) => void;
  reject: (error: Error) => void;
}

type ServerMessage = ResponseEnvelope | StreamEventEnvelope | StreamEndEnvelope | ErrorEnvelope;

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 2_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
/** Show "stale" banner when no pong for this long — warns user before full disconnect. */
const STALE_THRESHOLD_MS = 4_000;

export class WebSocketTransport implements Transport {
  private readonly url: string;
  private ws: WebSocket | null = null;
  private requestCounter = 0;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly pendingStreams = new Map<string, PendingStream>();
  private reconnectCallbacks: Array<() => void> = [];

  /** Resolves when the current WebSocket connection is open. */
  private connectPromise: Promise<void>;
  private resolveConnect!: () => void;

  /** Whether `dispose()` was called — suppresses reconnect. */
  private disposed = false;

  /** Current backoff delay for reconnect. */
  private backoffMs = INITIAL_BACKOFF_MS;

  /** Heartbeat timer ids. */
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Whether the first connection has been established (gates non-init RPCs). */
  private firstConnected = false;
  private initPromise: Promise<void>;
  private resolveInit: (() => void) | null = null;

  /** One-shot requests queued for retry after reconnect. */
  private retryQueue: RequestEnvelope[] = [];
  /** Maps requestId → original envelope so we can re-send on reconnect. */
  private readonly inflightEnvelopes = new Map<string, RequestEnvelope>();
  /** Saved init params — replayed on reconnect to unblock the init gate. */
  private lastInitParams: Record<string, unknown> | null = null;

  /** Observable connection state. */
  private _connectionState: ConnectionState = 'connecting';
  private connectionStateCallbacks: Array<(state: ConnectionState) => void> = [];
  /** Timestamp of the last received server message (pong or data). */
  private lastMessageAt = 0;

  /** Bound visibility handler — stored for cleanup in `dispose()`. */
  private handleVisibilityChange: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    this.connectPromise = new Promise<void>(r => {
      this.resolveConnect = r;
    });
    this.initPromise = new Promise<void>(r => {
      this.resolveInit = r;
    });
    this.connect();

    if (typeof document !== 'undefined') {
      this.handleVisibilityChange = () => {
        if (document.visibilityState !== 'visible') return;
        if (this._connectionState === 'disconnected' || this._connectionState === 'reconnecting') {
          // Already handling reconnect — reset backoff so it retries fast
          this.backoffMs = INITIAL_BACKOFF_MS;
          return;
        }
        // Tab just became visible — check for time leaps (app switch / sleep).
        // The OS may have frozen the tab for seconds or minutes; the socket
        // might still report OPEN but be dead.
        if (this.lastMessageAt > 0 && Date.now() - this.lastMessageAt > STALE_THRESHOLD_MS) {
          this.setConnectionState('stale');
        }
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ kind: 'ping' }));
          if (!this.heartbeatTimeout) {
            this.heartbeatTimeout = setTimeout(() => {
              this.ws?.close();
            }, HEARTBEAT_TIMEOUT_MS);
          }
        }
      };
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  // ==========================================================================
  // Transport interface
  // ==========================================================================

  async configureWorker(_config?: unknown): Promise<void> {
    // No-op — server reads config from env, not from client.
  }

  async request<M extends keyof GremlinMethods>(
    method: M,
    params: MethodParams<M>
  ): Promise<MethodResult<M>> {
    await this.connectPromise;
    if (!INIT_EXEMPT_METHODS.has(method as string)) {
      await this.initPromise;
    }

    const requestId = `req_${++this.requestCounter}`;
    const envelope: RequestEnvelope = { kind: 'request', requestId, method, params };
    return new Promise<MethodResult<M>>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve: v => {
          this.inflightEnvelopes.delete(requestId);
          resolve(v as MethodResult<M>);
          if (method === 'init') {
            this.lastInitParams = params as Record<string, unknown>;
            if (this.resolveInit) {
              const r = this.resolveInit;
              this.resolveInit = null;
              r();
            }
          }
        },
        reject: err => {
          this.inflightEnvelopes.delete(requestId);
          reject(err);
        },
      });
      this.inflightEnvelopes.set(requestId, envelope);
      this.send(envelope);
    });
  }

  async *stream<M extends keyof GremlinMethods>(
    method: M,
    params: MethodParams<M>
  ): AsyncGenerator<StreamEventEnvelope<M> | StreamEndEnvelope, void, void> {
    await this.connectPromise;
    await this.initPromise;

    const requestId = `req_${++this.requestCounter}`;
    const queue: (StreamEventEnvelope | StreamEndEnvelope)[] = [];
    let resolveNext: (() => void) | null = null;
    let streamError: Error | null = null;
    let ended = false;

    this.pendingStreams.set(requestId, {
      push: env => {
        queue.push(env);
        if (env.kind === 'stream_end') ended = true;
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
          if (env.kind === 'stream_end') return;
          continue;
        }
        if (streamError) throw streamError;
        if (ended) return;
        await new Promise<void>(resolve => {
          resolveNext = resolve;
        });
      }
    } finally {
      this.pendingStreams.delete(requestId);
      if (!ended) {
        this.send({ kind: 'stream_cancel', requestId });
      }
    }
  }

  onReconnect(callback: () => void): () => void {
    this.reconnectCallbacks.push(callback);
    return () => {
      const idx = this.reconnectCallbacks.indexOf(callback);
      if (idx >= 0) this.reconnectCallbacks.splice(idx, 1);
    };
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  onConnectionStateChange(callback: (state: ConnectionState) => void): () => void {
    this.connectionStateCallbacks.push(callback);
    return () => {
      const idx = this.connectionStateCallbacks.indexOf(callback);
      if (idx >= 0) this.connectionStateCallbacks.splice(idx, 1);
    };
  }

  private setConnectionState(state: ConnectionState): void {
    if (this._connectionState === state) return;
    this._connectionState = state;
    for (const cb of this.connectionStateCallbacks) {
      try {
        cb(state);
      } catch {
        // state callbacks should not throw
      }
    }
  }

  // ==========================================================================
  // Connection management
  // ==========================================================================

  private connect(): void {
    if (this.disposed) return;

    if (this.firstConnected) {
      this.setConnectionState('reconnecting');
    }

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.setConnectionState('connected');

      const isReconnect = this.firstConnected;
      if (!this.firstConnected) {
        this.firstConnected = true;
      }

      this.resolveConnect();
      this.startHeartbeat();

      if (isReconnect) {
        // Reset the init gate so non-init RPCs block until init completes.
        this.initPromise = new Promise<void>(r => {
          this.resolveInit = r;
        });
        // Re-issue init before anything else — the server is idempotent
        // with the same CEK. Without this, every RPC blocks on the init
        // gate forever and the page goes blank.
        if (this.lastInitParams) {
          const initEnvelope: RequestEnvelope = {
            kind: 'request',
            requestId: `req_${++this.requestCounter}`,
            method: 'init',
            params: this.lastInitParams,
          };
          this.pendingRequests.set(initEnvelope.requestId, {
            resolve: () => {
              if (this.resolveInit) {
                const r = this.resolveInit;
                this.resolveInit = null;
                r();
              }
            },
            reject: () => {
              // init failed on reconnect — not much we can do
            },
          });
          this.send(initEnvelope);
        }
        for (const cb of this.reconnectCallbacks) {
          try {
            cb();
          } catch {
            // reconnect handlers should not throw
          }
        }
        // Replay queued one-shot requests that were in-flight when the
        // connection dropped. Their resolve/reject callbacks are still in
        // pendingRequests, so responses will reach the original callers.
        const queued = this.retryQueue.splice(0);
        for (const envelope of queued) {
          this.send(envelope);
        }
      }
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      this.onPong();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(
          typeof ev.data === 'string' ? ev.data : String(ev.data),
          binaryReviver
        ) as ServerMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    });

    ws.addEventListener('close', () => {
      this.stopHeartbeat();
      this.setConnectionState('disconnected');
      this.rejectInflight();
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // Error is followed by close — cleanup happens there
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;

    // Reset the connect promise for the next connection attempt
    this.connectPromise = new Promise<void>(r => {
      this.resolveConnect = r;
    });

    this.setConnectionState('reconnecting');

    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    setTimeout(() => this.connect(), delay);
  }

  /**
   * Handle in-flight RPCs on disconnect. One-shot requests are queued for
   * retry after reconnect (the caller's promise stays pending). Streams
   * are terminated — they can't be transparently restarted.
   */
  private rejectInflight(): void {
    // Re-queue pending one-shot requests for retry after reconnect.
    // The pendingRequests map keeps the resolve/reject callbacks alive so
    // the caller's promise resolves once the retried request completes.
    for (const [id] of this.pendingRequests) {
      const envelope = this.inflightEnvelopes.get(id);
      if (envelope) {
        this.retryQueue.push(envelope);
        this.inflightEnvelopes.delete(id);
      }
    }
    // Don't delete from pendingRequests — the callbacks stay until the
    // retried response arrives.

    for (const [id, stream] of this.pendingStreams) {
      this.pendingStreams.delete(id);
      stream.push({
        kind: 'stream_end',
        requestId: id,
        status: 'error',
        detail: 'transport disconnected',
      });
    }
  }

  // ==========================================================================
  // Heartbeat
  // ==========================================================================

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastMessageAt = Date.now();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ kind: 'ping' }));
        // Only arm the dead-connection timeout if one isn't already ticking.
        // Without this guard, stacked timeouts accumulate when pongs stop
        // arriving (each 2s tick would add another 5s timer).
        if (!this.heartbeatTimeout) {
          this.heartbeatTimeout = setTimeout(() => {
            this.ws?.close();
          }, HEARTBEAT_TIMEOUT_MS);
        }
        if (Date.now() - this.lastMessageAt > STALE_THRESHOLD_MS) {
          this.setConnectionState('stale');
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  /** Any incoming message resets the pong timeout and clears stale state. */
  private onPong(): void {
    this.lastMessageAt = Date.now();
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
    if (this._connectionState === 'stale') {
      this.setConnectionState('connected');
    }
  }

  // ==========================================================================
  // Message dispatch
  // ==========================================================================

  private handleMessage(msg: ServerMessage): void {
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
    }
  }

  private send(
    msg: RequestEnvelope | { kind: 'stream_cancel'; requestId: string } | { kind: 'ping' }
  ): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg, binaryReplacer));
    }
  }

  /** Tear down the transport; suppresses reconnect. */
  dispose(): void {
    this.disposed = true;
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.reconnectCallbacks = [];
    this.connectionStateCallbacks = [];
    if (this.handleVisibilityChange) {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
      this.handleVisibilityChange = null;
    }
  }
}
