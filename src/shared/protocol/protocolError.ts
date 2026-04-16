/**
 * Typed protocol error.
 *
 * Carries a stable string `code` from `ProtocolErrorCode` so callers can
 * branch on the error kind without parsing messages. The transport layer
 * wraps this into an `ErrorEnvelope` for the wire.
 *
 * Lives in its own module so helpers (`assertNoLoopsRunning`,
 * `ChatRunner`, ...) can import it without a circular dependency on
 * `GremlinServer.ts`.
 */

import type { ProtocolErrorCode } from './errors';

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly data?: unknown;

  constructor(code: ProtocolErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.data = data;
  }
}
