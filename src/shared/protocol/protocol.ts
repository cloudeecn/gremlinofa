/**
 * GremlinOFA backend/frontend protocol — type-only contract.
 *
 * This is the single source of truth for messages exchanged between the
 * `GremlinClient` (frontend, in `src/frontend/client/`) and the `GremlinServer`
 * (backend, in `src/shared/engine/` running inside the worker today, the
 * Phase 2 Node server tomorrow). Both sides import these types; neither side
 * may add an RPC method or stream event without updating one of the focused
 * files this barrel re-exports from.
 *
 * Phase 1.7 split (formerly a single 967-line file):
 *
 *   - `./wire`    — envelope shapes + identifiers + helper types. Pure
 *                   transport contract; doesn't know about any specific
 *                   method.
 *   - `./errors`  — `ProtocolErrorCode` string union. The carrier exception
 *                   `ProtocolError` lives in `./protocolError` so helpers
 *                   can construct it without circular-importing the
 *                   dispatcher.
 *   - `./events`  — stream event payload types (LoopEvent, ActiveLoops,
 *                   Export/Import progress, project bundle, VFS compact).
 *   - `./methods` — `GremlinMethods` registry + per-method param/result
 *                   types (Init, RunLoop, ImportData) + the wire-safe
 *                   `ToolInventoryEntry` projection.
 *
 * Phase 1 transports: in-process, then Web Worker.
 * Phase 2 transport: WebSocket. The contract does not change between phases —
 * only the wire format does.
 *
 * Design notes:
 * - Envelopes carry a `requestId` so the client can correlate responses with
 *   in-flight calls. Stream methods receive a sequence of envelopes (zero or
 *   more `stream_event`, then exactly one `stream_end` or `error`).
 * - One-shot methods receive exactly one `response` or `error`.
 * - The backend mints a fresh `LoopId` for every loop run (send / continue /
 *   resend / retry / pending-state-resume). `LoopRegistry` keys all of its
 *   state by `LoopId`. Minion sub-loops carry the parent's id in
 *   `parentLoopId`.
 * - `incomplete` assistant messages (from the hard-abort path) lock a chat
 *   from continuation. Every method that starts a loop rejects with
 *   `code: 'CHAT_INCOMPLETE_TAIL'` until the user resolves the tail.
 */

export type { ProtocolErrorCode } from './errors';

export type {
  ClientEnvelope,
  ErrorEnvelope,
  LoopId,
  MethodParams,
  MethodResult,
  MethodStreamEvent,
  RequestEnvelope,
  ResponseEnvelope,
  SeqNo,
  ServerEnvelope,
  StreamEndEnvelope,
  StreamEndStatus,
  StreamEventEnvelope,
  SubscriberId,
} from './wire';
export { isStreamEvent } from './wire';

export type {
  ActiveLoop,
  ActiveLoopsChange,
  ExportEvent,
  ImportProgress,
  LoopEvent,
  ProjectExportEvent,
  VfsCompactEvent,
} from './events';

export { INIT_EXEMPT_METHODS } from './methods';
export type {
  GremlinMethods,
  ImportDataParams,
  InitParams,
  InitResult,
  RunLoopMode,
  RunLoopParams,
  ToolInventoryEntry,
} from './methods';

export type { Transport } from './transport';
