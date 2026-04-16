/**
 * RPC method registry — `GremlinMethods` declares every method's params,
 * one-shot result, and (for streaming methods) the type of events emitted.
 * Both client and server import from here; neither side may add an RPC
 * without updating this file first.
 *
 * Phase 1.7 split: this file owns method *shapes* (params + result + stream
 * type). Stream event payload types live in `./events`. Wire envelopes live
 * in `./wire`. Error codes live in `./errors`.
 */

import type {
  APIDefinition,
  AttachmentSection,
  Chat,
  Message,
  MessageAttachment,
  MinionChat,
  Model,
  Project,
  ToolOptionDefinition,
  ToolUseBlock,
} from './types';
import type {
  CompactOptions,
  DirEntry,
  FileContent,
  InsertResult,
  OrphanInfo,
  ReadFileResult,
  StrReplaceResult,
  VersionInfo,
  VfsStat,
} from '../services/vfs/vfsService';
import type {
  ActiveLoop,
  ActiveLoopsChange,
  ExportEvent,
  ImportProgress,
  LoopEvent,
  ProjectExportEvent,
  VfsCompactEvent,
} from './events';
import type { LoopId, SubscriberId } from './wire';

// ============================================================================
// Wire-safe data shapes used in method results
// ============================================================================

/**
 * Serializable subset of a `ClientSideTool` that the project-settings UI
 * needs to render the tool list. Function-typed fields (`execute`,
 * `description` when callable, `inputSchema` when callable, etc.) are
 * stripped because they can't cross the worker boundary.
 *
 * `optionDefinitions` is the same shape as `ClientSideTool['optionDefinitions']`
 * — those are pure data already (id/label/type/default/visibleWhen).
 */
export interface ToolInventoryEntry {
  name: string;
  displayName?: string;
  displaySubtitle?: string;
  optionDefinitions?: ToolOptionDefinition[];
}

// ============================================================================
// init
// ============================================================================

/**
 * Sent by the first client to bootstrap the dormant backend. The worker
 * (and the eventual Phase 2 WebSocket server) starts truly dormant — no
 * `UnifiedStorage`, no encryption service — and refuses every other RPC
 * with `code: 'NOT_INITIALIZED'` until `init` succeeds. The CEK is held in
 * memory only and never written back to disk by the backend.
 *
 * The contract is locked: the only field the client may post is `cek` (and
 * the optional cross-tab `subscriberId`). The server's storage adapter is
 * configured out-of-band:
 *
 *   - Workers receive their `StorageConfig` via a non-protocol
 *     `worker_config` message posted by the main thread before `init`.
 *   - The Phase 2 Node server reads its config from environment variables
 *     and never accepts a client-posted config at all.
 *
 * Re-`init` with the same CEK is idempotent. Re-`init` with a different
 * CEK is rejected with `code: 'CEK_MISMATCH'` — to change identity, the
 * caller must `purgeAllData` (or detach storage) first and then re-init.
 */
export interface InitParams {
  /**
   * Content encryption key as a string (base32 RFC 4648 lowercase, no
   * padding — the canonical mint format). Legacy base64 strings are also
   * accepted; the backend's `EncryptionCore.initializeWithCEK` detects the
   * format and decodes accordingly. Wire-as-string keeps the envelope
   * JSON-safe so it works on the future websocket transport without binary
   * serialization, and removes the only frontend-side CEK format helper.
   */
  cek?: string;
  /** Optional client-supplied subscriber id (for cross-tab attribution). */
  subscriberId?: SubscriberId;
}

export interface InitResult {
  ok: true;
  subscriberId: SubscriberId;
  /** Server software version, for client compatibility checks. */
  serverVersion: string;
}

// ============================================================================
// runLoop / startLoop
// ============================================================================

/**
 * What kind of run is this? `send` adds a new user message; `continue`
 * resumes a soft-stopped loop without adding one; `resend` re-runs the most
 * recent user message after editing; `retry` re-runs after deleting messages
 * past the anchor (the anchor itself stays).
 */
export type RunLoopMode = 'send' | 'continue' | 'resend' | 'retry';

