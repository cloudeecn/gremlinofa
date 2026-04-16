/**
 * Method dispatcher for the GremlinOFA backend.
 *
 * `GremlinServer` is the single object the transport layer talks to. It
 * holds the `UnifiedStorage` instance and a `LoopRegistry`, and routes
 * incoming envelopes to the right handler. Handlers fall into two shapes:
 *
 *   - **One-shot**: an async function returning the method's `result`.
 *     Errors bubble out as `ProtocolError` so the transport can wrap them in
 *     an `ErrorEnvelope`.
 *
 *   - **Streaming**: an async generator that yields events of the method's
 *     `streams` type until it returns. The transport wraps each yielded value
 *     in a `StreamEventEnvelope` and emits a final `StreamEndEnvelope` when
 *     the generator is done.
 *
 * PR 7 lands the dispatcher with all CRUD methods wired through to
 * `UnifiedStorage`. The streaming methods (`runLoop`, `attachChat`,
 * `subscribeActiveLoops`, `exportData`, `importData`) are
 * present in the dispatcher and wired to their handler generators.
 */

import { APIService } from '../services/api/apiService';
import { UnifiedStorage } from '../services/storage/unifiedStorage';
import { EncryptionCore } from '../services/encryption/encryptionCore';
import { Tables, type StorageAdapter } from '../services/storage/StorageAdapter';
import type { StorageConfig } from '../protocol/types/storageConfig';
import { ClientSideToolRegistry } from '../services/tools/clientSideTools';
import { registerAllTools } from '../services/tools';
import type { VfsAdapter } from '../services/vfs/vfsAdapter';
import { generateUniqueId } from '../protocol/idGenerator';
import { bytesToBase32, convertCEKToBase32 } from './lib/cekFormat';
import { mergeExtraModels } from './lib/api/mergeExtraModels';
import { assertNoLoopsRunning } from './lib/assertNoLoopsRunning';
import { isChatLockedByIncompleteTail } from './lib/incompleteTail';
import { ProtocolError } from '../protocol/protocolError';
import type { BackendDeps, CreateStorageAdapter, CreateVfsAdapter } from './backendDeps';
import { ChatRunner } from './ChatRunner';
import { LoopRegistry } from './LoopRegistry';
import { runExport } from './exportRunner';
import { runImport } from './importRunner';
import { prepareMessageForWire } from './messageWire';
import { runProjectExport, runProjectImport } from './projectBundle';
import type {
  ActiveLoopsChange,
  ExportEvent,
  GremlinMethods,
  ImportDataParams,
  ImportProgress,
  InitParams,
  InitResult,
  LoopEvent,
  LoopId,
  MethodParams,
  MethodResult,
  ProjectExportEvent,
  RunLoopParams,
  SubscriberId,
  ToolInventoryEntry,
  VfsCompactEvent,
} from '../protocol/protocol';

/**
 * Re-export `ProtocolError` from its own module so existing imports
 * (transports, ChatRunner, projectBundle, ...) keep working. The class
 * itself moved out of `GremlinServer.ts` so destructive-op guards
 * (`assertNoLoopsRunning`) can construct it without a circular import on
 * the dispatcher.
 */
export { ProtocolError };

/**
 * Methods that bypass `ensureInitialized()` so they can run while the
 * backend is still dormant. `init` is the canonical bootstrap; the three
 * CEK helpers are pure crypto utilities used by OOBE / bootstrap *before*
 * encryption state exists. Keeping them dormant-callable means the
 * frontend never imports CEK format helpers — it just hops to the
 * backend whenever it needs bytes ↔ string conversion or fresh entropy.
 */
const INIT_EXEMPT_METHODS = new Set<string>([
  'init',
  'generateNewCEK',
  'normalizeCEK',
  'deriveUserIdFromCEK',
]);

export class GremlinServer {
  /**
   * Per-server agentic-loop registry. The instance is stable for the
   * server's lifetime — when the deferred `init()` rebuilds the deps
   * bundle, it threads this same registry through `BackendDeps.loopRegistry`
   * so RPC handlers (`abortLoop`, `subscribeActiveLoops`, …) and the
   * dependency-bundle path (used by `minionTool` to register child loops)
   * always see the same set of running loops.
   */
  readonly registry: LoopRegistry;
  /**
   * Tracks whether storage + encryption have been brought up. After
   * Phase 1.65 the only production transport is the worker, which
   * constructs the server with `null` deps and waits for `init({cek})`
   * (plus an out-of-band `worker_config` carrying the storage config)
   * to build them. Tests can pass a pre-built `BackendDeps` stub to the
   * constructor to skip the deferred-init dance.
   */
  private initialized = false;
  private subscriberCounter = 0;
  private _deps: BackendDeps | null;
  /**
   * Storage config supplied by the worker transport's out-of-band
   * `worker_config` message. Read by `init` when building the
   * deferred-mode dependency bundle. Stays `null` for tests that
   * construct `GremlinServer` with a pre-built deps stub.
   */
  private bootstrapStorageConfig: StorageConfig | null = null;
  /**
   * Worker-injected adapter factories. Mirrors `bootstrapStorageConfig` —
   * the worker entry calls `setBootstrapAdapterFactories` at module load
   * (no awaiting required) and `init` reads them when building the
   * deferred-mode `BackendDeps` bundle. Stays `null` in tests that don't
   * exercise factory-using code (the contract test, the in-process
   * `GremlinServer.test.ts` stream tests).
   */
  private bootstrapAdapterFactories: {
    createStorageAdapter: CreateStorageAdapter;
    createVfsAdapter: CreateVfsAdapter;
  } | null = null;
  /**
   * Per-project VFS adapter cache. Reused across calls so the local
   * adapter doesn't have to re-acquire the per-project tree lock state on
   * every operation.
   */
  private readonly vfsAdapters = new Map<string, VfsAdapter>();

  constructor(deps: BackendDeps | null = null) {
    this._deps = deps;
    // Reuse the registry from deps when supplied (test stubs build a
    // pre-baked bundle and pass it through). Otherwise mint a fresh one —
    // the deferred `init()` path keeps using `this.registry` and injects
    // it into the newly-built deps bundle so both paths converge on the
    // same instance.
    this.registry = deps?.loopRegistry ?? new LoopRegistry();
  }

