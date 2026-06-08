/**
 * Transport interface — the wire-level contract every transport
 * implementation honors. Lives in `src/shared/protocol/` (not in
 * `src/shared/engine/`) so the frontend client can import it without
 * crossing into the engine layer. Phase 1.7 hoist.
 *
 * Implementations:
 *   - `src/shared/engine/transports/inProcess.ts` — staging + tests
 *   - `src/frontend/client/transports/worker.ts` — production
 *   - Phase 2: WebSocket transport
 *
 * `request` is for one-shot RPCs. `stream` returns an async iterable that
 * yields stream events and ends with a `StreamEndEnvelope` (or throws on
 * error).
 *
 * `configureWorker` is the out-of-band worker bootstrap channel. The main
 * thread reads its `StorageConfig` from localStorage (the only place that
 * touches it) and posts it via this method before the typed `init({cek})`
 * request. Only the worker transport implements it — the in-process
 * transport (used by tests) ignores the call because the test stub
 * bundles adapters directly into `BackendDeps`. The future websocket
 * transport will source its adapter from env vars on the server side.
 *
 * Phase 1.5: split storage config out of `InitParams` so the typed
 * protocol stays narrow while still letting workers source their adapter
 * selection from main-thread localStorage.
 */

import type { StorageConfig } from './types/storageConfig';
import type { GremlinMethods } from './methods';
import type { MethodParams, MethodResult, StreamEndEnvelope, StreamEventEnvelope } from './wire';

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'stale'
  | 'disconnected'
  | 'reconnecting';

export interface Transport {
  request<M extends keyof GremlinMethods>(
    method: M,
    params: MethodParams<M>
  ): Promise<MethodResult<M>>;
  stream<M extends keyof GremlinMethods>(
    method: M,
    params: MethodParams<M>
  ): AsyncIterable<StreamEventEnvelope<M> | StreamEndEnvelope>;
  configureWorker?(config: StorageConfig): Promise<void>;
  /**
   * Register a callback invoked after the transport reconnects (WebSocket
   * only). `GremlinSession` uses this to re-issue `init` and re-attach
   * active chats after a connection drop.
   */
  onReconnect?(callback: () => void): () => void;
  /** Current connection state. Only meaningful for WebSocket transport. */
  connectionState?: ConnectionState;
  /** Subscribe to connection state changes. Returns unsubscribe function. */
  onConnectionStateChange?(callback: (state: ConnectionState) => void): () => void;
}