export interface RunLoopParams {
  chatId: string;
  mode: RunLoopMode;
  /** New user message text — required for `send`/`resend`, ignored otherwise. */
  content?: string;
  /** Attachments uploaded with the new user message. */
  attachments?: MessageAttachment[];
  /**
   * Anchor message id for `retry`. The anchor and everything before it are
   * kept; messages strictly after the anchor are deleted from storage before
   * the loop runs.
   */
  fromMessageId?: string;
  /**
   * Pending tool_use blocks to execute before the first API call. Used by the
   * "continue tool calls" path of resolvePendingToolCalls — the agentic loop
   * runs the supplied tool blocks, persists their results, then continues
   * normally.
   */
  pendingToolUseBlocks?: ToolUseBlock[];
  /**
   * Optional follow-up user message to inject after the pending tool results
   * (continue mode only). The backend creates and persists the message with
   * the same metadata pipeline as a normal `send`.
   */
  pendingTrailingContent?: string;
  /** Attachments for the pending trailing user message. */
  pendingTrailingAttachments?: MessageAttachment[];
}

// ============================================================================
// importData
// ============================================================================

export interface ImportDataParams {
  /** Raw CSV export bundle bytes — the frontend reads `File` to `Uint8Array`. */
  data: Uint8Array;
  /** CEK the bundle was originally encrypted with (base32 or base64). */
  sourceCEK: string;
  /**
   * `merge` keeps existing records and skips duplicates; `replace` clears the
   * database first and re-encrypts everything with the source CEK (which then
   * becomes the active CEK).
   */
  mode: 'merge' | 'replace';
}

// ============================================================================
// Method registry
// ============================================================================

/**
 * Every RPC method declared once: params, one-shot result, and (for streaming
 * methods) the type of events emitted on the stream. One-shot methods set
 * `streams: never`. The transport layer infers everything from this map.
 */
export interface GremlinMethods {
  // ---- lifecycle / bootstrap ----
  init: {
    params: InitParams;
    result: InitResult;
    streams: never;
  };

  // ---- projects ----
  listProjects: { params: Record<string, never>; result: Project[]; streams: never };
  getProject: { params: { projectId: string }; result: Project | null; streams: never };
  saveProject: { params: { project: Project }; result: { ok: true }; streams: never };
  deleteProject: { params: { projectId: string }; result: { ok: true }; streams: never };

  // ---- chats ----
  listChats: { params: { projectId: string }; result: Chat[]; streams: never };
  getChat: { params: { chatId: string }; result: Chat | null; streams: never };
  saveChat: { params: { chat: Chat }; result: { ok: true }; streams: never };
  deleteChat: { params: { chatId: string }; result: { ok: true }; streams: never };
  cloneChat: {
    params: {
      chatId: string;
      /** Optional anchor — the new chat keeps messages strictly before this id. */
      upToMessageId?: string;
      /** Optional fork-message content; saved as a `forkMessage` pending state. */
      forkMessageContent?: string;
    };
    result: { newChatId: string };
    streams: never;
  };
  getMessageCount: {
    params: { chatId: string };
    result: { count: number };
    streams: never;
  };

  // ---- messages ----
  listMessages: { params: { chatId: string }; result: Message<unknown>[]; streams: never };
  saveMessage: {
    params: { chatId: string; message: Message<unknown> };
    result: { ok: true };
    streams: never;
  };
  deleteMessageAndAfter: {
    params: { chatId: string; messageId: string };
    result: { ok: true };
    streams: never;
  };
  /** Single-message delete used by minion chat trimming. */
  deleteSingleMessage: {
    params: { messageId: string };
    result: { ok: true };
    streams: never;
  };

  // ---- minion chats ----
  getMinionChat: {
    params: { minionChatId: string };
    result: MinionChat | null;
    streams: never;
  };
  listMinionMessages: {
    params: { minionChatId: string };
    result: Message<unknown>[];
    streams: never;
  };

  // ---- API definitions / models ----
  listAPIDefinitions: { params: Record<string, never>; result: APIDefinition[]; streams: never };
  getAPIDefinition: {
    params: { apiDefId: string };
    result: APIDefinition | null;
    streams: never;
  };
  saveAPIDefinition: {
    params: { apiDef: APIDefinition };
    result: { ok: true };
    streams: never;
  };
  deleteAPIDefinition: {
    params: { apiDefId: string };
    result: { ok: true };
    streams: never;
  };
  discoverModels: {
    params: { apiDefId: string };
    result: { models: Model[] };
    streams: never;
  };
  /**
   * Read the cached model list for an API definition. `cachedAt` is null when
   * no cache exists. The frontend uses this to decide whether to refresh.
   */
  getModelsCache: {
    params: { apiDefId: string };
    result: { models: Model[]; cachedAt: number | null };
    streams: never;
  };
  saveModelsCache: {
    params: { apiDefId: string; models: Model[] };
    result: { ok: true };
    streams: never;
  };
  deleteModelsCache: {
    params: { apiDefId: string };
    result: { ok: true };
    streams: never;
  };