  /**
   * Out-of-band bootstrap channel for the worker transport. The main
   * thread reads the storage config from its localStorage (the only
   * place that touches it) and posts it via a `worker_config` message
   * before sending the `init` request. The worker entry calls this
   * setter to stash the config; `init` reads it when constructing the
   * deferred-mode `BackendDeps` bundle.
   */
  setBootstrapStorageConfig(config: StorageConfig): void {
    this.bootstrapStorageConfig = config;
  }

  /**
   * Out-of-band bootstrap channel for the worker-side adapter factories.
   * The worker entry imports `createStorageAdapter` / `createVfsAdapter`
   * from `src/worker/adapters/` and calls this setter once at module load,
   * before sending `worker_ready`. `init` reads the factories when
   * constructing the deferred-mode `BackendDeps` bundle so the dispatcher
   * can build storage / VFS adapters without depending on browser-only
   * inner adapter classes from inside `src/shared/`.
   */
  setBootstrapAdapterFactories(factories: {
    createStorageAdapter: CreateStorageAdapter;
    createVfsAdapter: CreateVfsAdapter;
  }): void {
    this.bootstrapAdapterFactories = factories;
  }

  /**
   * Guarded deps accessor. Throws `NOT_INITIALIZED` if the bundle hasn't
   * been brought up yet (deferred-mode worker before `init`). Every
   * dispatcher arm reads `this.storage` (or one of the other accessors)
   * so the guard fires uniformly.
   */
  private get deps(): BackendDeps {
    if (!this._deps) {
      throw new ProtocolError(
        'NOT_INITIALIZED',
        'GremlinServer has not been initialized — call init({cek}) first'
      );
    }
    return this._deps;
  }

  private get storage(): UnifiedStorage {
    return this.deps.storage;
  }

  private get apiService(): APIService {
    return this.deps.apiService;
  }

  private get toolRegistry(): ClientSideToolRegistry {
    return this.deps.toolRegistry;
  }

  // ==========================================================================
  // Public dispatch surface — used by transports
  // ==========================================================================

  /**
   * Dispatch a one-shot RPC. Throws `ProtocolError` (or any other Error) on
   * failure; the transport is responsible for wrapping into an envelope.
   *
   * Note: this method does *not* enforce that `init()` has been called.
   * The Phase 2 WebSocket transport gates non-init RPCs at the *transport*
   * layer (a connection isn't accepted until the first `init` envelope is
   * processed). The Phase 1 in-process server is happy to lazy-init storage
   * on first call — `dispatchOneShot` calls `ensureInitialized` for any
   * non-init method below.
   */
  async handleRequest<M extends keyof GremlinMethods>(
    method: M,
    params: MethodParams<M>
  ): Promise<MethodResult<M>> {
    if (!INIT_EXEMPT_METHODS.has(method as string)) {
      await this.ensureInitialized();
    }
    // The cast at the end is the one place we erase the union — every case
    // arm below returns the correct concrete result for its method.
    const result = await this.dispatchOneShot(method, params);
    return result as MethodResult<M>;
  }

  /**
   * Dispatch a streaming RPC. Returns an async generator yielding the
   * method's stream event type. The transport iterates this generator and
   * wraps each yielded value in a `StreamEventEnvelope`. When the generator
   * returns (or throws) the transport emits a `StreamEndEnvelope` with the
   * appropriate status.
   */
  handleStream<M extends keyof GremlinMethods>(
    method: M,
    params: MethodParams<M>
  ): AsyncGenerator<GremlinMethods[M]['streams'], void, void> {
    // Lazy-init wrapper: defer the actual generator until `next()` so we
    // can `await ensureInitialized()` before yielding the first event.
    const init = () => this.ensureInitialized();
    const dispatch = () => this.dispatchStream(method, params);
    async function* withInit() {
      await init();
      yield* dispatch();
    }
    return withInit() as AsyncGenerator<GremlinMethods[M]['streams'], void, void>;
  }

