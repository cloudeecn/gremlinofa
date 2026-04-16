/**
 * Frontend RPC client for the GremlinOFA backend.
 *
 * `GremlinClient` exposes one typed method per RPC declared in
 * `src/backend/protocol.ts`. Internally each method delegates to the
 * configured `Transport`, which abstracts over the wire format:
 *
 *   - **Phase 1 staging**: `InProcessTransport` — same JS context, no
 *     serialization. The default at app boot.
 *   - **Phase 1 final**: `WorkerTransport` (PR 13) — backend lives in a
 *     Web Worker, communication via `postMessage`.
 *   - **Phase 2**: `WebSocketTransport` — backend lives in a Node process,
 *     communication via WebSocket frames.
 *
 * The client is intentionally a thin facade. There is no caching, retry,
 * or per-method state — everything goes straight to the transport. State
 * lives in higher-level objects (`GremlinSession` for chat-level streaming,
 * `ActiveLoopsStore` for the sidebar).
 *
 * Migration shape: methods named `getProjects`, `saveProject`, etc. mirror
 * the old `storage.getProjects()` calls used by `AppContext`/`useProject`/
 * `useMinionChat`. Hooks just swap `storage.X(...)` for `gremlinClient.X(...)`
 * with no change in shape — the protocol's CRUD methods were chosen to
 * preserve those signatures so the swap is mechanical.
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
} from '../../shared/protocol/types';
import type {
  CompactOptions,
  CompactProgress,
  CompactResult,
  DirEntry,
  FileContent,
  InsertResult,
  OrphanInfo,
  ReadFileResult,
  StrReplaceResult,
  VersionInfo,
  VfsAdapter,
  VfsStat,
} from '../../shared/protocol/types/vfs';
import type {
  ActiveLoop,
  GremlinMethods,
  InitParams,
  InitResult,
  LoopId,
  Transport,
  MethodParams,
  MethodResult,
  RunLoopParams,
  StreamEndEnvelope,
  StreamEventEnvelope,
  ToolInventoryEntry,
} from '../../shared/protocol/protocol';
import type { StorageConfig } from '../lib/localStorageBoot';

export class GremlinClient {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  // ==========================================================================
  // Generic dispatch — used by `GremlinSession` and friends for streams
  // ==========================================================================

  /** One-shot RPC. Throws `ProtocolError` on failure. */
  request<M extends keyof GremlinMethods>(
    method: M,
    params: MethodParams<M>
  ): Promise<MethodResult<M>> {
    return this.transport.request(method, params);
  }

  /**
   * Streaming RPC. Returns the transport's iterable directly so callers can
   * `for await` it. Each iteration yields either a `StreamEventEnvelope`
   * carrying a method-specific event, or the terminal `StreamEndEnvelope`.
   */
  stream<M extends keyof GremlinMethods>(
    method: M,
    params: MethodParams<M>
  ): AsyncIterable<StreamEventEnvelope<M> | StreamEndEnvelope> {
    return this.transport.stream(method, params);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  init(params: InitParams = {}): Promise<InitResult> {
    return this.request('init', params);
  }

  /**
   * Out-of-band worker bootstrap. Posts the storage config through the
   * transport's `configureWorker` channel (no-op on transports that
   * don't need it). Must be called before `init` — the worker reads the
   * stashed config when constructing the deferred-mode `BackendDeps`
   * bundle. The frontend's `bootstrapClient.ts` (and the OOBE / Data
   * Manager flows) call this immediately before `init`.
   */
  async configureWorker(config: StorageConfig): Promise<void> {
    if (this.transport.configureWorker) {
      await this.transport.configureWorker(config);
    }
  }

  // ==========================================================================
  // CRUD — projects
  // ==========================================================================

  getProjects(): Promise<Project[]> {
    return this.request('listProjects', {});
  }

  getProject(projectId: string): Promise<Project | null> {
    return this.request('getProject', { projectId });
  }

  async saveProject(project: Project): Promise<void> {
    await this.request('saveProject', { project });
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.request('deleteProject', { projectId });
  }

  // ==========================================================================
  // CRUD — chats
  // ==========================================================================

  getChats(projectId: string): Promise<Chat[]> {
    return this.request('listChats', { projectId });
  }

  getChat(chatId: string): Promise<Chat | null> {
    return this.request('getChat', { chatId });
  }

  async saveChat(chat: Chat): Promise<void> {
    await this.request('saveChat', { chat });
  }

  async deleteChat(chatId: string): Promise<void> {
    await this.request('deleteChat', { chatId });
  }

  async cloneChat(
    chatId: string,
    upToMessageId?: string,
    forkMessageContent?: string
  ): Promise<{ newChatId: string }> {
    return this.request('cloneChat', { chatId, upToMessageId, forkMessageContent });
  }

  async getMessageCount(chatId: string): Promise<number> {
    const { count } = await this.request('getMessageCount', { chatId });
    return count;
  }

  // ==========================================================================
  // CRUD — messages
  // ==========================================================================

  getMessages(chatId: string): Promise<Message<unknown>[]> {
    return this.request('listMessages', { chatId });
  }

  async saveMessage(chatId: string, message: Message<unknown>): Promise<void> {
    await this.request('saveMessage', { chatId, message });
  }

  async deleteMessageAndAfter(chatId: string, messageId: string): Promise<void> {
    await this.request('deleteMessageAndAfter', { chatId, messageId });
  }

  async deleteSingleMessage(messageId: string): Promise<void> {
    await this.request('deleteSingleMessage', { messageId });
  }

  // ==========================================================================
  // CRUD — minion chats
  // ==========================================================================

  getMinionChat(minionChatId: string): Promise<MinionChat | null> {
    return this.request('getMinionChat', { minionChatId });
  }

  getMinionMessages(minionChatId: string): Promise<Message<unknown>[]> {
    return this.request('listMinionMessages', { minionChatId });
  }

  // ==========================================================================
  // CRUD — API definitions / models
  // ==========================================================================

  getAPIDefinitions(): Promise<APIDefinition[]> {
    return this.request('listAPIDefinitions', {});
  }

  getAPIDefinition(apiDefId: string): Promise<APIDefinition | null> {
    return this.request('getAPIDefinition', { apiDefId });
  }

  async saveAPIDefinition(apiDef: APIDefinition): Promise<void> {
    await this.request('saveAPIDefinition', { apiDef });
  }

  async deleteAPIDefinition(apiDefId: string): Promise<void> {
    await this.request('deleteAPIDefinition', { apiDefId });
  }

  async discoverModels(apiDefId: string): Promise<Model[]> {
    const { models } = await this.request('discoverModels', { apiDefId });
    return models;
  }

  /**
   * Read the cached model list. Returns `cachedAt` as a unix timestamp (or
   * `null` if no cache exists). Callers should compare against `Date.now()`
   * to decide whether to refresh.
   */
  async getModelsCache(apiDefId: string): Promise<{ models: Model[]; cachedAt: number | null }> {
    return this.request('getModelsCache', { apiDefId });
  }

  async saveModelsCache(apiDefId: string, models: Model[]): Promise<void> {
    await this.request('saveModelsCache', { apiDefId, models });
  }

  async deleteModelsCache(apiDefId: string): Promise<void> {
    await this.request('deleteModelsCache', { apiDefId });
  }

  // ==========================================================================
  // Storage / data
  // ==========================================================================

  async getStorageQuota(): Promise<{ usage: number; quota: number }> {
    return this.request('getStorageQuota', {});
  }

  async purgeAllData(): Promise<void> {
    await this.request('purgeAllData', {});
  }

  async compressAllMessages(): Promise<{ compressedCount: number }> {
    return this.request('compressAllMessages', {});
  }

  async isStorageEmpty(): Promise<boolean> {
    const { empty } = await this.request('isStorageEmpty', {});
    return empty;
  }

  // ==========================================================================
  // Attachments
  // ==========================================================================

  async getAttachments(messageId: string): Promise<MessageAttachment[]> {
    const { attachments } = await this.request('getAttachments', { messageId });
    return attachments;
  }

  async getAllAttachmentSections(): Promise<AttachmentSection[]> {
    const { sections } = await this.request('getAllAttachmentSections', {});
    return sections;
  }

  /** Returns the parent message id of the deleted attachment, or `null` if not found. */
  async deleteAttachment(attachmentId: string): Promise<string | null> {
    const { messageId } = await this.request('deleteAttachment', { attachmentId });
    return messageId;
  }

  async updateMessageAttachmentIds(
    chatId: string,
    messageId: string,
    attachmentIds: string[]
  ): Promise<void> {
    await this.request('updateMessageAttachmentIds', { chatId, messageId, attachmentIds });
  }

  async deleteAttachmentsOlderThan(
    days: number
  ): Promise<{ deleted: number; updatedMessageIds: string[] }> {
    return this.request('deleteAttachmentsOlderThan', { days });
  }

  // ==========================================================================
  // Tool inventory
  // ==========================================================================

  async listTools(): Promise<ToolInventoryEntry[]> {
    const { tools } = await this.request('listTools', {});
    return tools;
  }

  // ==========================================================================
  // Encryption / CEK lifecycle
  // ==========================================================================

  async validateRemoteStorage(
    baseUrl: string,
    password: string,
    userId: string
  ): Promise<{ ok: boolean; error?: string }> {
    return this.request('validateRemoteStorage', { baseUrl, password, userId });
  }

  async tryDecryptSample(cek: string, sampleCipherText: string): Promise<boolean> {
    const { ok } = await this.request('tryDecryptSample', { cek, sampleCipherText });
    return ok;
  }

  async rotateCek(newCek: string): Promise<{ rotatedRows: number }> {
    return this.request('rotateCek', { newCek });
  }

  async clearCek(): Promise<void> {
    await this.request('clearCek', {});
  }

  async getCekState(): Promise<{ initialized: boolean }> {
    return this.request('getCekState', {});
  }

  async deriveUserId(): Promise<string> {
    const { userId } = await this.request('deriveUserId', {});
    return userId;
  }

  /**
   * Mint a fresh base32 CEK on the backend. Used by OOBE's "start fresh"
   * flow so the frontend never imports CEK format helpers.
   */
  async generateNewCEK(): Promise<string> {
    const { cek } = await this.request('generateNewCEK', {});
    return cek;
  }

  /**
   * Convert a legacy base64 CEK to canonical base32. Used by the Data
   * Manager's "convert legacy CEK" button. Idempotent — already-base32
   * inputs round-trip unchanged.
   */
  async normalizeCEK(input: string): Promise<string> {
    const { cek } = await this.request('normalizeCEK', { input });
    return cek;
  }

  /**
   * Derive a remote-storage userId from a CEK string before the worker is
   * initialized. Used by `bootstrapClient` and OOBE to populate the
   * remote `StorageConfig` ahead of `init`.
   */
  async deriveUserIdFromCEK(cek: string): Promise<string> {
    const { userId } = await this.request('deriveUserIdFromCEK', { cek });
    return userId;
  }

  // ==========================================================================
  // VFS
  // ==========================================================================

  async vfsList(projectId: string, path: string, includeDeleted?: boolean): Promise<DirEntry[]> {
    const { entries } = await this.request('vfsList', { projectId, path, includeDeleted });
    return entries;
  }

  async vfsRead(projectId: string, path: string): Promise<string> {
    const { content } = await this.request('vfsRead', { projectId, path });
    return content;
  }

  async vfsReadWithMeta(projectId: string, path: string): Promise<ReadFileResult> {
    return this.request('vfsReadWithMeta', { projectId, path });
  }

  async vfsWrite(projectId: string, path: string, content: FileContent): Promise<void> {
    await this.request('vfsWrite', { projectId, path, content });
  }

  async vfsCreateFile(projectId: string, path: string, content: string): Promise<void> {
    await this.request('vfsCreateFile', { projectId, path, content });
  }

  async vfsDeleteFile(projectId: string, path: string): Promise<void> {
    await this.request('vfsDeleteFile', { projectId, path });
  }

  async vfsMkdir(projectId: string, path: string): Promise<void> {
    await this.request('vfsMkdir', { projectId, path });
  }

  async vfsRmdir(projectId: string, path: string, recursive?: boolean): Promise<void> {
    await this.request('vfsRmdir', { projectId, path, recursive });
  }

  async vfsRename(
    projectId: string,
    oldPath: string,
    newPath: string,
    overwrite?: boolean
  ): Promise<void> {
    await this.request('vfsRename', { projectId, oldPath, newPath, overwrite });
  }

  async vfsExists(projectId: string, path: string): Promise<boolean> {
    const { exists } = await this.request('vfsExists', { projectId, path });
    return exists;
  }

  async vfsIsFile(projectId: string, path: string): Promise<boolean> {
    const { isFile } = await this.request('vfsIsFile', { projectId, path });
    return isFile;
  }

  async vfsIsDirectory(projectId: string, path: string): Promise<boolean> {
    const { isDirectory } = await this.request('vfsIsDirectory', { projectId, path });
    return isDirectory;
  }

  async vfsStat(projectId: string, path: string): Promise<VfsStat> {
    return this.request('vfsStat', { projectId, path });
  }

  async vfsHasVfs(projectId: string): Promise<boolean> {
    const { hasVfs } = await this.request('vfsHasVfs', { projectId });
    return hasVfs;
  }

  async vfsClearVfs(projectId: string): Promise<void> {
    await this.request('vfsClearVfs', { projectId });
  }

  async vfsStrReplace(
    projectId: string,
    path: string,
    oldStr: string,
    newStr: string
  ): Promise<StrReplaceResult> {
    return this.request('vfsStrReplace', { projectId, path, oldStr, newStr });
  }

  async vfsInsert(
    projectId: string,
    path: string,
    line: number,
    text: string
  ): Promise<InsertResult> {
    return this.request('vfsInsert', { projectId, path, line, text });
  }

  async vfsAppendFile(
    projectId: string,
    path: string,
    text: string
  ): Promise<{ created: boolean }> {
    return this.request('vfsAppendFile', { projectId, path, text });
  }

  async vfsGetFileMeta(
    projectId: string,
    path: string
  ): Promise<{
    version: number;
    createdAt: number;
    updatedAt: number;
    minStoredVersion: number;
    storedVersionCount: number;
  } | null> {
    const { meta } = await this.request('vfsGetFileMeta', { projectId, path });
    return meta;
  }

  async vfsGetFileId(projectId: string, path: string): Promise<string | null> {
    const { fileId } = await this.request('vfsGetFileId', { projectId, path });
    return fileId;
  }

  async vfsListVersions(projectId: string, fileId: string): Promise<VersionInfo[]> {
    const { versions } = await this.request('vfsListVersions', { projectId, fileId });
    return versions;
  }

  async vfsGetVersion(projectId: string, fileId: string, version: number): Promise<string | null> {
    const { content } = await this.request('vfsGetVersion', { projectId, fileId, version });
    return content;
  }

  async vfsDropOldVersions(projectId: string, fileId: string, keepCount: number): Promise<number> {
    const { dropped } = await this.request('vfsDropOldVersions', { projectId, fileId, keepCount });
    return dropped;
  }

  async vfsListOrphans(projectId: string): Promise<OrphanInfo[]> {
    const { orphans } = await this.request('vfsListOrphans', { projectId });
    return orphans;
  }

  async vfsRestoreOrphan(projectId: string, fileId: string, targetPath: string): Promise<void> {
    await this.request('vfsRestoreOrphan', { projectId, fileId, targetPath });
  }

  async vfsPurgeOrphan(projectId: string, fileId: string): Promise<void> {
    await this.request('vfsPurgeOrphan', { projectId, fileId });
  }

  async vfsCopyFile(
    projectId: string,
    src: string,
    dst: string,
    overwrite?: boolean
  ): Promise<void> {
    await this.request('vfsCopyFile', { projectId, src, dst, overwrite });
  }

  async vfsDeletePath(projectId: string, path: string): Promise<void> {
    await this.request('vfsDeletePath', { projectId, path });
  }

  async vfsCreateFileGuarded(
    projectId: string,
    path: string,
    content: FileContent,
    overwrite?: boolean
  ): Promise<void> {
    await this.request('vfsCreateFileGuarded', { projectId, path, content, overwrite });
  }

  async vfsEnsureDirAndWrite(
    projectId: string,
    dir: string,
    files: Array<{ name: string; content: string }>
  ): Promise<void> {
    await this.request('vfsEnsureDirAndWrite', { projectId, dir, files });
  }

  /**
   * Streaming compact run. Forwards each `progress` event to `onProgress`
   * and returns the final `CompactResult` from the terminal `done` event.
   */
  async vfsCompactProject(
    projectId: string,
    onProgress?: (p: CompactProgress) => void,
    options?: CompactOptions
  ): Promise<CompactResult> {
    let result: CompactResult | null = null;

    for await (const envelope of this.stream('vfsCompactProject', { projectId, options })) {
      if (envelope.kind !== 'stream_event') continue;
      const event = envelope.event;
      switch (event.type) {
        case 'progress':
          onProgress?.(event.progress);
          break;
        case 'done':
          result = event.result;
          break;
      }
    }

    if (!result) {
      throw new Error('vfsCompactProject completed without a done event');
    }
    return result;
  }

  /**
   * Project-bound `VfsAdapter` facade. Every method delegates straight back
   * into the per-call `vfs*` RPCs above. The facade exists so React
   * components and the VFS subview tree can take a typed `VfsAdapter` prop
   * (rather than threading `projectId` everywhere) without depending on
   * the legacy `useVfsAdapter` hook — Phase 1.7 deleted the hook in favor
   * of this method.
   *
   * The returned object is plain — there is no per-project caching, since
   * every method is a stateless RPC. Components that want stable identity
   * across renders should wrap the call in `useMemo(() => ..., [projectId])`.
   */
  getVfsAdapter(projectId: string): VfsAdapter {
    return {
      // ---- basic CRUD ----
      readDir: (path, includeDeleted) => this.vfsList(projectId, path, includeDeleted),
      readFile: path => this.vfsRead(projectId, path),
      readFileWithMeta: path => this.vfsReadWithMeta(projectId, path),
      writeFile: (path, content) => this.vfsWrite(projectId, path, content),
      createFile: (path, content) => this.vfsCreateFile(projectId, path, content),
      deleteFile: path => this.vfsDeleteFile(projectId, path),
      mkdir: path => this.vfsMkdir(projectId, path),
      rmdir: (path, recursive) => this.vfsRmdir(projectId, path, recursive),
      rename: (oldPath, newPath, overwrite) =>
        this.vfsRename(projectId, oldPath, newPath, overwrite),
      exists: path => this.vfsExists(projectId, path),
      isFile: path => this.vfsIsFile(projectId, path),
      isDirectory: path => this.vfsIsDirectory(projectId, path),
      stat: path => this.vfsStat(projectId, path),
      hasVfs: () => this.vfsHasVfs(projectId),
      clearVfs: () => this.vfsClearVfs(projectId),

      // ---- text editing ----
      strReplace: (path, oldStr, newStr) => this.vfsStrReplace(projectId, path, oldStr, newStr),
      insert: (path, line, text) => this.vfsInsert(projectId, path, line, text),
      appendFile: (path, text) => this.vfsAppendFile(projectId, path, text),

      // ---- versioning ----
      getFileMeta: path => this.vfsGetFileMeta(projectId, path),
      getFileId: path => this.vfsGetFileId(projectId, path),
      listVersions: fileId => this.vfsListVersions(projectId, fileId),
      getVersion: (fileId, version) => this.vfsGetVersion(projectId, fileId, version),
      dropOldVersions: (fileId, keepCount) => this.vfsDropOldVersions(projectId, fileId, keepCount),

      // ---- orphans ----
      listOrphans: () => this.vfsListOrphans(projectId),
      restoreOrphan: (fileId, targetPath) => this.vfsRestoreOrphan(projectId, fileId, targetPath),
      purgeOrphan: fileId => this.vfsPurgeOrphan(projectId, fileId),

      // ---- compound ops ----
      copyFile: (src, dst, overwrite) => this.vfsCopyFile(projectId, src, dst, overwrite),
      deletePath: path => this.vfsDeletePath(projectId, path),
      createFileGuarded: (path, content, overwrite) =>
        this.vfsCreateFileGuarded(projectId, path, content, overwrite),
      ensureDirAndWrite: (dir, files) => this.vfsEnsureDirAndWrite(projectId, dir, files),

      // ---- compact (streaming) ----
      compactProject: (onProgress, options) =>
        this.vfsCompactProject(projectId, onProgress, options),
    };
  }

  // ==========================================================================
  // Active loops (sidebar Running Loops UI lands in PR 11)
  // ==========================================================================

  listActiveLoops(): Promise<ActiveLoop[]> {
    return this.request('listActiveLoops', {});
  }

  async abortLoop(loopId: LoopId): Promise<void> {
    await this.request('abortLoop', { loopId });
  }

  async softStopLoop(loopId: LoopId): Promise<void> {
    await this.request('softStopLoop', { loopId });
  }

  /**
   * Fire-and-forget loop start. Mints a `loopId` on the backend, validates
   * the chat synchronously, and returns once the background driver has
   * started. Subsequent `LoopEvent`s flow through any active `attachChat`
   * subscribers for that chat — typically the chat-view's `useChat` hook.
   *
   * Used by the project-view "type a message and hit send" flow: the
   * project view fires `startLoop`, navigates to the chat view, and the
   * chat view's `attachChat` subscription picks up the live stream.
   */
  async startLoop(params: RunLoopParams): Promise<{ loopId: LoopId }> {
    return this.request('startLoop', params);
  }

  // ==========================================================================
  // Export / import — streaming, with frontend assembly of the final Blob
  // ==========================================================================

  /**
   * Stream the export bundle out as a sequence of `chunk` events. Returns
   * the assembled `Blob` plus the suggested download filename and mime type
   * once the stream completes. Callers (typically `AppContext`) hand the
   * blob to a `<a download>` anchor on the main thread.
   *
   * `onProgress` fires once per record. The first chunk arrives after the
   * first ~64KB of CSV are buffered, so progress shows up immediately even
   * for small databases.
   */
  async exportToBlob(onProgress?: (processed: number) => void): Promise<{
    blob: Blob;
    suggestedName: string;
    mimeType: string;
  }> {
    const chunks: BlobPart[] = [];
    let suggestedName = 'gremlinofa-backup.csv';
    let mimeType = 'text/csv;charset=utf-8;';

    for await (const envelope of this.stream('exportData', {})) {
      if (envelope.kind !== 'stream_event') continue;
      const event = envelope.event;
      switch (event.type) {
        case 'progress':
          onProgress?.(event.processed);
          break;
        case 'chunk':
          // Copy the slice into a fresh ArrayBuffer-backed view so TypeScript's
          // narrow `BlobPart` definition is satisfied (it disallows
          // `SharedArrayBuffer`-backed views) and so we don't accidentally
          // share a worker-side buffer that could be transferred out from
          // under us.
          chunks.push(
            new Uint8Array(
              event.data.buffer.slice(
                event.data.byteOffset,
                event.data.byteOffset + event.data.byteLength
              ) as ArrayBuffer
            )
          );
          break;
        case 'done':
          suggestedName = event.suggestedName;
          mimeType = event.mimeType;
          break;
      }
    }

    return { blob: new Blob(chunks, { type: mimeType }), suggestedName, mimeType };
  }

  /**
   * Stream a CSV bundle into the backend. The caller reads the uploaded
   * `File` to a `Uint8Array` first (so the worker boundary doesn't need to
   * cross a `File` reference). Returns the final import counts.
   *
   * `mode: 'merge'` keeps existing records; `mode: 'replace'` clears the
   * database first and re-encrypts everything with `sourceCEK`, which then
   * becomes the active CEK on the backend.
   */
  async importFromBytes(
    data: Uint8Array,
    sourceCEK: string,
    mode: 'merge' | 'replace',
    onProgress?: (progress: {
      processed: number;
      imported: number;
      skipped: number;
      errors: number;
      estimatedTotal?: number;
    }) => void
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    let imported = 0;
    let skipped = 0;
    let errors: string[] = [];

    for await (const envelope of this.stream('importData', { data, sourceCEK, mode })) {
      if (envelope.kind !== 'stream_event') continue;
      const event = envelope.event;
      switch (event.type) {
        case 'progress':
          onProgress?.({
            processed: event.processed,
            imported: event.imported,
            skipped: event.skipped,
            errors: event.errors,
            estimatedTotal: event.estimatedTotal,
          });
          break;
        case 'warning':
          console.warn('[GremlinClient] importData warning:', event.message);
          break;
        case 'done':
          imported = event.imported;
          skipped = event.skipped;
          errors = event.errors;
          break;
      }
    }

    return { imported, skipped, errors };
  }

  // ==========================================================================
  // Project bundle export / import
  // ==========================================================================

  /**
   * Stream a single project's `.gremlin.json` bundle out of the backend.
   * Yields one progress callback per file loaded; once the stream completes,
   * returns the assembled bundle JSON + counts so the caller can wrap it in
   * a `Blob` and trigger the download anchor on the main thread.
   */
  async exportProjectBundle(
    projectId: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<{ bundleJson: string; fileCount: number; dirCount: number; projectName: string }> {
    let bundleJson = '';
    let fileCount = 0;
    let dirCount = 0;
    let projectName = '';

    for await (const envelope of this.stream('exportProject', { projectId })) {
      if (envelope.kind !== 'stream_event') continue;
      const event = envelope.event;
      switch (event.type) {
        case 'progress':
          onProgress?.(event.loaded, event.total);
          break;
        case 'done':
          bundleJson = event.bundleJson;
          fileCount = event.fileCount;
          dirCount = event.dirCount;
          projectName = event.projectName;
          break;
      }
    }

    return { bundleJson, fileCount, dirCount, projectName };
  }

  /**
   * Import a `.gremlin.json` bundle as a fresh project. The caller reads
   * the uploaded `File` to a UTF-8 string and posts it through; the
   * backend parses, validates, and writes the project + VFS records.
   */
  async importProjectBundle(
    bundleJson: string
  ): Promise<{ projectId: string; projectName: string }> {
    return this.request('importProject', { bundleJson });
  }
}