  // ---- storage / data ----
  getStorageQuota: {
    params: Record<string, never>;
    result: { usage: number; quota: number };
    streams: never;
  };
  purgeAllData: { params: Record<string, never>; result: { ok: true }; streams: never };
  compressAllMessages: {
    params: Record<string, never>;
    result: { compressedCount: number };
    streams: never;
  };
  /** Returns true iff the configured storage adapter has zero records. */
  isStorageEmpty: {
    params: Record<string, never>;
    result: { empty: boolean };
    streams: never;
  };

  // ---- attachments ----
  getAttachments: {
    params: { messageId: string };
    result: { attachments: MessageAttachment[] };
    streams: never;
  };
  getAllAttachmentSections: {
    params: Record<string, never>;
    result: { sections: AttachmentSection[] };
    streams: never;
  };
  deleteAttachment: {
    params: { attachmentId: string };
    result: { messageId: string | null };
    streams: never;
  };
  updateMessageAttachmentIds: {
    params: { chatId: string; messageId: string; attachmentIds: string[] };
    result: { ok: true };
    streams: never;
  };
  deleteAttachmentsOlderThan: {
    params: { days: number };
    result: { deleted: number; updatedMessageIds: string[] };
    streams: never;
  };

  // ---- tool inventory ----
  /** Snapshot of registered tools, projected for the project-settings UI. */
  listTools: {
    params: Record<string, never>;
    result: { tools: ToolInventoryEntry[] };
    streams: never;
  };

  // ---- encryption / CEK lifecycle ----
  /**
   * Probe a remote storage URL with the supplied credentials. Used by OOBE
   * before persisting the storage config. Errors are returned in the
   * `error` field rather than thrown so the UI can render a friendly
   * message.
   */
  validateRemoteStorage: {
    params: { baseUrl: string; password: string; userId: string };
    result: { ok: boolean; error?: string };
    streams: never;
  };
  /**
   * Test-decrypt a single encrypted record with a candidate CEK. Used by
   * OOBE's "use existing remote" flow to verify the user-entered CEK
   * matches the data on the server before init.
   */
  tryDecryptSample: {
    params: { cek: string; sampleCipherText: string };
    result: { ok: boolean };
    streams: never;
  };
  /**
   * Re-encrypt every row in storage with a new CEK and swap the in-memory
   * key. Idempotent if the new CEK matches the current one.
   */
  rotateCek: {
    params: { newCek: string };
    result: { rotatedRows: number };
    streams: never;
  };
  /**
   * Mint a fresh 32-byte CEK and return its base32 encoding. Used by OOBE's
   * "start fresh" flow so the frontend doesn't import any CEK format helpers.
   * Exempt from the dispatcher's `ensureInitialized` guard — the call is a
   * pure crypto helper that needs no encryption state.
   */
  generateNewCEK: {
    params: Record<string, never>;
    result: { cek: string };
    streams: never;
  };
  /**
   * Detect a CEK string's encoding (base32 vs legacy base64) and return the
   * canonical base32 form. Used by the Data Manager's "convert legacy CEK"
   * button. Exempt from `ensureInitialized` for the same reason as
   * `generateNewCEK`.
   */
  normalizeCEK: {
    params: { input: string };
    result: { cek: string };
    streams: never;
  };
  /**
   * Derive the storage-backend userId from a candidate CEK string (base32 or
   * legacy base64). Used by OOBE / bootstrap to populate the remote
   * `StorageConfig` *before* `init` runs (the post-init `deriveUserId` RPC
   * uses the active core, but the userId has to land in the worker_config
   * envelope first). Exempt from `ensureInitialized`.
   */
  deriveUserIdFromCEK: {
    params: { cek: string };
    result: { userId: string };
    streams: never;
  };
  /** Tear down the in-memory storage + encryption state. */
  clearCek: {
    params: Record<string, never>;
    result: { ok: true };
    streams: never;
  };
  /** Returns whether the backend has an active CEK and what format it was supplied in. */
  getCekState: {
    params: Record<string, never>;
    result: { initialized: boolean };
    streams: never;
  };
  /** Derive the storage-backend userId from the active CEK (PBKDF2-SHA256). */
  deriveUserId: {
    params: Record<string, never>;
    result: { userId: string };
    streams: never;
  };