  /**
   * Idempotent: brings up `UnifiedStorage` on the first call.
   *
   * Deferred mode is the only mode after Phase 1.65: `_deps` is `null`
   * until `init()` runs, `init` pre-keys the encryption core from the
   * `cek` parameter, and then dispatches here. Reaching this method
   * without a successful `init` is a contract violation — throw
   * `NOT_INITIALIZED` so the bug shows up at the call site.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (!this._deps) {
      throw new ProtocolError(
        'NOT_INITIALIZED',
        'GremlinServer has not been initialized — call init({cek}) first'
      );
    }
    await this._deps.storage.initialize();
    this.initialized = true;
  }

  // ==========================================================================
  // One-shot dispatch
  // ==========================================================================

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async dispatchOneShot(method: string, params: any): Promise<any> {
    switch (method) {
      // ----- lifecycle -----
      case 'init':
        return this.init(params as InitParams);

      // ----- projects -----
      case 'listProjects':
        return this.storage.getProjects();
      case 'getProject':
        return this.storage.getProject(params.projectId);
      case 'saveProject':
        await this.storage.saveProject(params.project);
        return { ok: true };
      case 'deleteProject':
        await this.storage.deleteProject(params.projectId);
        return { ok: true };

      // ----- chats -----
      case 'listChats':
        return this.listChatsWithMessageCounts(params.projectId);
      case 'getChat':
        return this.storage.getChat(params.chatId);
      case 'saveChat':
        await this.storage.saveChat(params.chat);
        return { ok: true };
      case 'deleteChat':
        await this.storage.deleteChat(params.chatId);
        return { ok: true };
      case 'cloneChat': {
        const source = await this.storage.getChat(params.chatId);
        if (!source) {
          throw new ProtocolError('CHAT_NOT_FOUND', `chat ${params.chatId} not found`);
        }
        const cloned = await this.storage.cloneChat(
          params.chatId,
          source.projectId,
          params.upToMessageId,
          params.forkMessageContent
        );
        if (!cloned) {
          throw new ProtocolError('INTERNAL_ERROR', 'cloneChat returned null');
        }
        return { newChatId: cloned.id };
      }
      case 'getMessageCount':
        return { count: await this.storage.getMessageCount(params.chatId) };

      // ----- messages -----
      case 'listMessages': {
        const persisted = await this.storage.getMessages(params.chatId);
        return persisted.map(prepareMessageForWire);
      }
      case 'saveMessage':
        await this.storage.saveMessage(params.chatId, params.message);
        // The save may have replaced the chat's tail message — recompute
        // the incomplete-tail lock so any subscriber re-renders the
        // resolution banner appropriately.
        await this.broadcastChatLockState(params.chatId);
        return { ok: true };
      case 'deleteMessageAndAfter':
        await this.storage.deleteMessageAndAfter(params.chatId, params.messageId);
        await this.broadcastChatLockState(params.chatId);
        return { ok: true };
      case 'deleteSingleMessage':
        await this.storage.deleteSingleMessage(params.messageId);
        // Single-message delete is the minion-chat trim path; the message id
        // does not carry its parent chat, so we can't recompute the lock
        // state for the affected main chat from here. Minion chats have
        // their own (independent) message stream — they never participate
        // in the incomplete-tail lock — so this path is a no-op for the
        // sidebar lock UI.
        return { ok: true };

      // ----- minion chats -----
      case 'getMinionChat':
        return this.storage.getMinionChat(params.minionChatId);
      case 'listMinionMessages': {
        const persisted = await this.storage.getMinionMessages(params.minionChatId);
        return persisted.map(prepareMessageForWire);
      }

      // ----- API definitions / models -----
      case 'listAPIDefinitions':
        return this.storage.getAPIDefinitions();
      case 'getAPIDefinition':
        return this.storage.getAPIDefinition(params.apiDefId);
      case 'saveAPIDefinition':
        await this.storage.saveAPIDefinition(params.apiDef);
        return { ok: true };
      case 'deleteAPIDefinition':
        await this.storage.deleteAPIDefinition(params.apiDefId);
        return { ok: true };
      case 'discoverModels': {
        const apiDef = await this.storage.getAPIDefinition(params.apiDefId);
        if (!apiDef) {
          throw new ProtocolError('INVALID_PARAMS', `API definition ${params.apiDefId} not found`);
        }
        return { models: await this.discoverModelsWithFallback(apiDef) };
      }
      case 'getModelsCache': {
        const cached = await this.storage.getModelsWithCache(params.apiDefId);
        return {
          models: cached.models,
          cachedAt: cached.cachedAt ? cached.cachedAt.getTime() : null,
        };
      }
      case 'saveModelsCache':
        await this.storage.saveModels(params.apiDefId, params.models);
        return { ok: true };
      case 'deleteModelsCache':
        await this.storage.deleteModels(params.apiDefId);
        return { ok: true };

      // ----- storage / data -----
      case 'getStorageQuota': {
        const quota = await this.storage.getStorageQuota();
        return quota ?? { usage: 0, quota: 0 };
      }
      case 'purgeAllData':
        assertNoLoopsRunning(this.registry, 'purgeAllData');
        await this.storage.purgeAllData();
        // Drop the deps bundle so subsequent RPCs return NOT_INITIALIZED
        // until the frontend reconnects with a fresh `init`. The
        // pre-purge encryption core was forgotten by `purgeAllData`.
        this._deps = null;
        this.initialized = false;
        this.vfsAdapters.clear();
        return { ok: true };
      case 'compressAllMessages': {
        const result = await this.storage.compressAllMessages();
        return { compressedCount: result.compressed };
      }
      case 'isStorageEmpty':
        return { empty: await this.storage.isStorageEmpty() };

      // ----- attachments -----
      case 'getAttachments':
        return { attachments: await this.storage.getAttachments(params.messageId) };
      case 'getAllAttachmentSections':
        return { sections: await this.storage.getAllAttachmentSections() };
      case 'deleteAttachment': {
        const messageId = await this.storage.deleteAttachment(params.attachmentId);
        return { messageId };
      }
      case 'updateMessageAttachmentIds':
        await this.storage.updateMessageAttachmentIds(
          params.chatId,
          params.messageId,
          params.attachmentIds
        );
        return { ok: true };
      case 'deleteAttachmentsOlderThan':
        return this.storage.deleteAttachmentsOlderThan(params.days);

      // ----- tool inventory -----
      case 'listTools':
        return { tools: this.listTools() };

      // ----- encryption / CEK -----
      case 'validateRemoteStorage':
        return this.validateRemoteStorage(params.baseUrl, params.password, params.userId);
      case 'tryDecryptSample':
        return this.tryDecryptSample(params.cek, params.sampleCipherText);
      case 'rotateCek':
        return this.rotateCek(params.newCek);
      case 'clearCek':
        return this.clearCek();
      case 'getCekState':
        return { initialized: this.deps.encryption.isInitialized() };
      case 'deriveUserId':
        return { userId: await this.deps.encryption.deriveUserId() };
      case 'generateNewCEK':
        return { cek: bytesToBase32(crypto.getRandomValues(new Uint8Array(32))) };
      case 'normalizeCEK':
        return { cek: convertCEKToBase32(params.input) };
      case 'deriveUserIdFromCEK': {
        const probe = new EncryptionCore();
        await probe.initializeWithCEK(params.cek);
        return { userId: await probe.deriveUserId() };
      }

      // ----- VFS dispatch -----
      case 'vfsList': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        return { entries: await adapter.readDir(params.path, params.includeDeleted) };
      }
      case 'vfsRead': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        return { content: await adapter.readFile(params.path) };
      }
      case 'vfsReadWithMeta': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        return adapter.readFileWithMeta(params.path);
      }
      case 'vfsWrite': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        await adapter.writeFile(params.path, params.content);
        return { ok: true };
      }
      case 'vfsCreateFile': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        await adapter.createFile(params.path, params.content);
        return { ok: true };
      }
      case 'vfsDeleteFile': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        await adapter.deleteFile(params.path);
        return { ok: true };
      }
      case 'vfsMkdir': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        await adapter.mkdir(params.path);
        return { ok: true };
      }
      case 'vfsRmdir': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        await adapter.rmdir(params.path, params.recursive);
        return { ok: true };
      }
      case 'vfsRename': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        await adapter.rename(params.oldPath, params.newPath, params.overwrite);
        return { ok: true };
      }
      case 'vfsExists': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        return { exists: await adapter.exists(params.path) };
      }
      case 'vfsIsFile': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        return { isFile: await adapter.isFile(params.path) };
      }
      case 'vfsIsDirectory': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        return { isDirectory: await adapter.isDirectory(params.path) };
      }
      case 'vfsStat': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        return adapter.stat(params.path);
      }
      case 'vfsHasVfs': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        return { hasVfs: await adapter.hasVfs() };
      }
      case 'vfsClearVfs': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        await adapter.clearVfs();
        return { ok: true };
      }
      case 'vfsStrReplace': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        return adapter.strReplace(params.path, params.oldStr, params.newStr);
      }
      case 'vfsInsert': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        return adapter.insert(params.path, params.line, params.text);
      }
      case 'vfsAppendFile': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        return adapter.appendFile(params.path, params.text);
      }
      case 'vfsGetFileMeta': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        return { meta: await adapter.getFileMeta(params.path) };
      }
      case 'vfsGetFileId': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        return { fileId: await adapter.getFileId(params.path) };
      }
      case 'vfsListVersions': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        return { versions: await adapter.listVersions(params.fileId) };
      }
      case 'vfsGetVersion': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        return { content: await adapter.getVersion(params.fileId, params.version) };
      }
      case 'vfsDropOldVersions': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        return {
          dropped: await adapter.dropOldVersions(params.fileId, params.keepCount),
        };
      }
      case 'vfsListOrphans': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        return { orphans: await adapter.listOrphans() };
      }
      case 'vfsRestoreOrphan': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        await adapter.restoreOrphan(params.fileId, params.targetPath);
        return { ok: true };
      }
      case 'vfsPurgeOrphan': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        await adapter.purgeOrphan(params.fileId);
        return { ok: true };
      }
      case 'vfsCopyFile': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        await adapter.copyFile(params.src, params.dst, params.overwrite);
        return { ok: true };
      }
      case 'vfsDeletePath': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        await adapter.deletePath(params.path);
        return { ok: true };
      }
      case 'vfsCreateFileGuarded': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        await adapter.createFileGuarded(params.path, params.content, params.overwrite);
        return { ok: true };
      }
      case 'vfsEnsureDirAndWrite': {
        const adapter = await this.getProjectVfsAdapter(params.projectId);
        await adapter.ensureDirAndWrite(params.dir, params.files);
        return { ok: true };
      }

      // ----- active loops -----
      case 'listActiveLoops':
        return this.registry.list();
      case 'abortLoop': {
        const ok = this.registry.abort(params.loopId);
        if (!ok) {
          throw new ProtocolError('LOOP_NOT_FOUND', `no running loop with id ${params.loopId}`);
        }
        return { ok: true };
      }
      case 'softStopLoop': {
        const ok = this.registry.softStop(params.loopId);
        if (!ok) {
          throw new ProtocolError('LOOP_NOT_FOUND', `no running loop with id ${params.loopId}`);
        }
        return { ok: true };
      }

      // ----- startLoop (fire-and-forget) -----
      case 'startLoop':
        return this.startLoop(params as RunLoopParams);

      // ----- project bundle -----
      case 'importProject':
        return runProjectImport(this.deps, params.bundleJson);

      default:
        throw new ProtocolError('METHOD_NOT_FOUND', `unknown method: ${method}`);
    }
  }

  // ==========================================================================
  // Streaming dispatch
  // ==========================================================================

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async *dispatchStream(method: string, params: any): AsyncGenerator<any, void, void> {
    switch (method) {
      case 'runLoop':
        yield* this.runLoop(params as RunLoopParams);
        return;
      case 'attachChat':
        yield* this.attachChat(params.chatId);
        return;
      case 'subscribeActiveLoops':
        yield* this.subscribeActiveLoops();
        return;
      case 'exportData':
        yield* this.exportData();
        return;
      case 'importData':
        yield* this.importData(params as ImportDataParams);
        return;
      case 'vfsCompactProject':
        yield* this.vfsCompactProject(params.projectId, params.options);
        return;
      case 'exportProject':
        yield* this.exportProject(params.projectId);
        return;
      default:
        throw new ProtocolError('METHOD_NOT_FOUND', `unknown stream method: ${method}`);
    }
  }

  /**
   * `runLoop` dispatch arm. Mints a fresh `loopId` + `AbortController`,
   * constructs a per-call `ChatRunner`, and forwards the runner's
   * `LoopEvent` stream out to the transport. Concurrency / incomplete-tail
   * checks live inside `ChatRunner.run` so they share the same context
   * load.
   */
  private async *runLoop(params: RunLoopParams): AsyncGenerator<LoopEvent, void, void> {
    const loopId = generateUniqueId('loop');
    const abortController = new AbortController();
    const runner = new ChatRunner(this.deps, this.registry);
    yield* runner.run(params, abortController, loopId);
  }

