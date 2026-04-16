/**
 * Protocol error codes — stable string codes the client can branch on
 * without parsing messages.
 *
 * Open-ended `(string & {})` for forward compatibility with new providers
 * and methods. The carrier exception (`ProtocolError`) lives in
 * `./protocolError` so helpers (`assertNoLoopsRunning`, `ChatRunner`, ...)
 * can construct it without a circular dependency on the dispatcher.
 */
export type ProtocolErrorCode =
  | 'NOT_INITIALIZED'
  | 'ALREADY_INITIALIZED'
  | 'CEK_MISMATCH'
  | 'CHAT_BUSY'
  | 'CHAT_INCOMPLETE_TAIL'
  | 'CHAT_NOT_FOUND'
  | 'LOOP_NOT_FOUND'
  | 'LOOPS_RUNNING'
  | 'METHOD_NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'INTERNAL_ERROR'
  | (string & {});