  // ---- VFS — one method per VfsAdapter operation ----
  vfsList: {
    params: { projectId: string; path: string; includeDeleted?: boolean };
    result: { entries: DirEntry[] };
    streams: never;
  };
  vfsRead: {
    params: { projectId: string; path: string };
    result: { content: string };
    streams: never;
  };
  vfsReadWithMeta: {
    params: { projectId: string; path: string };
    result: ReadFileResult;
    streams: never;
  };
  vfsWrite: {
    params: { projectId: string; path: string; content: FileContent };
    result: { ok: true };
    streams: never;
  };
  vfsCreateFile: {
    params: { projectId: string; path: string; content: string };
    result: { ok: true };
    streams: never;
  };
  vfsDeleteFile: {
    params: { projectId: string; path: string };
    result: { ok: true };
    streams: never;
  };
  vfsMkdir: {
    params: { projectId: string; path: string };
    result: { ok: true };
    streams: never;
  };
  vfsRmdir: {
    params: { projectId: string; path: string; recursive?: boolean };
    result: { ok: true };
    streams: never;
  };
  vfsRename: {
    params: { projectId: string; oldPath: string; newPath: string; overwrite?: boolean };
    result: { ok: true };
    streams: never;
  };
  vfsExists: {
    params: { projectId: string; path: string };
    result: { exists: boolean };
    streams: never;
  };
  vfsIsFile: {
    params: { projectId: string; path: string };
    result: { isFile: boolean };
    streams: never;
  };
  vfsIsDirectory: {
    params: { projectId: string; path: string };
    result: { isDirectory: boolean };
    streams: never;
  };
  vfsStat: {
    params: { projectId: string; path: string };
    result: VfsStat;
    streams: never;
  };
  vfsHasVfs: {
    params: { projectId: string };
    result: { hasVfs: boolean };
    streams: never;
  };
  vfsClearVfs: {
    params: { projectId: string };
    result: { ok: true };
    streams: never;
  };
  vfsStrReplace: {
    params: { projectId: string; path: string; oldStr: string; newStr: string };
    result: StrReplaceResult;
    streams: never;
  };
  vfsInsert: {
    params: { projectId: string; path: string; line: number; text: string };
    result: InsertResult;
    streams: never;
  };
  vfsAppendFile: {
    params: { projectId: string; path: string; text: string };
    result: { created: boolean };
    streams: never;
  };
  vfsGetFileMeta: {
    params: { projectId: string; path: string };
    result: {
      meta: {
        version: number;
        createdAt: number;
        updatedAt: number;
        minStoredVersion: number;
        storedVersionCount: number;
      } | null;
    };
    streams: never;
  };
  vfsGetFileId: {
    params: { projectId: string; path: string };
    result: { fileId: string | null };
    streams: never;
  };
  vfsListVersions: {
    params: { projectId: string; fileId: string };
    result: { versions: VersionInfo[] };
    streams: never;
  };
  vfsGetVersion: {
    params: { projectId: string; fileId: string; version: number };
    result: { content: string | null };
    streams: never;
  };
  vfsDropOldVersions: {
    params: { projectId: string; fileId: string; keepCount: number };
    result: { dropped: number };
    streams: never;
  };
  vfsListOrphans: {
    params: { projectId: string };
    result: { orphans: OrphanInfo[] };
    streams: never;
  };
  vfsRestoreOrphan: {
    params: { projectId: string; fileId: string; targetPath: string };
    result: { ok: true };
    streams: never;
  };
  vfsPurgeOrphan: {
    params: { projectId: string; fileId: string };
    result: { ok: true };
    streams: never;
  };
  vfsCopyFile: {
    params: { projectId: string; src: string; dst: string; overwrite?: boolean };
    result: { ok: true };
    streams: never;
  };
  vfsDeletePath: {
    params: { projectId: string; path: string };
    result: { ok: true };
    streams: never;
  };
  vfsCreateFileGuarded: {
    params: { projectId: string; path: string; content: FileContent; overwrite?: boolean };
    result: { ok: true };
    streams: never;
  };
  vfsEnsureDirAndWrite: {
    params: {
      projectId: string;
      dir: string;
      files: Array<{ name: string; content: string }>;
    };
    result: { ok: true };
    streams: never;
  };
  /**
   * Streaming compact run. The server emits `progress` events as it walks
   * the project's VFS, then a terminal `done` event carrying the final
   * `CompactResult`. The transport closes the stream right after `done`.
   */
  vfsCompactProject: {
    params: { projectId: string; options?: CompactOptions };
    result: { ok: true };
    streams: VfsCompactEvent;
  };