  /**
   * `startLoop` one-shot dispatch arm. Validates the chat synchronously
   * (loop_started must yield before this returns), then continues driving
   * the loop in the background and broadcasts every `LoopEvent` to per-chat
   * subscribers via `LoopRegistry.broadcastChatEvent`.
   *
   * The "validate before returning" trick relies on `ChatRunner.run` doing
   * all of its CHAT_BUSY / CHAT_INCOMPLETE_TAIL / context-load checks
   * BEFORE the first yield. Pulling the first event therefore either throws
   * the typed `ProtocolError` synchronously or returns a `loop_started`
   * event we can broadcast and then hand off the rest of the loop to a
   * background task.
   */
  private async startLoop(params: RunLoopParams): Promise<{ loopId: LoopId }> {
    const loopId = generateUniqueId('loop');
    const abortController = new AbortController();
    const runner = new ChatRunner(this.deps, this.registry);
    const gen = runner.run(params, abortController, loopId);

    // Drive the generator until the first yield. If validation fails the
    // ProtocolError surfaces here and the RPC rejects synchronously.
    const first = await gen.next();
    if (first.done) {
      throw new ProtocolError(
        'INTERNAL_ERROR',
        'startLoop: runner returned without yielding loop_started'
      );
    }
    this.registry.broadcastChatEvent(params.chatId, first.value);

    // Continue draining the generator in the background. Errors thrown
    // mid-loop are caught and broadcast as a synthetic `loop_ended {error}`
    // so subscribers transition out of the running state.
    void (async () => {
      try {
        while (true) {
          const r = await gen.next();
          if (r.done) break;
          this.registry.broadcastChatEvent(params.chatId, r.value);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[GremlinServer.startLoop] background loop error:', message);
        this.registry.broadcastChatEvent(params.chatId, {
          type: 'loop_ended',
          loopId,
          status: 'error',
          detail: message,
        });
      }
    })();

    return { loopId };
  }

  /**
   * `subscribeActiveLoops` dispatch arm. Returns an async generator that
   * yields `ActiveLoopsChange` events from `LoopRegistry.subscribe`. The
   * registry's callback API is converted into a generator using a queue +
   * waiter pattern: each broadcast pushes onto `queue` and resolves any
   * pending `next()` waiter.
   *
   * The subscription stays open until the consumer closes the generator,
   * which fires the cleanup `finally` block and unregisters from the
   * registry. Phase 1 has no per-client subscriber accounting; the Phase 2
   * WebSocket transport will fan out via `subscriberId`.
   */
  private async *subscribeActiveLoops(): AsyncGenerator<ActiveLoopsChange, void, void> {
    const queue: ActiveLoopsChange[] = [];
    let resolveNext: (() => void) | null = null;

    const unsubscribe = this.registry.subscribe(change => {
      queue.push(change);
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    });

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        await new Promise<void>(resolve => {
          resolveNext = resolve;
        });
      }
    } finally {
      unsubscribe();
    }
  }

  /**
   * `attachChat` dispatch arm. Long-lived stream that delivers a snapshot
   * (chat + persisted messages) followed by live `LoopEvent`s for any loop
   * running on this chat. The subscription stays open until the consumer
   * cancels the stream — that's what makes "navigate away → come back"
   * resume the live event stream from a still-running loop.
   *
   * Order of operations is important to avoid losing events:
   *   1. Subscribe to the chat pubsub FIRST so live events arriving during
   *      the snapshot read are queued.
   *   2. Read the chat + messages from storage and yield them as
   *      `chat_updated` / `message_created` events (the frontend handles
   *      these the same way it handles live events).
   *   3. Drain the queued live events.
   *   4. Continue yielding live events as they arrive, blocking on a
   *      promise waiter when the queue is empty.
   *
   * The snapshot phase yields a `lock_state_changed` event before
   * `snapshot_complete` so the frontend can drive the incomplete-tail
   * banner without re-deriving the predicate locally. Live mutations
   * (delete-message, save-message, agentic loop terminal events) broadcast
   * their own `lock_state_changed` updates through the chat pubsub via
   * `broadcastChatLockState`.
   */
  private async *attachChat(chatId: string): AsyncGenerator<LoopEvent, void, void> {
    const queue: LoopEvent[] = [];
    let resolveNext: (() => void) | null = null;

    const unsubscribe = this.registry.subscribeChatEvents(chatId, event => {
      queue.push(event);
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    });

    try {
      const chat = await this.storage.getChat(chatId);
      if (!chat) {
        throw new ProtocolError('CHAT_NOT_FOUND', `chat ${chatId} not found`);
      }
      const messages = await this.storage.getMessages(chatId);
      yield { type: 'chat_updated', chat };
      for (const message of messages) {
        yield { type: 'message_created', message: prepareMessageForWire(message) };
      }

      // Replay running-loop state. The chat-pubsub subscription set up
      // above only catches *future* events; if a loop was already running
      // when the consumer re-attached, its original `loop_started` was
      // emitted earlier and is gone. Synthesize one from the registry so
      // the frontend's loopPhase transitions to `pending` immediately
      // instead of waiting for the next streaming event. `runLoop` enforces
      // CHAT_BUSY (one loop per chat at a time), so at most one entry will
      // match. A duplicate `loop_started` from a race with the queue is
      // harmless: the frontend handler resets loopPhase to `pending` and
      // clears soft-stop, both idempotent for an already-running loop.
      const runningLoop = this.registry.list().find(loop => loop.chatId === chatId);
      if (runningLoop) {
        yield {
          type: 'loop_started',
          loopId: runningLoop.loopId,
          parentLoopId: runningLoop.parentLoopId,
        };
      }

      // Replay any in-flight pending tool results that the live broadcast
      // path captured while no one was subscribed. Each entry produces a
      // `pending_tool_result` (so the frontend re-inserts the placeholder
      // message — the de-dupe by id makes a duplicate harmless if storage
      // somehow already had it) and a `tool_block_update` carrying the
      // merged accumulated block state. The frontend handler accumulates
      // updates with the same `{...existing, ...new}` semantics, so any
      // live event arriving immediately after lands cleanly on top.
      const pending = this.registry.getPendingToolResults(chatId);
      // Group by message id so we yield each placeholder message once
      // even when it covers multiple toolUseIds (parallel tool calls).
      const seenMessageIds = new Set<string>();
      for (const entry of pending) {
        if (!seenMessageIds.has(entry.message.id)) {
          seenMessageIds.add(entry.message.id);
          yield { type: 'pending_tool_result', message: prepareMessageForWire(entry.message) };
        }
        if (Object.keys(entry.mergedBlock).length > 0) {
          yield {
            type: 'tool_block_update',
            toolUseId: entry.toolUseId,
            block: entry.mergedBlock,
          };
        }
      }

      // Authoritative incomplete-tail lock state, computed from the same
      // messages we just delivered. Yielded directly (not broadcast through
      // the chat pubsub) so the consumer always sees its own snapshot value
      // before any drained live event.
      yield { type: 'lock_state_changed', locked: isChatLockedByIncompleteTail(messages) };

      // Marker so the frontend knows the snapshot phase is done — used to
      // fire `onMessagesLoaded` and clear any "loading" placeholders.
      yield { type: 'snapshot_complete' };

      // Drain queued live events + continue blocking for new ones until the
      // consumer cancels the stream (which fires the finally below).
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        await new Promise<void>(resolve => {
          resolveNext = resolve;
        });
      }
    } finally {
      unsubscribe();
    }
  }

  /**
   * Recompute the incomplete-tail lock state for a chat from storage and
   * broadcast it to every active `attachChat` subscriber via the chat
   * pubsub. Called from every mutation path that could change the chat's
   * tail message: `deleteMessageAndAfter`, `saveMessage`, and the agentic
   * loop's terminal teardown (yielded from `ChatRunner.run` so it flows
   * through the same broadcast plumbing as every other LoopEvent).
   *
   * The frontend's `useChat` consumes the resulting `lock_state_changed`
   * event to drive the resolution banner — Phase 1.7 moved this off the
   * frontend so the React layer no longer imports `isChatLockedByIncompleteTail`.
   */
  private async broadcastChatLockState(chatId: string): Promise<void> {
    try {
      const messages = await this.storage.getMessages(chatId);
      this.registry.broadcastChatEvent(chatId, {
        type: 'lock_state_changed',
        locked: isChatLockedByIncompleteTail(messages),
      });
    } catch (err) {
      // Lock state recompute is best-effort cosmetic state — never fail an
      // upstream RPC because storage hiccupped while reading messages.
      console.error('[GremlinServer.broadcastChatLockState] failed:', err);
    }
  }

  /**
   * `exportData` dispatch arm. Streams the encrypted-CSV bundle as a sequence
   * of `chunk` events plus a terminal `done` event with the suggested
   * filename. The frontend assembles the chunks into a `Blob` and triggers
   * the download anchor click on the main thread.
   */
  private async *exportData(): AsyncGenerator<ExportEvent, void, void> {
    yield* runExport(this.storage, this.deps.encryption);
  }

  /**
   * `importData` dispatch arm. Receives the uploaded bundle as a
   * `Uint8Array` (the frontend reads `File` to bytes before posting through),
   * runs the existing CSV import pipeline against the in-process storage,
   * and emits progress events. The terminal `done` event carries the final
   * counts.
   */
  private async *importData(params: ImportDataParams): AsyncGenerator<ImportProgress, void, void> {
    assertNoLoopsRunning(this.registry, 'importData');
    yield* runImport(this.storage, this.deps.encryption, params);
  }

  /**
   * `exportProject` dispatch arm. Streams a single project's bundle
   * (one progress event per file loaded, terminal `done` carrying the
   * serialized JSON). Reads storage + encryption from the per-server
   * `BackendDeps` so worker mode never reaches for the singletons.
   */
  private async *exportProject(projectId: string): AsyncGenerator<ProjectExportEvent, void, void> {
    yield* runProjectExport(this.deps, projectId);
  }

  /**
   * `vfsCompactProject` dispatch arm. Wraps the local/remote adapter's
   * `compactProject` callback API into a streamable generator: each
   * progress callback push enqueues a `progress` event, and the final
   * `CompactResult` is emitted as a `done` event.
   */
  private async *vfsCompactProject(
    projectId: string,
    options?: import('../services/vfs/vfsService').CompactOptions
  ): AsyncGenerator<VfsCompactEvent, void, void> {
    const adapter = await this.getProjectVfsAdapter(projectId);

    const queue: VfsCompactEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let done = false;
    let error: unknown = null;
    let finalResult: import('../services/vfs/vfsService').CompactResult | null = null;

    const drain = async () => {
      try {
        finalResult = await adapter.compactProject(progress => {
          queue.push({ type: 'progress', progress });
          if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r();
          }
        }, options);
      } catch (err) {
        error = err;
      } finally {
        done = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r();
        }
      }
    };

    const compactPromise = drain();

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) break;
        await new Promise<void>(resolve => {
          resolveNext = resolve;
        });
      }
      // Drain anything that landed between the loop break and now.
      while (queue.length > 0) yield queue.shift()!;

      if (error) {
        throw error;
      }
      if (finalResult) {
        yield { type: 'done', result: finalResult };
      }
    } finally {
      // Make sure the compact promise settles even if the consumer
      // bailed mid-stream — we don't want a dangling unhandled rejection.
      await compactPromise.catch(() => {});
    }
  }

  // ==========================================================================
  // Helper implementations for the new dispatch arms
  // ==========================================================================

  /**
   * `listChats` backfill: load chats from storage, then compute and persist
   * `messageCount` for any chat where it's missing. The frontend used to do
   * this in a `useEffect` (an N+1 round-trip + a fire-and-forget save back
   * to the worker per chat) — see project memory note "be → fe → be
   * anti-pattern". Server-side it's idempotent: chats with a populated
   * count skip the work entirely.
   */
  private async listChatsWithMessageCounts(
    projectId: string
  ): Promise<import('../protocol/types').Chat[]> {
    const chats = await this.storage.getChats(projectId);

    for (const chat of chats) {
      if (chat.messageCount == undefined) {
        chat.messageCount = await this.storage.getMessageCount(chat.id);
        await this.storage.saveChat(chat);
      }
    }

    return chats;
  }

  /**
   * `discoverModels` orchestration. Phase 1.8 leak fix: the frontend used
   * to call `mergeExtraModels` on two sad paths (no API key configured,
   * provider discovery threw) and write the cache itself. Both jobs land
   * here so the frontend can collapse to a single
   * `gremlinClient.discoverModels` call with no `mergeExtraModels` import.
   *
   *   - **No API key**: providers that need a key (`isLocal: false`) skip
   *     the network round-trip and return only the user-configured
   *     `extraModelIds`. Cache is written with the extras so subsequent
   *     `getModelsCache` calls see the same shape.
   *   - **Discovery threw**: same fallback, but the cache is *not* updated
   *     — preserving whatever the previous good run wrote so transient
   *     network failures don't clobber the model list.
   *   - **Success**: cache is written with the merged result and returned.
   */
  private async discoverModelsWithFallback(
    apiDef: import('../protocol/types').APIDefinition
  ): Promise<import('../protocol/types').Model[]> {
    const needsApiKey = !apiDef.isLocal;
    const noKey = needsApiKey && (!apiDef.apiKey || apiDef.apiKey.trim() === '');
    if (noKey) {
      const extras = mergeExtraModels([], apiDef);
      await this.storage.saveModels(apiDef.id, extras);
      return extras;
    }

    let models: import('../protocol/types').Model[];
    try {
      models = await this.apiService.discoverModels(apiDef);
    } catch (err) {
      console.error('[GremlinServer.discoverModels] provider failed:', err);
      // Don't touch the cache — leave whatever the last successful run
      // wrote so a transient blip doesn't clobber the model list. Return
      // the extras so the UI still has something to render.
      return mergeExtraModels([], apiDef);
    }

    await this.storage.saveModels(apiDef.id, models);
    return models;
  }

  /** Project the in-process tool registry into wire-safe inventory entries. */
  private listTools(): ToolInventoryEntry[] {
    return this.toolRegistry.getVisibleTools().map(tool => ({
      name: tool.name,
      displayName: tool.displayName,
      displaySubtitle: tool.displaySubtitle,
      optionDefinitions: tool.optionDefinitions,
    }));
  }

  /**
   * Probe a remote storage backend with the supplied credentials. Wraps
   * the existing `RemoteStorageAdapter.initialize()` health-check; we
   * intentionally swallow the error and surface it in the result so the
   * UI can render a friendly message.
   */
  private async validateRemoteStorage(
    baseUrl: string,
    password: string,
    userId: string
  ): Promise<{ ok: boolean; error?: string }> {
    const factory = this.deps.createStorageAdapter;
    if (!factory) {
      throw new ProtocolError(
        'INTERNAL_ERROR',
        'validateRemoteStorage: createStorageAdapter factory not injected — worker entry must call setBootstrapAdapterFactories'
      );
    }
    try {
      const probe = factory({ type: 'remote', baseUrl, userId, password });
      await probe.initialize();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Test-decrypt a single ciphertext sample with a candidate CEK. Used by
   * OOBE's "use existing remote" flow to verify the user-entered CEK
   * matches the data on the server before running `init`. We build a
   * disposable `EncryptionCore` for the probe so the active per-server
   * encryption (if any) is never touched.
   */
  private async tryDecryptSample(cek: string, sampleCipherText: string): Promise<{ ok: boolean }> {
    try {
      const probe = new EncryptionCore();
      await probe.initializeWithCEK(cek);
      await probe.decrypt(sampleCipherText);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Re-encrypt every record in storage with a new CEK and transition the
   * server back to dormant. The active core never mutates: a temporary
   * `EncryptionCore` is built for the new key, the active core keeps
   * decrypting existing rows during the walk, and once every table has
   * been re-encrypted under the new key the server clears its deps
   * bundle. Subsequent RPCs return `NOT_INITIALIZED` until the frontend
   * reconnects with a fresh `init({cek: newCek})`.
   *
   * Idempotent: if the new CEK matches the current one, returns
   * `{rotatedRows: 0}` without touching storage and without dropping the
   * deps bundle.
   *
   * Refuses to run while any agentic loop is active — the running loop
   * holds references to the storage / encryption handles and would
   * otherwise be left writing to a half-rotated database.
   */
  private async rotateCek(newCek: string): Promise<{ rotatedRows: number }> {
    assertNoLoopsRunning(this.registry, 'rotateCek');

    const activeEncryption = this.deps.encryption;
    const tempCore = new EncryptionCore();
    await tempCore.initializeWithCEK(newCek);

    if (activeEncryption.hasSameKeyAs(tempCore)) {
      return { rotatedRows: 0 };
    }

    const adapter = this.storage.getAdapter();
    const tablesToRotate = [
      Tables.API_DEFINITIONS,
      Tables.MODELS_CACHE,
      Tables.PROJECTS,
      Tables.CHATS,
      Tables.MINION_CHATS,
      Tables.MESSAGES,
      Tables.ATTACHMENTS,
      Tables.VFS_META,
      Tables.VFS_FILES,
      Tables.VFS_VERSIONS,
    ];

    let rotated = 0;
    for (const table of tablesToRotate) {
      rotated += await this.rotateTable(adapter, table, tempCore);
    }

    // Transition to dormant: drop the deps bundle and forget the
    // in-memory key. The next RPC throws `NOT_INITIALIZED` so the
    // frontend knows to reconnect with the new CEK.
    activeEncryption.forget();
    this._deps = null;
    this.initialized = false;
    this.vfsAdapters.clear();

    return { rotatedRows: rotated };
  }

  /**
   * Walk one table page-by-page, decrypt each row with the active
   * per-server encryption key, re-encrypt under the supplied `newCore`,
   * and write back via `batchSave`. Uses the same `exportPaginated` cursor
   * as `dataExport`.
   */
  private async rotateTable(
    adapter: StorageAdapter,
    table: string,
    newCore: EncryptionCore
  ): Promise<number> {
    const activeEncryption = this.deps.encryption;
    let cursor: string | undefined = undefined;
    let rotated = 0;

    while (true) {
      const page = await adapter.exportPaginated(table, cursor);
      if (page.rows.length === 0) break;

      const rotatedRows: typeof page.rows = [];
      for (const row of page.rows) {
        const plaintext = await activeEncryption.decryptWithDecompression(row.encryptedData);
        const reencrypted = await newCore.encryptWithCompression(plaintext, true);

        rotatedRows.push({
          id: row.id,
          encryptedData: reencrypted,
          timestamp: row.timestamp,
          parentId: row.parentId,
          unencryptedData: row.unencryptedData,
        });
      }

      await adapter.batchSave(table, rotatedRows, false);
      rotated += rotatedRows.length;

      if (!page.hasMore) break;
      cursor = page.rows[page.rows.length - 1].id;
    }

    return rotated;
  }

  /**
   * Tear down the in-memory CEK + storage. Used by the Data Manager's
   * "Detach Remote Storage" flow. The frontend handles localStorage
   * cleanup separately so the worker stays sandboxed.
   *
   * Refuses to run while any agentic loop is active — pulling the
   * storage adapter out from under a streaming chat would corrupt the
   * in-progress message.
   */
  private async clearCek(): Promise<{ ok: true }> {
    assertNoLoopsRunning(this.registry, 'clearCek');
    this.deps.encryption.forget();
    this._deps = null;
    this.initialized = false;
    this.vfsAdapters.clear();
    return { ok: true };
  }

  // ==========================================================================
  // Implementations
  // ==========================================================================

  /**
   * Bootstrap the server.
   *
   * After Phase 1.65 there's a single production path: deferred-mode
   * worker init. `_deps` starts `null`, the caller passes `{cek}`, the
   * storage config arrived separately via the worker's out-of-band
   * `worker_config` message (read from `this.bootstrapStorageConfig`),
   * and the worker entry already injected adapter factories via
   * `setBootstrapAdapterFactories`. We construct a fresh `EncryptionCore`,
   * `UnifiedStorage`, `APIService`, and per-instance `ClientSideToolRegistry`
   * from those pieces and assemble them into `BackendDeps`.
   *
   * Tests can construct `GremlinServer` with a pre-built `BackendDeps`
   * stub; in that case `init` may be called with no `cek` and just
   * confirms `ensureInitialized()` (which is a no-op once `_deps` is
   * already set and storage has been brought up).
   *
   * Re-`init` with the same CEK is idempotent. Re-`init` with a different
   * CEK is rejected with `code: 'CEK_MISMATCH'` — to change identity, the
   * caller must `purgeAllData` (or `clearCek`) first. Posting any field
   * other than the documented `cek` / `subscriberId` is rejected with
   * `INVALID_PARAMS` so a stale client can't smuggle a `storageConfig`
   * past the dispatch.
   */
  private async init(params: InitParams): Promise<InitResult> {
    // Reject unknown fields. The protocol contract is locked: only `cek`
    // and `subscriberId`. A client posting `storageConfig` (or any other
    // field) is using a stale build — fail loudly so the bug surfaces.
    const allowedKeys = new Set(['cek', 'subscriberId']);
    for (const key of Object.keys(params ?? {})) {
      if (!allowedKeys.has(key)) {
        throw new ProtocolError(
          'INVALID_PARAMS',
          `init: unknown field '${key}' — protocol accepts only {cek, subscriberId}`
        );
      }
    }

    if (params.cek) {
      const cekString = params.cek;

      // Re-init guard: if a deps bundle already exists, the new CEK must
      // match the active one. Different CEK → CEK_MISMATCH.
      if (this._deps) {
        const candidate = new EncryptionCore();
        await candidate.initializeWithCEK(cekString);
        if (!this._deps.encryption.hasSameKeyAs(candidate)) {
          throw new ProtocolError(
            'CEK_MISMATCH',
            'init: server is already initialized with a different CEK — purge or detach storage before re-initializing with a new key'
          );
        }
        // Same CEK → idempotent.
        const subscriberId: SubscriberId =
          params.subscriberId ?? `sub_${++this.subscriberCounter}_${generateUniqueId('sub')}`;
        return { ok: true, subscriberId, serverVersion: '1.0.0-phase1' };
      }

      // Deferred mode: build a fresh dependency bundle. The storage
      // config came in via the out-of-band `worker_config` channel.
      if (!this.bootstrapStorageConfig) {
        throw new ProtocolError(
          'NOT_INITIALIZED',
          'init: worker storage config has not been posted — main thread must send a worker_config message before init'
        );
      }
      const storageConfig = this.bootstrapStorageConfig;

      // Encryption: fresh per-server `EncryptionCore`, primed with the
      // supplied CEK. Pure crypto only — no localStorage coupling.
      const encryption = new EncryptionCore();
      await encryption.initializeWithCEK(cekString);

      // Storage: build the right adapter from the explicit config and
      // pass the per-server encryption in. `UnifiedStorage` captures the
      // injected `encryption` and routes every encrypt/decrypt through it.
      // The factory was injected by the worker entry via
      // `setBootstrapAdapterFactories` — fail loudly if missing, since the
      // worker entry must register both factories before sending `worker_ready`.
      if (!this.bootstrapAdapterFactories) {
        throw new ProtocolError(
          'INTERNAL_ERROR',
          'init: adapter factories have not been registered — worker entry must call setBootstrapAdapterFactories before init'
        );
      }
      const storage = new UnifiedStorage(
        this.bootstrapAdapterFactories.createStorageAdapter(storageConfig),
        encryption
      );

      // Tool registry: per-server instance with the standard tool set.
      const toolRegistry = new ClientSideToolRegistry();
      registerAllTools(toolRegistry);

      // API service: takes the deps so each client receives the
      // per-server `storage` / `toolRegistry` / `encryption` via
      // constructor injection (no singleton imports inside the worker).
      const apiService = new APIService({ storage, toolRegistry, encryption });

      // The loop registry stays stable across re-init: clients may
      // already be subscribed via `subscribeActiveLoops`, and the same
      // instance backs `abortLoop` / `softStopLoop`. Thread it into the
      // new bundle so tools that read `deps.loopRegistry` (minionTool)
      // hit the same registry the dispatcher uses.
      //
      // Adapter factories are forwarded from the worker-injected
      // `bootstrapAdapterFactories` so call sites that build per-project
      // VFS adapters or remote-storage probes can read them off `deps`
      // instead of importing the inner adapter modules from
      // `src/shared/`. They stay optional in the type so the contract
      // test stub doesn't have to populate them.
      this._deps = {
        storage,
        encryption,
        apiService,
        toolRegistry,
        loopRegistry: this.registry,
        createStorageAdapter: this.bootstrapAdapterFactories.createStorageAdapter,
        createVfsAdapter: this.bootstrapAdapterFactories.createVfsAdapter,
      };
      this.initialized = false;
      this.vfsAdapters.clear();
      await this.ensureInitialized();
    } else {
      // Test path only: deps were pre-built and handed to the constructor.
      // Production callers always pass a CEK. `ensureInitialized()` brings
      // up storage on first use; subsequent re-confirmations are no-ops.
      await this.ensureInitialized();
    }

    const subscriberId: SubscriberId =
      params.subscriberId ?? `sub_${++this.subscriberCounter}_${generateUniqueId('sub')}`;
    return {
      ok: true,
      subscriberId,
      serverVersion: '1.0.0-phase1',
    };
  }

  // ==========================================================================
  // VFS dispatch helpers
  // ==========================================================================

  /**
   * Resolve the per-project VFS adapter, constructing and caching it on
   * first use. The adapter type (local vs remote) is decided by the
   * project record's `remoteVfsUrl` field; for remote VFS the userId is
   * derived from the active CEK via `this.deps.encryption.deriveUserId()`.
   */
  private async getProjectVfsAdapter(projectId: string): Promise<VfsAdapter> {
    const cached = this.vfsAdapters.get(projectId);
    if (cached) return cached;

    const project = await this.storage.getProject(projectId);
    if (!project) {
      throw new ProtocolError('INVALID_PARAMS', `project ${projectId} not found`);
    }

    let userId = '';
    if (project.remoteVfsUrl) {
      userId = await this.deps.encryption.deriveUserId();
    }
    const factory = this.deps.createVfsAdapter;
    if (!factory) {
      throw new ProtocolError(
        'INTERNAL_ERROR',
        'getProjectVfsAdapter: createVfsAdapter factory not injected — worker entry must call setBootstrapAdapterFactories'
      );
    }
    const adapter = factory(this.deps, project, userId);
    this.vfsAdapters.set(projectId, adapter);
    return adapter;
  }
}
