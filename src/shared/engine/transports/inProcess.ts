/**
 * In-process transport between `GremlinClient` and `GremlinServer`.
 *
 * Phase 1's staging transport: zero serialization, the client and server
 * live in the same JavaScript context and share object references. This is
 * useful for two reasons:
 *
 *   1. **Internal staging.** Lets us land the boundary contract first and
 *      defer the worker hop to a later PR — both sides talk over the same
 *      `Transport` interface today, and the worker swap in PR 13 only
 *      changes which transport implementation `GremlinClient` is wired to.
 *   2. **Tests.** The contract suite drives this transport directly, so we
 *      can run end-to-end RPC tests against a mocked `UnifiedStorage` with
 *      no serialization or worker spinup.
 *
 * The transport is intentionally dumb — it just forwards calls to the
 * server's `handleRequest` / `handleStream`. All the actual logic lives in
 * `GremlinServer`.
 */

import { GremlinServer } from '../GremlinServer';
import { ProtocolError } from '../../protocol/protocolError';
import type {
  ErrorEnvelope,
  GremlinMethods,
  MethodParams,
  MethodResult,
  StreamEndEnvelope,
  StreamEndStatus,
  StreamEventEnvelope,
  Transport,
} from '../../protocol/protocol';

// `Transport` lives in `src/shared/protocol/transport.ts` (Phase 1.7 hoist)
// so the frontend client can import it without crossing into the engine
// layer. Re-exported here for backward compatibility with existing engine
// internals that already imported from this file.
export type { Transport };

/**
 * Drives a `GremlinServer` directly with no serialization. The server can
 * be created externally (e.g. with a mocked `UnifiedStorage` for tests) or
 * via the `index.ts` factory.
 */
export class InProcessTransport implements Transport {
  private requestCounter = 0;
  readonly server: GremlinServer;

  constructor(server: GremlinServer) {
    this.server = server;
  }

  async request<M extends keyof GremlinMethods>(
    method: M,
    params: MethodParams<M>
  ): Promise<MethodResult<M>> {
    try {
      return await this.server.handleRequest(method, params);
    } catch (err) {
      throw normalizeError(err);
    }
  }

  async *stream<M extends keyof GremlinMethods>(
    method: M,
    params: MethodParams<M>
  ): AsyncGenerator<StreamEventEnvelope<M> | StreamEndEnvelope, void, void> {
    const requestId = `req_${++this.requestCounter}`;
    let status: StreamEndStatus = 'complete';
    let detail: string | undefined;
    let seq = 0;
    try {
      const gen = this.server.handleStream(method, params);
      for await (const event of gen) {
        const envelope: StreamEventEnvelope<M> = {
          kind: 'stream_event',
          requestId,
          seq: seq++,
          event,
        };
        yield envelope;
      }
    } catch (err) {
      status = 'error';
      const wrapped = normalizeError(err);
      detail = wrapped.message;
      // Re-throw so the caller's `for await` rejects with the typed error
      // instead of just seeing a `stream_end` with status:'error' and no
      // way to inspect the cause.
      const endEnvelope: StreamEndEnvelope = {
        kind: 'stream_end',
        requestId,
        status,
        detail,
      };
      yield endEnvelope;
      throw wrapped;
    }
    const endEnvelope: StreamEndEnvelope = {
      kind: 'stream_end',
      requestId,
      status,
      detail,
    };
    yield endEnvelope;
  }
}

/**
 * Synthesize an `ErrorEnvelope` from any thrown value so transports can
 * carry it across the wire (Phase 2 — for now we just throw it through
 * since we're in-process). Exported for tests.
 */
export function toErrorEnvelope(requestId: string, err: unknown): ErrorEnvelope {
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
 * Convert any thrown value into a `ProtocolError`. The in-process transport
 * just lets the original error escape, so we keep the message and stack —
 * but we wrap raw Errors as `INTERNAL_ERROR` so callers can switch on
 * `.code` uniformly.
 */
function normalizeError(err: unknown): ProtocolError {
  if (err instanceof ProtocolError) return err;
  if (err instanceof Error) {
    return new ProtocolError('INTERNAL_ERROR', err.message);
  }
  return new ProtocolError('INTERNAL_ERROR', String(err));
}
