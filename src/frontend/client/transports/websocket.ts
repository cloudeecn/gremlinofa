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

/** Init failures that are terminal for this transport's credentials. */
function isAuthFailure(err: ProtocolError): boolean {
  return err.code === 'CEK_MISMATCH' || err.code === 'CEK_REQUIRED';
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 2_000;
// Generous timeouts: the server runs synchronous better-sqlite3 work during
// imports and can legitimately stall past 5s without the socket being dead.
const HEARTBEAT_TIMEOUT_MS = 15_000;
/** Show "stale" banner when no pong for this long — warns user before full disconnect. */
const STALE_THRESHOLD_MS = 8_000;

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
  private rejectConnect!: (err: Error) => void;

  /** Whether `dispose()` was called — suppresses reconnect. */
  private disposed = false;

  /**
   * Terminal auth failure (CEK_MISMATCH / CEK_REQUIRED): the stored key is
   * wrong, reconnecting cannot help. Suppresses reconnect like `disposed`.
   */
  private authFailed = false;

  /** Current backoff delay for reconnect. */
  private backoffMs = INITIAL_BACKOFF_MS;

  /** Heartbeat timer ids. */
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Whether the first connection has been established (gates non-init RPCs). */
  private firstConnected = false;
  private initPromise: Promise<void>;
  private resolveInit: (() => void) | null = null;
  private rejectInit: ((err: Error) => void) | null = null;

  /**
   * Maps requestId → original envelope so in-flight one-shots can be
   * re-sent after a reconnect. An entry lives here until its
   * `pendingRequests` promise settles — never dropped on disconnect, so a
   * request survives any number of connection drops.
   */
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
    this.connectPromise = this.createConnectGate();
    this.initPromise = this.createInitGate();
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

  /**
   * Build a fresh connect gate. The detached `.catch` keeps a failed
   * connection (e.g. malformed URL) from surfacing as an unhandled promise
   * rejection when no RPC is awaiting it.
   */
  private createConnectGate(): Promise<void> {
    const gate = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    gate.catch(() => {});
    return gate;
  }

  /** Build a fresh init gate; same unhandled-rejection note as above. */
  private createInitGate(): Promise<void> {
    const gate = new Promise<void>((resolve, reject) => {
      this.resolveInit = resolve;
      this.rejectInit = reject;
    });
    gate.catch(() => {});
    return gate;
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
          if (method === 'init') {
            if (err instanceof ProtocolError && isAuthFailure(err)) {
              this.enterAuthFailed(err);
            } else if (this.rejectInit) {
              // Fail queued waiters fast, then re-arm the gate so a
              // retried `init` in the same session isn't poisoned.
              const r = this.rejectInit;
              this.rejectInit = null;
              this.resolveInit = null;
              r(err);
              this.initPromise = this.createInitGate();
            }
          }
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

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      // Malformed URL — permanent, reconnecting can't fix it. Reject the
      // connect gate so every RPC fails with a real error instead of the
      // constructor throw blanking the page.
      this.setConnectionState('disconnected');
      this.rejectConnect(
        new Error(
          `Invalid WebSocket URL '${this.url}': ${err instanceof Error ? err.message : String(err)}`
        )
      );
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.setConnectionState('connected');

      const isReconnect = this.firstConnected;
      this.firstConnected = true;

      this.resolveConnect();
      this.startHeartbeat();

      if (!isReconnect) return;

      // Close the init gate so RPCs issued from reconnect callbacks block
      // until this socket has re-authenticated.
      this.initPromise = this.createInitGate();

      if (this.lastInitParams) {
        // Re-issue init strictly BEFORE anything else — the server's
        // per-connection auth gate rejects (and closes 4001) any
        // non-exempt frame arriving before this socket's own successful
        // init. Callbacks and replays run from its resolve handler.
        this.sendReplayInit(this.lastInitParams);
      } else {
        // Never successfully inited (e.g. dropped mid-OOBE). Only exempt
        // requests and a user-driven `init` can be in flight — non-exempt
        // calls are still parked on the init gate. Replay them directly.
        this.replayPending();
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
      if (this.authFailed) return; // enterAuthFailed already settled everything
      this.setConnectionState('disconnected');
      this.rejectInflight();
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // Error is followed by close — cleanup happens there
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.authFailed) return;

    // Reset the connect promise for the next connection attempt
    this.connectPromise = this.createConnectGate();

    this.setConnectionState('reconnecting');

    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    setTimeout(() => this.connect(), delay);
  }

  /**
   * Handle in-flight RPCs on disconnect. One-shot requests stay in both
   * `pendingRequests` and `inflightEnvelopes` — `replayPending()` re-sends
   * them after re-auth, however many disconnects it takes. Streams are
   * terminated — they can't be transparently restarted.
   */
  private rejectInflight(): void {
    // Drop internal replay-init entries (they're not in inflightEnvelopes
    // and nobody holds their promise) — the next reconnect sends a fresh
    // one from lastInitParams.
    for (const id of this.pendingRequests.keys()) {
      if (!this.inflightEnvelopes.has(id)) {
        this.pendingRequests.delete(id);
      }
    }

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

  /**
   * Re-send every registered in-flight envelope on the fresh socket. The
   * original callers' resolve/reject callbacks are still in
   * `pendingRequests`, so the responses settle the original promises.
   */
  private replayPending(): void {
    for (const envelope of this.inflightEnvelopes.values()) {
      this.send(envelope);
    }
  }

  /**
   * Re-authenticate a reconnected socket with the saved init params. The
   * envelope is internal — deliberately NOT in `inflightEnvelopes`, since
   * it is derived state, not an original caller's request.
   */
  private sendReplayInit(params: Record<string, unknown>): void {
    const requestId = `req_${++this.requestCounter}`;
    this.pendingRequests.set(requestId, {
      resolve: () => {
        // Order matters: open the gate, let sessions re-attach, then
        // replay one-shots — all strictly after the server marked this
        // socket authenticated.
        if (this.resolveInit) {
          const r = this.resolveInit;
          this.resolveInit = null;
          this.rejectInit = null;
          r();
        }
        for (const cb of this.reconnectCallbacks) {
          try {
            cb();
          } catch {
            // reconnect handlers should not throw
          }
        }
        this.replayPending();
      },
      reject: err => {
        if (err instanceof ProtocolError && isAuthFailure(err)) {
          this.enterAuthFailed(err);
          return;
        }
        // Transient (e.g. server restarting mid-handshake) — close and let
        // the normal backoff retry; pendings stay registered.
        this.ws?.close();
      },
    });
    this.send({ kind: 'request', requestId, method: 'init', params });
  }

  /**
   * Terminal auth failure: the server rejected our CEK. Fail everything
   * fast and stop reconnecting — a retry with the same key can only 4001
   * again. Recovery is a transport rebind (or reload) with a new key.
   */
  private enterAuthFailed(err: Error): void {
    if (this.authFailed) return;
    this.authFailed = true;
    this.setConnectionState('auth_failed');

    if (this.rejectInit) {
      const r = this.rejectInit;
      this.rejectInit = null;
      this.resolveInit = null;
      r(err);
    }
    // Leave the gate rejected so later non-exempt RPCs fail fast instead
    // of hanging (the detached .catch suppresses unhandled-rejection).
    const rejected = Promise.reject(err);
    rejected.catch(() => {});
    this.initPromise = rejected;

    for (const pending of this.pendingRequests.values()) {
      pending.reject(err);
    }
    this.pendingRequests.clear();
    this.inflightEnvelopes.clear();
    for (const [id, stream] of this.pendingStreams) {
      this.pendingStreams.delete(id);
      stream.reject(err);
    }
    this.ws?.close();
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

  /** Tear down the transport; suppresses reconnect and settles pendings. */
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
    const err = new Error('transport disposed');
    for (const pending of this.pendingRequests.values()) {
      pending.reject(err);
    }
    this.pendingRequests.clear();
    this.inflightEnvelopes.clear();
    for (const [id, stream] of this.pendingStreams) {
      this.pendingStreams.delete(id);
      stream.reject(err);
    }
  }
}
