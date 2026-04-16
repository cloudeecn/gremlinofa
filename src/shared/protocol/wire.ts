/**
 * Wire-level envelopes shared by every transport (in-process, worker, future
 * WebSocket). The same envelope shape is used for one-shot methods and stream
 * methods; only the response side differs.
 *
 * Envelopes carry a `requestId` so the client can correlate responses with
 * in-flight calls. Stream methods receive a sequence of envelopes (zero or
 * more `stream_event`, then exactly one `stream_end` or `error`). One-shot
 * methods receive exactly one `response` or `error`.
 */

import type { ProtocolErrorCode } from './errors';
import type { GremlinMethods } from './methods';

// ============================================================================
// Identifiers
// ============================================================================

/** Stable id minted by the backend at the start of a loop run. */
export type LoopId = string;

/**
 * Stable id assigned to each connected client/session. The Active Loops UI
 * uses this to attribute "Aborted by ..." messages, and Phase 2 multi-tab
 * subscribers use it as the cross-tab subscription key.
 */
export type SubscriberId = string;

/** Sequence number for stream events on a single LoopId. Monotonic per loop. */
export type SeqNo = number;

// ============================================================================
// Envelopes (wire format)
// ============================================================================

/**
 * Client → server: an RPC call. The same envelope shape is used for one-shot
 * methods and stream methods; the response shape is what differs.
 */
export interface RequestEnvelope<M extends keyof GremlinMethods = keyof GremlinMethods> {
  kind: 'request';
  requestId: string;
  method: M;
  params: GremlinMethods[M]['params'];
}

/**
 * Server → client: terminal one-shot result for an RPC call. Stream methods
 * never use this — they emit `stream_event` then `stream_end`.
 */
export interface ResponseEnvelope<M extends keyof GremlinMethods = keyof GremlinMethods> {
  kind: 'response';
  requestId: string;
  result: GremlinMethods[M]['result'];
}

/**
 * Server → client: one event in a streaming RPC. Carries a `seq` so Phase 2
 * subscribers can replay from a known point after reconnecting.
 */
export interface StreamEventEnvelope<M extends keyof GremlinMethods = keyof GremlinMethods> {
  kind: 'stream_event';
  requestId: string;
  seq: SeqNo;
  event: GremlinMethods[M]['streams'];
}

/** Server → client: terminal stream end with a status. */
export interface StreamEndEnvelope {
  kind: 'stream_end';
  requestId: string;
  status: StreamEndStatus;
  /** Optional human-readable detail (e.g. "Aborted by Alice"). */
  detail?: string;
}

/** Possible terminal statuses for any streaming method. */
export type StreamEndStatus = 'complete' | 'error' | 'aborted' | 'soft_stopped' | 'max_iterations';

/** Server → client: one-shot error response (or stream that errored before any events). */
export interface ErrorEnvelope {
  kind: 'error';
  requestId: string;
  code: ProtocolErrorCode;
  message: string;
  /** Provider-specific or method-specific extra context, JSON-safe. */
  data?: unknown;
}

/** Union of every server → client envelope. */
export type ServerEnvelope =
  | ResponseEnvelope
  | StreamEventEnvelope
  | StreamEndEnvelope
  | ErrorEnvelope;

/** Union of every client → server envelope. */
export type ClientEnvelope = RequestEnvelope;

// ============================================================================
// Helpers (compile-time only)
// ============================================================================

/** Convenience: extract the params type for a given method name. */
export type MethodParams<M extends keyof GremlinMethods> = GremlinMethods[M]['params'];
/** Convenience: extract the one-shot result type for a given method name. */
export type MethodResult<M extends keyof GremlinMethods> = GremlinMethods[M]['result'];
/** Convenience: extract the stream event type for a given method name. */
export type MethodStreamEvent<M extends keyof GremlinMethods> = GremlinMethods[M]['streams'];

/** Discriminator helper for narrowing `ServerEnvelope`. */
export function isStreamEvent<M extends keyof GremlinMethods>(
  env: ServerEnvelope
): env is StreamEventEnvelope<M> {
  return env.kind === 'stream_event';
}