  // ---- active loops ----
  listActiveLoops: {
    params: Record<string, never>;
    result: ActiveLoop[];
    streams: never;
  };
  abortLoop: { params: { loopId: LoopId }; result: { ok: true }; streams: never };
  softStopLoop: { params: { loopId: LoopId }; result: { ok: true }; streams: never };

  // ---- streaming methods ----

  /**
   * Start a new agentic loop on a chat. Returns the freshly minted `loopId`
   * one-shot, then streams `LoopEvent`s until the loop terminates with a
   * `stream_end` envelope. Rejects with `CHAT_INCOMPLETE_TAIL` if the chat's
   * tail message is `incomplete`.
   *
   * Note: this stream-style runLoop is kept for the chat-view send path which
   * consumes events directly through `GremlinSession`. For the project-view
   * "start a chat then attach" flow, use `startLoop` (one-shot) and consume
   * events via `attachChat`.
   */
  runLoop: {
    params: RunLoopParams;
    result: { loopId: LoopId };
    streams: LoopEvent;
  };

  /**
   * Fire-and-forget loop start. Mints a `loopId`, validates the chat, and
   * spawns a background driver that runs the agentic loop and broadcasts
   * `LoopEvent`s to any `attachChat` subscribers. Returns the `loopId`
   * immediately. Rejects synchronously with `CHAT_BUSY` /
   * `CHAT_INCOMPLETE_TAIL` if the pre-flight checks fail.
   *
   * This is the "project view starts a chat" entry point: ProjectView calls
   * `startLoop` and then navigates; ChatView mounts and calls `attachChat`,
   * which receives both the snapshot and the live event stream.
   */
  startLoop: {
    params: RunLoopParams;
    result: { loopId: LoopId };
    streams: never;
  };

  /**
   * Attach to a chat — load its persisted messages and subscribe to its
   * live event stream. The streaming `LoopEvent` payload carries every
   * piece of state the consumer needs (`chat_updated`, `message_created`,
   * `loop_started` for any in-flight loop, then `snapshot_complete`),
   * so the result envelope is just an ack.
   */
  attachChat: {
    params: { chatId: string };
    result: { ok: true };
    streams: LoopEvent;
  };

  /** Subscribe to changes in the set of running loops (sidebar UI). */
  subscribeActiveLoops: {
    params: Record<string, never>;
    result: { ok: true };
    streams: ActiveLoopsChange;
  };

  /**
   * Stream-encoded data export. The client assembles `chunk` events into a
   * Blob, then triggers the download anchor click on the main thread.
   * `result` is unused — the terminal `done` event in the stream carries
   * the suggested filename + mime type.
   */
  exportData: {
    params: Record<string, never>;
    result: { ok: true };
    streams: ExportEvent;
  };

  /**
   * Stream-encoded data import. The server emits progress events as it
   * walks the CSV; the terminal `done` event carries the final counts so
   * callers don't need to await a separate one-shot result.
   */
  importData: {
    params: ImportDataParams;
    result: { ok: true };
    streams: ImportProgress;
  };

  /**
   * Stream a single project's `.gremlin.json` bundle. Mirrors the shape
   * `exportData` follows: progress events per file loaded, terminal
   * `done` event carrying the serialized bundle JSON + counts. The
   * frontend assembles the JSON into a `Blob` and triggers the download
   * anchor on the main thread.
   */
  exportProject: {
    params: { projectId: string };
    result: { ok: true };
    streams: ProjectExportEvent;
  };

  /**
   * Import a `.gremlin.json` bundle as a fresh project (with newly minted
   * IDs and `(Imported)` suffix). One-shot — bundle is small enough that
   * a streaming RPC would just add ceremony for no UX benefit.
   */
  importProject: {
    params: { bundleJson: string };
    result: { projectId: string; projectName: string };
    streams: never;
  };
}
