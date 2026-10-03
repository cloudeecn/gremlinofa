import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GremlinServer, ProtocolError } from '../GremlinServer';
import { LoopRegistry } from '../LoopRegistry';
import { ChatRunner } from '../ChatRunner';
import type { BackendDeps, CreateVfsAdapter } from '../backendDeps';
import { IndexedDBAdapter } from '../../../worker/adapters/IndexedDBAdapter';
import { CachedStorageAdapter } from '../../services/storage/adapters/CachedStorageAdapter';
import type { APIService } from '../../services/api/apiService';
import type { EncryptionCore } from '../../services/encryption/encryptionCore';
import { createVfsService } from '../../services/vfs/vfsService';
import type { UnifiedStorage } from '../../services/storage/unifiedStorage';
import type { ClientSideToolRegistry } from '../../services/tools/clientSideTools';
import type { APIDefinition, Chat, Project, RenderingBlockGroup } from '../../protocol/types';
import type { LoopEvent } from '../../protocol/protocol';
import { applyStreamingGroupsOps } from '../../services/streaming/streamingGroupsOps';
import { applyGroupsDelta, type ToolGroupsState } from '../../services/tools/toolGroupsDelta';

const mkProject = (id: string): Project => ({
  id,
  name: `proj-${id}`,
  icon: '📁',
  createdAt: new Date(),
  lastUsedAt: new Date(),
  apiDefinitionId: null,
  modelId: null,
  systemPrompt: '',
  preFillResponse: '',
  webSearchEnabled: false,
  temperature: 1,
  maxOutputTokens: 1024,
  enableReasoning: false,
  reasoningBudgetTokens: 0,
});

const mkChat = (id: string, projectId: string): Chat => ({
  id,
  projectId,
  name: `chat-${id}`,
  createdAt: new Date(),
  lastModifiedAt: new Date(),
  apiDefinitionId: null,
  modelId: null,
});

const mkAPIDef = (id: string): APIDefinition => ({
  id,
  name: `api-${id}`,
  apiType: 'chatgpt',
  apiKey: 'sk-test',
  baseUrl: 'https://example.test',
  isLocal: false,
  createdAt: new Date(),
  updatedAt: new Date(),
});

/**
 * Build a UnifiedStorage stub with vi.fn() for every method GremlinServer
 * dispatches into. The actual implementations are stubbed per-test as needed.
 */
function makeStorageStub(): UnifiedStorage {
  return {
    initialize: vi.fn(async () => {}),
    getProjects: vi.fn(async () => []),
    getProject: vi.fn(async () => null),
    saveProject: vi.fn(async () => {}),
    patchProject: vi.fn(
      async (_projectId: string, fields: Partial<Project>) => ({ ...fields }) as Project
    ),
    deleteProject: vi.fn(async () => {}),
    getChats: vi.fn(async () => []),
    getChat: vi.fn(async () => null),
    saveChat: vi.fn(async () => {}),
    patchChat: vi.fn(async (_chatId: string, fields: Partial<Chat>) => ({ ...fields }) as Chat),
    deleteChat: vi.fn(async () => {}),
    cloneChat: vi.fn(async () => null),
    getMessageCount: vi.fn(async () => 0),
    getMessages: vi.fn(async () => []),
    saveMessage: vi.fn(async () => {}),
    deleteMessageAndAfter: vi.fn(async () => {}),
    deleteSingleMessage: vi.fn(async () => {}),
    getMinionChat: vi.fn(async () => null),
    getMinionMessages: vi.fn(async () => []),
    getAPIDefinitions: vi.fn(async () => []),
    getAPIDefinition: vi.fn(async () => null),
    saveAPIDefinition: vi.fn(async () => {}),
    deleteAPIDefinition: vi.fn(async () => {}),
    getModelsWithCache: vi.fn(async () => ({ models: [], cachedAt: null })),
    saveModels: vi.fn(async () => {}),
    deleteModels: vi.fn(async () => {}),
    getStorageQuota: vi.fn(async () => ({ usage: 0, quota: 0 })),
    purgeAllData: vi.fn(async () => {}),
    compressAllMessages: vi.fn(async () => ({
      total: 0,
      compressed: 0,
      skipped: 0,
      errors: 0,
    })),
    getMetadata: vi.fn(async () => null),
  } as unknown as UnifiedStorage;
}

/**
 * Build a stub `BackendDeps` bundle. The storage stub is the only piece
 * GremlinServer's dispatcher actually pokes for the tests below; the rest
 * are placeholder vi.fn() shells with just enough surface for the methods
 * the tests reach (`apiService.discoverModels`, `toolRegistry.getVisibleTools`).
 */
function makeBackendDepsStub(storage: UnifiedStorage): BackendDeps {
  const apiServiceStub = {
    discoverModels: vi.fn(async () => [
      { id: 'model_1', name: 'Model 1', apiType: 'chatgpt' },
      { id: 'model_2', name: 'Model 2', apiType: 'chatgpt' },
    ]),
  } as unknown as APIService;
  const encryptionStub = {
    isInitialized: vi.fn(() => true),
    deriveUserId: vi.fn(async () => 'test_user'),
    initializeWithCEK: vi.fn(async () => {}),
    clearCEK: vi.fn(async () => {}),
    forget: vi.fn(),
    hasSameKeyAs: vi.fn(() => true),
    getCEK: vi.fn(() => null),
  } as unknown as EncryptionCore;
  const toolRegistryStub = {
    getVisibleTools: vi.fn(() => []),
    getSystemPrompts: vi.fn(async () => []),
  } as unknown as ClientSideToolRegistry;
  return {
    storage,
    encryption: encryptionStub,
    vfsService: createVfsService(storage, encryptionStub),
    apiService: apiServiceStub,
    toolRegistry: toolRegistryStub,
    // The server constructor reuses this instance as `this.registry` so
    // tests that exercise abortLoop / subscribeActiveLoops / minion
    // child-loop registration share one registry across both call paths.
    loopRegistry: new LoopRegistry(),
  };
}

describe('GremlinServer', () => {
  let storage: UnifiedStorage;
  let deps: BackendDeps;
  let server: GremlinServer;

  beforeEach(async () => {
    storage = makeStorageStub();
    deps = makeBackendDepsStub(storage);
    server = new GremlinServer(deps);
    // Bring the server up so tests can call any method.
    await server.handleRequest('init', {});
  });

  describe('init', () => {
    it('calls storage.initialize on first call and is idempotent', async () => {
      // beforeEach already called init once
      const fresh = new GremlinServer(deps);
      const r1 = await fresh.handleRequest('init', {});
      const r2 = await fresh.handleRequest('init', {});
      expect(r1.subscriberId).toBeTruthy();
      expect(r2.subscriberId).toBeTruthy();
      // initialize was already called once in beforeEach + once on `fresh`
      expect(storage.initialize).toHaveBeenCalledTimes(2);
    });

    it('returns the supplied subscriberId when provided', async () => {
      const fresh = new GremlinServer(deps);
      const r = await fresh.handleRequest('init', { subscriberId: 'sub_test' });
      expect(r.subscriberId).toBe('sub_test');
      expect(r.serverVersion).toBeTruthy();
    });

    it('lazy-initializes storage on first non-init call', async () => {
      const freshStorage = makeStorageStub();
      const freshDeps = makeBackendDepsStub(freshStorage);
      const fresh = new GremlinServer(freshDeps);
      // No explicit init() call — the dispatcher should bring up storage on demand.
      await fresh.handleRequest('listProjects', {});
      expect(freshStorage.initialize).toHaveBeenCalledTimes(1);
    });
  });

  describe('CRUD dispatch — projects / chats / messages / API defs', () => {
    it('listProjects forwards to storage.getProjects', async () => {
      const projects = [mkProject('p1'), mkProject('p2')];
      vi.mocked(storage.getProjects).mockResolvedValue(projects);
      const result = await server.handleRequest('listProjects', {});
      expect(result).toEqual(projects);
    });

    it('saveProject forwards to storage.saveProject', async () => {
      const project = mkProject('p1');
      const result = await server.handleRequest('saveProject', { project });
      expect(storage.saveProject).toHaveBeenCalledWith(project);
      expect(result).toEqual({ ok: true });
    });

    it('listChats forwards to storage.getChats', async () => {
      vi.mocked(storage.getChats).mockResolvedValue([mkChat('c1', 'p1')]);
      const result = await server.handleRequest('listChats', { projectId: 'p1' });
      expect(storage.getChats).toHaveBeenCalledWith('p1');
      expect(result).toHaveLength(1);
    });

    it('cloneChat throws CHAT_NOT_FOUND when source is missing', async () => {
      vi.mocked(storage.getChat).mockResolvedValue(null);
      await expect(server.handleRequest('cloneChat', { chatId: 'missing' })).rejects.toMatchObject({
        code: 'CHAT_NOT_FOUND',
      });
    });

    it('cloneChat returns the new chat id on success', async () => {
      const source = mkChat('source', 'p1');
      const cloned = mkChat('cloned', 'p1');
      vi.mocked(storage.getChat).mockResolvedValue(source);
      vi.mocked(storage.cloneChat).mockResolvedValue(cloned);
      const result = await server.handleRequest('cloneChat', { chatId: 'source' });
      expect(result).toEqual({ newChatId: 'cloned' });
      expect(storage.cloneChat).toHaveBeenCalledWith('source', 'p1', undefined, undefined);
    });

    it('cloneChat forwards optional anchor + fork message content', async () => {
      const source = mkChat('source', 'p1');
      const cloned = mkChat('cloned', 'p1');
      vi.mocked(storage.getChat).mockResolvedValue(source);
      vi.mocked(storage.cloneChat).mockResolvedValue(cloned);
      const result = await server.handleRequest('cloneChat', {
        chatId: 'source',
        upToMessageId: 'msg_anchor',
        forkMessageContent: 'forked text',
      });
      expect(result).toEqual({ newChatId: 'cloned' });
      expect(storage.cloneChat).toHaveBeenCalledWith('source', 'p1', 'msg_anchor', 'forked text');
    });

    it('cloneMinionChat throws MINION_CHAT_NOT_FOUND when the source is missing', async () => {
      await expect(
        server.handleRequest('cloneMinionChat', { minionChatId: 'missing' })
      ).rejects.toMatchObject({ code: 'MINION_CHAT_NOT_FOUND' });
    });

    it('cloneMinionChat throws CHAT_BUSY when the PARENT chat has a running loop', async () => {
      // Minion loops register under the parent chat's id, so that is the id
      // that must be idle — cloning mid-run would copy a growing transcript.
      vi.mocked(storage.getMinionChat).mockResolvedValue({
        id: 'mc1',
        parentChatId: 'parent-1',
        projectId: 'p1',
        createdAt: new Date(),
        lastModifiedAt: new Date(),
      });
      server.registry.register(
        {
          loopId: 'live_minion',
          chatId: 'parent-1',
          startedAt: Date.now(),
          status: 'running',
          apiDefinitionId: 'api_1',
          modelId: 'm1',
        },
        new AbortController()
      );

      await expect(
        server.handleRequest('cloneMinionChat', { minionChatId: 'mc1' })
      ).rejects.toMatchObject({ code: 'CHAT_BUSY' });
    });

    it('getMessageCount returns wrapped count', async () => {
      vi.mocked(storage.getMessageCount).mockResolvedValue(42);
      const result = await server.handleRequest('getMessageCount', { chatId: 'c1' });
      expect(result).toEqual({ count: 42 });
    });

    it('listMessages forwards to storage.getMessages', async () => {
      vi.mocked(storage.getMessages).mockResolvedValue([]);
      const result = await server.handleRequest('listMessages', { chatId: 'c1' });
      expect(storage.getMessages).toHaveBeenCalledWith('c1');
      expect(result).toEqual([]);
    });

    it("deleteMessageAndAfter recounts a chat's messages after the delete", async () => {
      vi.mocked(storage.getChat).mockResolvedValue(mkChat('c1', 'p1'));
      vi.mocked(storage.getMessageCount).mockResolvedValue(3);
      await server.handleRequest('deleteMessageAndAfter', { chatId: 'c1', messageId: 'm4' });
      expect(storage.deleteMessageAndAfter).toHaveBeenCalledWith('c1', 'm4');
      expect(storage.patchChat).toHaveBeenCalledWith('c1', { messageCount: 3 });
    });

    it('deleteMessageAndAfter leaves minion chats uncounted', async () => {
      await server.handleRequest('deleteMessageAndAfter', { chatId: 'minion_1', messageId: 'm4' });
      expect(storage.deleteMessageAndAfter).toHaveBeenCalledWith('minion_1', 'm4');
      expect(storage.patchChat).not.toHaveBeenCalled();
    });

    it('discoverModels resolves the API def first then calls apiService', async () => {
      const apiDef = mkAPIDef('api1');
      vi.mocked(storage.getAPIDefinition).mockResolvedValue(apiDef);
      const result = await server.handleRequest('discoverModels', { apiDefId: 'api1' });
      expect(result.models).toHaveLength(2);
    });

    it('discoverModels throws INVALID_PARAMS when API def is missing', async () => {
      vi.mocked(storage.getAPIDefinition).mockResolvedValue(null);
      await expect(
        server.handleRequest('discoverModels', { apiDefId: 'missing' })
      ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    });

    it('getModelsCache converts cachedAt to a unix timestamp', async () => {
      const cachedAt = new Date('2026-01-01T00:00:00Z');
      vi.mocked(storage.getModelsWithCache).mockResolvedValue({
        models: [{ id: 'm1', name: 'M1', apiType: 'chatgpt' }],
        cachedAt,
      });
      const result = await server.handleRequest('getModelsCache', { apiDefId: 'api1' });
      expect(result.cachedAt).toBe(cachedAt.getTime());
      expect(result.models).toHaveLength(1);
    });

    it('getModelsCache returns null cachedAt when no cache exists', async () => {
      vi.mocked(storage.getModelsWithCache).mockResolvedValue({ models: [], cachedAt: null });
      const result = await server.handleRequest('getModelsCache', { apiDefId: 'api1' });
      expect(result.cachedAt).toBeNull();
      expect(result.models).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('throws METHOD_NOT_FOUND for unknown methods', async () => {
      // Cast around the typed dispatch to send a bogus method.
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (server as any).dispatchOneShot('nopeNopeNope', {})
      ).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
    });

    it('ProtocolError carries a stable code', () => {
      const err = new ProtocolError('CHAT_INCOMPLETE_TAIL', 'locked');
      expect(err.code).toBe('CHAT_INCOMPLETE_TAIL');
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('init contract (Phase 1.5)', () => {
    it('rejects unknown fields with INVALID_PARAMS', async () => {
      const fresh = new GremlinServer(deps);
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fresh.handleRequest('init', { storageConfig: { type: 'local' } } as any)
      ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    });

    it('rejects re-init with a different CEK as CEK_MISMATCH', async () => {
      // Server already has deps from beforeEach. Stub the active
      // encryption core's hasSameKeyAs to return false so the init
      // guard fires.
      vi.spyOn(deps.encryption, 'hasSameKeyAs').mockReturnValue(false);
      // 32-byte all-ones key encoded as base32 (the canonical wire form
      // after Phase 1.8 leak 1d).
      const candidateCek = 'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaea';
      await expect(server.handleRequest('init', { cek: candidateCek })).rejects.toMatchObject({
        code: 'CEK_MISMATCH',
      });
    });

    it('runs concurrent first inits one at a time, building storage once', async () => {
      const deferred = new GremlinServer(null);
      deferred.setBootstrapStorageConfig({ type: 'local' });
      const createStorageAdapter = vi.fn(() => new CachedStorageAdapter(new IndexedDBAdapter()));
      deferred.setBootstrapAdapterFactories({
        createStorageAdapter,
        createVfsAdapter: vi.fn() as unknown as CreateVfsAdapter,
      });
      const cek = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';

      const results = await Promise.all([
        deferred.handleRequest('init', { cek }),
        deferred.handleRequest('init', { cek }),
      ]);

      expect(results.map(r => r.ok)).toEqual([true, true]);
      expect(createStorageAdapter).toHaveBeenCalledTimes(1);
    });

    it('lets a queued init retry after the first one fails', async () => {
      const deferred = new GremlinServer(null);
      // No storage config posted yet: the first init fails
      await expect(
        deferred.handleRequest('init', {
          cek: 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst',
        })
      ).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });
      deferred.setBootstrapStorageConfig({ type: 'local' });
      deferred.setBootstrapAdapterFactories({
        createStorageAdapter: () => new CachedStorageAdapter(new IndexedDBAdapter()),
        createVfsAdapter: vi.fn() as unknown as CreateVfsAdapter,
      });
      await expect(
        deferred.handleRequest('init', {
          cek: 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst',
        })
      ).resolves.toMatchObject({ ok: true });
    });

    it('treats re-init with the same CEK as idempotent', async () => {
      vi.spyOn(deps.encryption, 'hasSameKeyAs').mockReturnValue(true);
      const candidateCek = 'aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaea';
      const result = await server.handleRequest('init', { cek: candidateCek });
      expect(result).toMatchObject({ ok: true });
      expect(result.subscriberId).toBeTruthy();
    });
  });

  describe('destructive ops + LOOPS_RUNNING guard', () => {
    function registerDummyLoop(s: GremlinServer, loopId: string): AbortController {
      const ctrl = new AbortController();
      s.registry.register(
        {
          loopId,
          chatId: 'c1',
          startedAt: Date.now(),
          status: 'running',
          apiDefinitionId: 'api_1',
          modelId: 'm1',
        },
        ctrl
      );
      return ctrl;
    }

    it('purgeAllData throws LOOPS_RUNNING when a loop is active', async () => {
      registerDummyLoop(server, 'live_p1');
      await expect(server.handleRequest('purgeAllData', {})).rejects.toMatchObject({
        code: 'LOOPS_RUNNING',
      });
      // The dispatcher should not have touched storage when guarded.
      expect(storage.purgeAllData).not.toHaveBeenCalled();
    });

    it('clearCek throws LOOPS_RUNNING when a loop is active', async () => {
      registerDummyLoop(server, 'live_p2');
      await expect(server.handleRequest('clearCek', {})).rejects.toMatchObject({
        code: 'LOOPS_RUNNING',
      });
    });

    it('importData throws LOOPS_RUNNING when a loop is active', async () => {
      registerDummyLoop(server, 'live_p3');
      const gen = server.handleStream('importData', {
        data: new Uint8Array(),
        sourceCEK: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        mode: 'merge',
      });
      await expect(gen.next()).rejects.toMatchObject({ code: 'LOOPS_RUNNING' });
    });

    it('purgeAllData succeeds when no loops are running and drops the deps bundle', async () => {
      const result = await server.handleRequest('purgeAllData', {});
      expect(result).toEqual({ ok: true });
      expect(storage.purgeAllData).toHaveBeenCalled();
      // Subsequent RPCs throw NOT_INITIALIZED until the frontend re-inits.
      await expect(server.handleRequest('listProjects', {})).rejects.toMatchObject({
        code: 'NOT_INITIALIZED',
      });
    });
  });

  describe('streaming dispatch', () => {
    it('runLoop dispatches into ChatRunner and surfaces CHAT_NOT_FOUND for missing chat', async () => {
      const gen = server.handleStream('runLoop', {
        chatId: 'missing',
        mode: 'send',
        content: 'hi',
      });
      await expect(gen.next()).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' });
    });

    it('subscribeActiveLoops yields an initial snapshot then deltas', async () => {
      const gen = server.handleStream('subscribeActiveLoops', {});
      const first = await gen.next();
      expect(first.done).toBe(false);
      expect(first.value).toMatchObject({ type: 'snapshot', loops: [] });
      // Trigger a delta and verify the generator yields it.
      server.registry.register(
        {
          loopId: 'live_42',
          chatId: 'c1',
          startedAt: Date.now(),
          status: 'running',
          apiDefinitionId: 'api_1',
          modelId: 'm1',
        },
        new AbortController()
      );
      const second = await gen.next();
      expect(second.done).toBe(false);
      expect(second.value).toMatchObject({ type: 'started', loop: { loopId: 'live_42' } });
      // Closing the generator unsubscribes via the finally block.
      await gen.return(undefined);
    });

    it('attachChat yields snapshot events then a snapshot_complete marker and stays open for live events', async () => {
      const chat = mkChat('c1', 'p1');
      const m1 = {
        id: 'msg_1',
        role: 'user' as const,
        content: { type: 'text' as const, content: 'hi' },
        timestamp: new Date(),
      };
      vi.mocked(storage.getChat).mockResolvedValue(chat);
      vi.mocked(storage.getMessages).mockResolvedValue([m1]);
      const gen = server.handleStream('attachChat', { chatId: 'c1' });
      const first = await gen.next();
      expect(first.value).toMatchObject({ type: 'chat_updated', chat: { id: 'c1' } });
      const second = await gen.next();
      expect(second.value).toMatchObject({ type: 'message_created', message: { id: 'msg_1' } });
      const lockEvent = await gen.next();
      expect(lockEvent.value).toMatchObject({ type: 'lock_state_changed', locked: false });
      const third = await gen.next();
      expect(third.value).toMatchObject({ type: 'snapshot_complete' });
      // attachChat is long-lived and stays open for live events. Cancel via
      // gen.return() so the finally block fires and unsubscribes.
      await gen.return(undefined);
    });

    it('attachChat delivers live events broadcast via the chat pubsub after the snapshot', async () => {
      const chat = mkChat('c2', 'p1');
      vi.mocked(storage.getChat).mockResolvedValue(chat);
      vi.mocked(storage.getMessages).mockResolvedValue([]);
      const gen = server.handleStream('attachChat', { chatId: 'c2' });
      // Drain the snapshot phase.
      await gen.next(); // chat_updated
      await gen.next(); // lock_state_changed
      await gen.next(); // snapshot_complete

      // Broadcast a live event via the registry pubsub. The next iteration
      // should yield it.
      const livePromise = gen.next();
      server.registry.broadcastChatEvent('c2', {
        type: 'loop_started',
        loopId: 'loop_live',
      });
      const live = await livePromise;
      expect(live.value).toMatchObject({ type: 'loop_started', loopId: 'loop_live' });

      await gen.return(undefined);
    });

    it('attachChat synthesizes loop_started for an in-progress loop before snapshot_complete', async () => {
      // Reproduces the navigate-away-and-back regression: a loop is already
      // running when the consumer attaches, so the original `loop_started`
      // was emitted earlier and is gone from the pubsub. attachChat must
      // replay it from the registry so the frontend's loopPhase transitions
      // to `pending` immediately, instead of waiting for the next streaming
      // event.
      const chat = mkChat('c3', 'p1');
      vi.mocked(storage.getChat).mockResolvedValue(chat);
      vi.mocked(storage.getMessages).mockResolvedValue([]);

      // Pre-register a running loop on this chat (via registry directly,
      // bypassing ChatRunner — the registry is what attachChat consults).
      server.registry.register(
        {
          loopId: 'loop_already_running',
          chatId: 'c3',
          parentLoopId: 'parent_loop_xyz',
          startedAt: Date.now(),
          status: 'running',
          apiDefinitionId: 'api_1',
          modelId: 'm1',
        },
        new AbortController()
      );

      const gen = server.handleStream('attachChat', { chatId: 'c3' });
      const first = await gen.next();
      expect(first.value).toMatchObject({ type: 'chat_updated', chat: { id: 'c3' } });
      // No persisted messages — next event should be the synthetic loop_started.
      const synthetic = await gen.next();
      expect(synthetic.value).toMatchObject({
        type: 'loop_started',
        loopId: 'loop_already_running',
        parentLoopId: 'parent_loop_xyz',
      });
      const lockEvent = await gen.next();
      expect(lockEvent.value).toMatchObject({ type: 'lock_state_changed', locked: false });
      const marker = await gen.next();
      expect(marker.value).toMatchObject({ type: 'snapshot_complete' });

      await gen.return(undefined);
    });

    it('attachChat replays cached pending tool results during the snapshot phase', async () => {
      // The bug: when the user navigates away from a chat mid-tool-stream,
      // the live `attachChat` subscriber is gone and every subsequent
      // `pending_tool_result` / `tool_block_update` event is dropped on the
      // floor. The placeholder message itself is never persisted to storage
      // (only the final `message_created`), so coming back replays an empty
      // backstage until the tool finishes. This test verifies the new
      // LoopRegistry.broadcastChatEvent → cache → attachChat replay path.
      const chat = mkChat('c_replay', 'p1');
      vi.mocked(storage.getChat).mockResolvedValue(chat);
      vi.mocked(storage.getMessages).mockResolvedValue([]);

      // Simulate the loop having broadcast a placeholder + an in-progress
      // streaming update before the consumer reattaches. broadcastChatEvent
      // updates the cache regardless of whether anyone is currently
      // subscribed — that's the whole fix.
      server.registry.broadcastChatEvent('c_replay', {
        type: 'pending_tool_result',
        message: {
          id: 'msg_placeholder',
          role: 'user',
          timestamp: new Date(),
          content: {
            type: 'text',
            content: '',
            modelFamily: 'anthropic',
            toolResults: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_running',
                name: 'minion',
                content: '',
              },
            ],
          },
        } as never,
      });
      server.registry.broadcastChatEvent('c_replay', {
        type: 'tool_block_update',
        toolUseId: 'tu_running',
        block: { status: 'running' },
      });

      const gen = server.handleStream('attachChat', { chatId: 'c_replay' });
      // chat_updated → pending_tool_result (replayed) → tool_block_update
      // (replayed) → snapshot_complete.
      const first = await gen.next();
      expect(first.value).toMatchObject({ type: 'chat_updated', chat: { id: 'c_replay' } });
      const replayedPlaceholder = await gen.next();
      expect(replayedPlaceholder.value).toMatchObject({
        type: 'pending_tool_result',
        message: { id: 'msg_placeholder' },
      });
      const replayedUpdate = await gen.next();
      expect(replayedUpdate.value).toMatchObject({
        type: 'tool_block_update',
        toolUseId: 'tu_running',
        block: { status: 'running' },
      });
      const lockEvent = await gen.next();
      expect(lockEvent.value).toMatchObject({ type: 'lock_state_changed', locked: false });
      const marker = await gen.next();
      expect(marker.value).toMatchObject({ type: 'snapshot_complete' });

      await gen.return(undefined);
    });

    it('attachChat replays cached in-flight streaming groups as a streaming_snapshot', async () => {
      // Parallel to the pending-tool-result replay: a turn mid-stream folds its
      // streaming_delta ops into the registry's groups. On reattach the snapshot
      // must replay them as a `streaming_snapshot` so the in-flight assistant
      // bubble rehydrates immediately instead of going blank until the next
      // token — worst on claude-agent, whose turns have long no-token gaps.
      const chat = mkChat('c_stream', 'p1');
      vi.mocked(storage.getChat).mockResolvedValue(chat);
      vi.mocked(storage.getMessages).mockResolvedValue([]);

      const groups: RenderingBlockGroup[] = [
        { category: 'text', blocks: [{ type: 'text', text: 'partial answer' }] },
      ];
      server.registry.broadcastChatEvent('c_stream', {
        type: 'streaming_delta',
        ops: [
          { op: 'reset' },
          { op: 'add', g: 0, category: 'text', block: { type: 'text', text: 'partial' } },
        ],
      });
      server.registry.broadcastChatEvent('c_stream', {
        type: 'streaming_delta',
        ops: [{ op: 'append', g: 0, b: 0, text: ' answer' }],
      });

      const gen = server.handleStream('attachChat', { chatId: 'c_stream' });
      const first = await gen.next();
      expect(first.value).toMatchObject({ type: 'chat_updated', chat: { id: 'c_stream' } });
      const lockEvent = await gen.next();
      expect(lockEvent.value).toMatchObject({ type: 'lock_state_changed', locked: false });
      const marker = await gen.next();
      expect(marker.value).toMatchObject({ type: 'snapshot_complete' });
      const snapshot = await gen.next();
      expect(snapshot.value).toMatchObject({ type: 'streaming_snapshot', groups });

      await gen.return(undefined);
    });

    describe('attachChat deltas racing the snapshot', () => {
      const appendOp = (text: string): LoopEvent => ({
        type: 'streaming_delta',
        ops: [{ op: 'append', g: 0, b: 0, text }],
      });
      const startReply = (text: string): LoopEvent => ({
        type: 'streaming_delta',
        ops: [
          { op: 'reset' },
          { op: 'add', g: 0, category: 'text', block: { type: 'text', text } },
        ],
      });
      const textGroups = (text: string): RenderingBlockGroup[] => [
        { category: 'text', blocks: [{ type: 'text', text }] },
      ];
      const infoGroup: RenderingBlockGroup = {
        category: 'backstage',
        blocks: [{ type: 'tool_info', input: 'go' }],
      };
      const toolAppend = (text: string): LoopEvent => ({
        type: 'tool_groups_delta',
        toolUseId: 'tu_m',
        delta: { kind: 'streaming_ops', ops: [{ op: 'append', g: 0, b: 0, text }] },
      });

      /** A minion tool call whose streaming reply so far is `text`. */
      function seedMinion(chatId: string, text: string): void {
        server.registry.broadcastChatEvent(chatId, {
          type: 'pending_tool_result',
          message: {
            id: 'msg_placeholder',
            role: 'user',
            timestamp: new Date(),
            content: {
              type: 'text',
              content: '',
              modelFamily: 'anthropic',
              toolResults: [
                { type: 'tool_result', tool_use_id: 'tu_m', name: 'minion', content: '' },
              ],
            },
          } as never,
        });
        server.registry.broadcastChatEvent(chatId, {
          type: 'tool_groups_delta',
          toolUseId: 'tu_m',
          delta: {
            kind: 'init',
            infoGroup,
            accumulatedGroups: [],
            streamingGroups: textGroups(text),
          },
        });
      }

      function registerLoop(loopId: string, chatId: string): void {
        server.registry.register(
          {
            loopId,
            chatId,
            startedAt: Date.now(),
            status: 'running',
            apiDefinitionId: 'api_1',
            modelId: 'm1',
          },
          new AbortController()
        );
      }

      /** Pull events until one of type `last`, inclusive. */
      async function readUntil(
        gen: AsyncGenerator<unknown>,
        last: LoopEvent['type']
      ): Promise<LoopEvent[]> {
        const events: LoopEvent[] = [];
        for (;;) {
          const r = await gen.next();
          const event = r.value as LoopEvent;
          events.push(event);
          if (event.type === last) return events;
        }
      }

      const assistantMessage = (id: string): LoopEvent => ({
        type: 'message_created',
        message: {
          id,
          role: 'assistant',
          timestamp: new Date(),
          content: { type: 'text', content: '', modelFamily: 'anthropic' },
        } as never,
      });

      /**
       * Rebuild what the client shows from the attach events, with the rules
       * of GremlinSession (a `loop_ended` for a loop other than the tracked
       * one is stale) and useChat (snapshots replace, deltas apply, an
       * assistant `message_created` and `loop_ended` clear).
       */
      function reassemble(events: LoopEvent[]): {
        streaming: RenderingBlockGroup[];
        tool: ToolGroupsState | undefined;
      } {
        let streaming: RenderingBlockGroup[] = [];
        let tool: ToolGroupsState | undefined;
        let loopId: string | null = null;
        for (const e of events) {
          switch (e.type) {
            case 'loop_started':
              loopId = e.loopId;
              break;
            case 'loop_ended':
              if (loopId !== null && e.loopId !== loopId) break;
              loopId = null;
              streaming = [];
              tool = undefined;
              break;
            case 'streaming_snapshot':
              streaming = e.groups;
              break;
            case 'streaming_delta':
              streaming = applyStreamingGroupsOps(streaming, e.ops);
              break;
            case 'message_created':
              if (e.message.role === 'assistant') streaming = [];
              break;
            case 'tool_groups_snapshot':
              tool = {
                infoGroup: e.infoGroup,
                accumulatedGroups: e.accumulatedGroups,
                streamingGroups: e.streamingGroups,
              };
              break;
            case 'tool_groups_delta':
              tool = applyGroupsDelta(tool, e.delta);
              break;
          }
        }
        return { streaming, tool };
      }

      it('does not replay streaming deltas already folded into the streaming_snapshot', async () => {
        const chatId = 'c_race';
        vi.mocked(storage.getChat).mockResolvedValue(mkChat(chatId, 'p1'));
        // The loop keeps streaming while attachChat reads storage: these
        // deltas are queued for the subscriber AND folded into the cache
        // the snapshot is read from.
        vi.mocked(storage.getMessages).mockImplementation(async () => {
          server.registry.broadcastChatEvent(chatId, appendOp('lo'));
          server.registry.broadcastChatEvent(chatId, appendOp(' wor'));
          return [];
        });
        server.registry.broadcastChatEvent(chatId, startReply('Hel'));

        const gen = server.handleStream('attachChat', { chatId });
        const events = await readUntil(gen, 'streaming_snapshot');
        expect(events.at(-1)).toEqual({
          type: 'streaming_snapshot',
          groups: textGroups('Hello wor'),
        });

        // Live after the snapshot: must still arrive.
        server.registry.broadcastChatEvent(chatId, appendOp('ld'));
        server.registry.broadcastChatEvent(chatId, { type: 'first_chunk' });
        events.push((await gen.next()).value as LoopEvent);
        events.push((await gen.next()).value as LoopEvent);
        expect(events.slice(-2).map(e => e.type)).toEqual(['streaming_delta', 'first_chunk']);

        expect(reassemble(events).streaming).toEqual(textGroups('Hello world'));
        expect(server.registry.getStreamingGroups(chatId)).toEqual(textGroups('Hello world'));

        await gen.return(undefined);
      });

      it('does not replay minion tool_groups_delta already folded into the tool_groups_snapshot', async () => {
        const chatId = 'c_race_minion';
        vi.mocked(storage.getChat).mockResolvedValue(mkChat(chatId, 'p1'));
        vi.mocked(storage.getMessages).mockImplementation(async () => {
          server.registry.broadcastChatEvent(chatId, toolAppend('ni'));
          server.registry.broadcastChatEvent(chatId, toolAppend('on'));
          return [];
        });
        seedMinion(chatId, 'Mi');

        const gen = server.handleStream('attachChat', { chatId });
        const events = await readUntil(gen, 'snapshot_complete');
        server.registry.broadcastChatEvent(chatId, toolAppend(' works'));
        events.push((await gen.next()).value as LoopEvent);
        expect(events.at(-1)).toEqual(toolAppend(' works'));

        expect(reassemble(events).tool?.streamingGroups).toEqual(textGroups('Minion works'));
        expect(
          server.registry.getPendingToolResults(chatId)[0].groupsState?.streamingGroups
        ).toEqual(textGroups('Minion works'));

        await gen.return(undefined);
      });

      it('reads both caches and takes the queue in one step, so deltas sent mid-replay arrive exactly once', async () => {
        // The replay suspends at every yield. Deltas broadcast while it sits
        // on the first `pending_tool_result` are newer than both caches and
        // the queue taken with them, so they must be drained, once. Reading
        // either cache or taking the queue after a yield would duplicate or
        // lose them.
        const chatId = 'c_race_both';
        vi.mocked(storage.getChat).mockResolvedValue(mkChat(chatId, 'p1'));
        vi.mocked(storage.getMessages).mockResolvedValue([]);
        seedMinion(chatId, 'Mi');
        server.registry.broadcastChatEvent(chatId, startReply('Hel'));

        const gen = server.handleStream('attachChat', { chatId });
        const events: LoopEvent[] = [];
        while (events.at(-1)?.type !== 'pending_tool_result') {
          events.push((await gen.next()).value as LoopEvent);
        }
        server.registry.broadcastChatEvent(chatId, appendOp('lo'));
        server.registry.broadcastChatEvent(chatId, toolAppend('nion'));

        events.push(...(await readUntil(gen, 'streaming_snapshot')));
        events.push((await gen.next()).value as LoopEvent);
        events.push((await gen.next()).value as LoopEvent);
        expect(events.slice(-2)).toEqual([appendOp('lo'), toolAppend('nion')]);

        const client = reassemble(events);
        expect(client.streaming).toEqual(textGroups('Hello'));
        expect(client.tool?.streamingGroups).toEqual(textGroups('Minion'));
        expect(server.registry.getStreamingGroups(chatId)).toEqual(textGroups('Hello'));
        expect(
          server.registry.getPendingToolResults(chatId)[0].groupsState?.streamingGroups
        ).toEqual(textGroups('Minion'));

        await gen.return(undefined);
      });

      it('replays the loop the caches belong to when loops change hands mid-replay', async () => {
        // Loop A is mid-reply at the snapshot read. While the replay sits on
        // the synthetic loop_started, A ends and B starts streaming. The
        // snapshot must still be A's (it was read together with the running
        // loop), so A's live loop_ended clears it and B's deltas, all newer
        // than the snapshot, rebuild B's reply from its reset.
        const chatId = 'c_race_handover';
        vi.mocked(storage.getChat).mockResolvedValue(mkChat(chatId, 'p1'));
        vi.mocked(storage.getMessages).mockResolvedValue([]);
        registerLoop('loop_A', chatId);
        server.registry.broadcastChatEvent(chatId, startReply('A says'));

        const gen = server.handleStream('attachChat', { chatId });
        const events: LoopEvent[] = [];
        while (events.at(-1)?.type !== 'loop_started') {
          events.push((await gen.next()).value as LoopEvent);
        }
        expect(events.at(-1)).toMatchObject({ loopId: 'loop_A' });

        server.registry.broadcastChatEvent(chatId, {
          type: 'loop_ended',
          loopId: 'loop_A',
          status: 'complete',
        });
        server.registry.end('loop_A', 'complete');
        registerLoop('loop_B', chatId);
        server.registry.broadcastChatEvent(chatId, { type: 'loop_started', loopId: 'loop_B' });
        server.registry.broadcastChatEvent(chatId, startReply('B says'));

        events.push(...(await readUntil(gen, 'streaming_snapshot')));
        expect(events.at(-1)).toEqual({
          type: 'streaming_snapshot',
          groups: textGroups('A says'),
        });
        for (let i = 0; i < 3; i++) events.push((await gen.next()).value as LoopEvent);
        server.registry.broadcastChatEvent(chatId, appendOp(' hi'));
        events.push((await gen.next()).value as LoopEvent);

        expect(reassemble(events).streaming).toEqual(textGroups('B says hi'));
        expect(server.registry.getStreamingGroups(chatId)).toEqual(textGroups('B says hi'));

        await gen.return(undefined);
      });

      it('leaves a stale loop_ended for the client to drop when the snapshot already shows the next loop', async () => {
        // A ends and B starts while attachChat reads storage. The snapshot
        // shows B; A's queued loop_ended is still replayed after the
        // synthetic loop_started (GremlinSession drops it because it tracks B
        // by then), and B's folded deltas aren't.
        const chatId = 'c_race_stale_end';
        vi.mocked(storage.getChat).mockResolvedValue(mkChat(chatId, 'p1'));
        registerLoop('loop_A', chatId);
        server.registry.broadcastChatEvent(chatId, startReply('A says'));
        vi.mocked(storage.getMessages).mockImplementation(async () => {
          server.registry.broadcastChatEvent(chatId, {
            type: 'loop_ended',
            loopId: 'loop_A',
            status: 'complete',
          });
          server.registry.end('loop_A', 'complete');
          registerLoop('loop_B', chatId);
          server.registry.broadcastChatEvent(chatId, { type: 'loop_started', loopId: 'loop_B' });
          server.registry.broadcastChatEvent(chatId, startReply('B says'));
          return [];
        });

        const gen = server.handleStream('attachChat', { chatId });
        const events = await readUntil(gen, 'snapshot_complete');
        expect(events.find(e => e.type === 'loop_started')).toMatchObject({ loopId: 'loop_B' });
        server.registry.broadcastChatEvent(chatId, appendOp(' hi'));
        const drained: LoopEvent[] = [];
        for (let i = 0; i < 4; i++) drained.push((await gen.next()).value as LoopEvent);
        expect(drained.map(e => e.type)).toEqual([
          'loop_ended',
          'loop_started',
          'streaming_snapshot',
          'streaming_delta',
        ]);

        expect(reassemble([...events, ...drained]).streaming).toEqual(textGroups('B says hi'));

        await gen.return(undefined);
      });

      it("replays an earlier iteration's queued assistant message before the streaming_snapshot", async () => {
        // Iteration 1 ends and iteration 2 starts while attachChat reads
        // storage, so the snapshot holds iteration 2. Iteration 1's queued
        // assistant message clears the client's bubble; replayed after the
        // snapshot it would blank iteration 2 until its next delta.
        const chatId = 'c_race_iteration';
        vi.mocked(storage.getChat).mockResolvedValue(mkChat(chatId, 'p1'));
        server.registry.broadcastChatEvent(chatId, startReply('First'));
        vi.mocked(storage.getMessages).mockImplementation(async () => {
          server.registry.broadcastChatEvent(chatId, assistantMessage('msg_iter1'));
          server.registry.broadcastChatEvent(chatId, startReply('Second'));
          return [];
        });

        const gen = server.handleStream('attachChat', { chatId });
        const events = await readUntil(gen, 'streaming_snapshot');
        expect(events.slice(-3).map(e => e.type)).toEqual([
          'snapshot_complete',
          'message_created',
          'streaming_snapshot',
        ]);
        expect(reassemble(events).streaming).toEqual(textGroups('Second'));

        // Nothing else was queued: the next event is live.
        server.registry.broadcastChatEvent(chatId, appendOp(' turn'));
        events.push((await gen.next()).value as LoopEvent);
        expect(reassemble(events).streaming).toEqual(textGroups('Second turn'));

        await gen.return(undefined);
      });

      it('keeps an assistant message broadcast mid-replay behind the streaming_snapshot', async () => {
        // Iteration 2 ends while the replay sits on `lock_state_changed`,
        // after the cache read. The snapshot is iteration 2's reply, so its
        // assistant message must land after it and clear it.
        const chatId = 'c_race_iteration_live';
        vi.mocked(storage.getChat).mockResolvedValue(mkChat(chatId, 'p1'));
        vi.mocked(storage.getMessages).mockResolvedValue([]);
        server.registry.broadcastChatEvent(chatId, startReply('Second'));

        const gen = server.handleStream('attachChat', { chatId });
        const events = await readUntil(gen, 'lock_state_changed');
        server.registry.broadcastChatEvent(chatId, assistantMessage('msg_iter2'));
        events.push(...(await readUntil(gen, 'message_created')));

        expect(events.slice(-3).map(e => e.type)).toEqual([
          'snapshot_complete',
          'streaming_snapshot',
          'message_created',
        ]);
        expect(reassemble(events).streaming).toEqual([]);

        await gen.return(undefined);
      });
    });

    it('attachChat omits streaming_snapshot when no turn is mid-stream', async () => {
      const chat = mkChat('c_nostream', 'p1');
      vi.mocked(storage.getChat).mockResolvedValue(chat);
      vi.mocked(storage.getMessages).mockResolvedValue([]);

      const gen = server.handleStream('attachChat', { chatId: 'c_nostream' });
      await gen.next(); // chat_updated
      await gen.next(); // lock_state_changed
      const marker = await gen.next();
      expect(marker.value).toMatchObject({ type: 'snapshot_complete' });
      // No cached streaming groups → the next event is the first live one.
      server.registry.broadcastChatEvent('c_nostream', { type: 'first_chunk' });
      const next = await gen.next();
      expect(next.value).toEqual({ type: 'first_chunk' });

      await gen.return(undefined);
    });

    it('attachChat replay yields one placeholder per message id even when multiple toolUseIds share it', async () => {
      // Parallel tool execution: one placeholder message covers multiple
      // tool_use_ids. The replay must emit ONE pending_tool_result event
      // (frontend de-dupes by message id) followed by N tool_block_updates.
      const chat = mkChat('c_parallel', 'p1');
      vi.mocked(storage.getChat).mockResolvedValue(chat);
      vi.mocked(storage.getMessages).mockResolvedValue([]);

      server.registry.broadcastChatEvent('c_parallel', {
        type: 'pending_tool_result',
        message: {
          id: 'msg_parallel',
          role: 'user',
          timestamp: new Date(),
          content: {
            type: 'text',
            content: '',
            modelFamily: 'anthropic',
            toolResults: [
              { type: 'tool_result', tool_use_id: 'tu_1', name: 'minion', content: '' },
              { type: 'tool_result', tool_use_id: 'tu_2', name: 'minion', content: '' },
            ],
          },
        } as never,
      });
      server.registry.broadcastChatEvent('c_parallel', {
        type: 'tool_block_update',
        toolUseId: 'tu_1',
        block: { status: 'running' },
      });
      server.registry.broadcastChatEvent('c_parallel', {
        type: 'tool_block_update',
        toolUseId: 'tu_2',
        block: { status: 'running' },
      });

      const gen = server.handleStream('attachChat', { chatId: 'c_parallel' });
      const events: unknown[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await gen.next();
        events.push(r.value);
      }
      const types = (events as { type: string }[]).map(e => e.type);
      // chat_updated, pending_tool_result, tool_block_update, tool_block_update,
      // lock_state_changed, snapshot_complete
      expect(types).toEqual([
        'chat_updated',
        'pending_tool_result',
        'tool_block_update',
        'tool_block_update',
        'lock_state_changed',
        'snapshot_complete',
      ]);
      // Only ONE pending_tool_result, not two — the message id de-duped.
      const pendingCount = types.filter(t => t === 'pending_tool_result').length;
      expect(pendingCount).toBe(1);
      await gen.return(undefined);
    });

    it('attachChat does not synthesize loop_started when no loop is running on the chat', async () => {
      // Sanity check: a chat with no running loop should go straight from
      // the message snapshot to `snapshot_complete`, no synthetic event.
      const chat = mkChat('c4', 'p1');
      vi.mocked(storage.getChat).mockResolvedValue(chat);
      vi.mocked(storage.getMessages).mockResolvedValue([]);

      // Register a running loop on a *different* chat — should not match.
      server.registry.register(
        {
          loopId: 'loop_other_chat',
          chatId: 'c_other',
          startedAt: Date.now(),
          status: 'running',
          apiDefinitionId: 'api_1',
          modelId: 'm1',
        },
        new AbortController()
      );

      const gen = server.handleStream('attachChat', { chatId: 'c4' });
      const first = await gen.next();
      expect(first.value).toMatchObject({ type: 'chat_updated', chat: { id: 'c4' } });
      const lockEvent = await gen.next();
      expect(lockEvent.value).toMatchObject({ type: 'lock_state_changed', locked: false });
      const second = await gen.next();
      expect(second.value).toMatchObject({ type: 'snapshot_complete' });

      await gen.return(undefined);
    });

    it('attachChat throws CHAT_NOT_FOUND when the chat is missing', async () => {
      vi.mocked(storage.getChat).mockResolvedValue(null);
      const gen = server.handleStream('attachChat', { chatId: 'missing' });
      await expect(gen.next()).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' });
    });

    it('attachChat with knownMessageIds skips matched prefix and yields partial_reconsolidate', async () => {
      const chat = mkChat('c_partial', 'p1');
      const msgs = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        role: 'user' as const,
        content: { type: 'text' as const, content: `msg ${i}` },
        timestamp: new Date(),
      }));
      vi.mocked(storage.getChat).mockResolvedValue(chat);
      vi.mocked(storage.getMessages).mockResolvedValue(msgs);

      // Client knows the last 3 messages (m2, m3, m4)
      const gen = server.handleStream('attachChat', {
        chatId: 'c_partial',
        knownMessageIds: ['m2', 'm3', 'm4'],
      });

      const events: unknown[] = [];
      // chat_updated + partial_reconsolidate + 0 remaining messages + lock_state + snapshot_complete = 4 events
      for (let i = 0; i < 4; i++) {
        const r = await gen.next();
        events.push(r.value);
      }

      expect(events[0]).toMatchObject({ type: 'chat_updated' });
      expect(events[1]).toMatchObject({
        type: 'partial_reconsolidate',
        lastMatchedMessageId: 'm4',
      });
      // No message_created events — all 3 known IDs matched, and there are no messages after m4
      expect(events[2]).toMatchObject({ type: 'lock_state_changed' });
      expect(events[3]).toMatchObject({ type: 'snapshot_complete' });
      await gen.return(undefined);
    });

    it('attachChat partial reconsolidation yields messages after the matched prefix', async () => {
      const chat = mkChat('c_partial2', 'p1');
      const msgs = Array.from({ length: 6 }, (_, i) => ({
        id: `m${i}`,
        role: 'user' as const,
        content: { type: 'text' as const, content: `msg ${i}` },
        timestamp: new Date(),
      }));
      vi.mocked(storage.getChat).mockResolvedValue(chat);
      vi.mocked(storage.getMessages).mockResolvedValue(msgs);

      // Client knows m1 and m2, but not m3-m5 (added during disconnect)
      const gen = server.handleStream('attachChat', {
        chatId: 'c_partial2',
        knownMessageIds: ['m1', 'm2'],
      });

      const events: unknown[] = [];
      // chat_updated + partial_reconsolidate + 3 new messages (m3,m4,m5) + lock_state + snapshot_complete = 7
      for (let i = 0; i < 7; i++) {
        const r = await gen.next();
        events.push(r.value);
      }

      expect(events[0]).toMatchObject({ type: 'chat_updated' });
      expect(events[1]).toMatchObject({
        type: 'partial_reconsolidate',
        lastMatchedMessageId: 'm2',
      });
      expect(events[2]).toMatchObject({ type: 'message_created', message: { id: 'm3' } });
      expect(events[3]).toMatchObject({ type: 'message_created', message: { id: 'm4' } });
      expect(events[4]).toMatchObject({ type: 'message_created', message: { id: 'm5' } });
      expect(events[5]).toMatchObject({ type: 'lock_state_changed' });
      expect(events[6]).toMatchObject({ type: 'snapshot_complete' });
      await gen.return(undefined);
    });

    it('attachChat falls back to full snapshot when knownMessageIds[0] not found', async () => {
      const chat = mkChat('c_fallback', 'p1');
      const msgs = [
        {
          id: 'm0',
          role: 'user' as const,
          content: { type: 'text' as const, content: 'hi' },
          timestamp: new Date(),
        },
        {
          id: 'm1',
          role: 'user' as const,
          content: { type: 'text' as const, content: 'there' },
          timestamp: new Date(),
        },
      ];
      vi.mocked(storage.getChat).mockResolvedValue(chat);
      vi.mocked(storage.getMessages).mockResolvedValue(msgs);

      const gen = server.handleStream('attachChat', {
        chatId: 'c_fallback',
        knownMessageIds: ['unknown_id', 'm1'],
      });

      const events: unknown[] = [];
      // chat_updated + 2 messages (full) + lock_state + snapshot_complete = 5
      for (let i = 0; i < 5; i++) {
        const r = await gen.next();
        events.push(r.value);
      }

      expect(events[0]).toMatchObject({ type: 'chat_updated' });
      // No partial_reconsolidate — full snapshot
      expect(events[1]).toMatchObject({ type: 'message_created', message: { id: 'm0' } });
      expect(events[2]).toMatchObject({ type: 'message_created', message: { id: 'm1' } });
      expect(events[3]).toMatchObject({ type: 'lock_state_changed' });
      expect(events[4]).toMatchObject({ type: 'snapshot_complete' });
      await gen.return(undefined);
    });

    it('attachChat partial walk stops at first ID mismatch', async () => {
      const chat = mkChat('c_mismatch', 'p1');
      const msgs = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        role: 'user' as const,
        content: { type: 'text' as const, content: `msg ${i}` },
        timestamp: new Date(),
      }));
      vi.mocked(storage.getChat).mockResolvedValue(chat);
      vi.mocked(storage.getMessages).mockResolvedValue(msgs);

      // Client knows m1, then has a divergent ID (e.g., message was replaced)
      const gen = server.handleStream('attachChat', {
        chatId: 'c_mismatch',
        knownMessageIds: ['m1', 'replaced_m2', 'm3'],
      });

      const events: unknown[] = [];
      // chat_updated + partial_reconsolidate(m1) + m2,m3,m4 + lock_state + snapshot_complete = 7
      for (let i = 0; i < 7; i++) {
        const r = await gen.next();
        events.push(r.value);
      }

      expect(events[0]).toMatchObject({ type: 'chat_updated' });
      // Walk stops at m1 (first mismatch at m2)
      expect(events[1]).toMatchObject({
        type: 'partial_reconsolidate',
        lastMatchedMessageId: 'm1',
      });
      expect(events[2]).toMatchObject({ type: 'message_created', message: { id: 'm2' } });
      expect(events[3]).toMatchObject({ type: 'message_created', message: { id: 'm3' } });
      expect(events[4]).toMatchObject({ type: 'message_created', message: { id: 'm4' } });
      expect(events[5]).toMatchObject({ type: 'lock_state_changed' });
      expect(events[6]).toMatchObject({ type: 'snapshot_complete' });
      await gen.return(undefined);
    });

    it('exportData dispatch reaches the runner and yields a done event', async () => {
      // Stub a tiny adapter that yields one empty page per table so the
      // export runner emits just the CSV header + done.
      const fakeAdapter = {
        exportPaginated: vi.fn(async () => ({ rows: [], hasMore: false })),
      };
      (storage as unknown as { getAdapter: () => unknown }).getAdapter = () => fakeAdapter;

      const events: unknown[] = [];
      for await (const env of new (await import('../transports/inProcess')).InProcessTransport(
        server
      ).stream('exportData', {})) {
        events.push(env);
      }
      // We expect a stream_event with type:'done' followed by a stream_end.
      const lastEvent = events.at(-2);
      expect(lastEvent).toMatchObject({
        kind: 'stream_event',
        event: { type: 'done', mimeType: expect.stringContaining('text/csv') },
      });
      expect(events.at(-1)).toMatchObject({ kind: 'stream_end', status: 'complete' });
    });

    it('importData dispatch surfaces parser errors as stream_end {error}', async () => {
      // The runner only needs `getAdapter` to exist; the import will fail at
      // header validation because we're feeding it garbage bytes.
      (storage as unknown as { getAdapter: () => unknown }).getAdapter = () => ({
        batchSave: vi.fn(),
        get: vi.fn(),
      });

      const transport = new (await import('../transports/inProcess')).InProcessTransport(server);
      const data = new TextEncoder().encode('not,a,valid,csv,header,oops\n');
      await expect(async () => {
        for await (const _env of transport.stream('importData', {
          data,
          sourceCEK: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          mode: 'merge',
        })) {
          void _env;
        }
      }).rejects.toThrow(/Invalid CSV header/);
    });
  });

  describe('startLoop background errors', () => {
    function collectChatEvents(chatId: string): LoopEvent[] {
      const events: LoopEvent[] = [];
      const broadcast = deps.loopRegistry.broadcastChatEvent.bind(deps.loopRegistry);
      vi.spyOn(deps.loopRegistry, 'broadcastChatEvent').mockImplementation((id, event) => {
        if (id === chatId) events.push(event);
        broadcast(id, event);
      });
      return events;
    }

    async function settle(): Promise<void> {
      for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
    }

    it("broadcasts the runner's own loop_ended once when the loop throws after it", async () => {
      const events = collectChatEvents('c1');
      vi.spyOn(ChatRunner.prototype, 'run').mockImplementation(
        async function* (_params, _abort, loopId) {
          yield { type: 'loop_started', loopId };
          yield { type: 'loop_ended', loopId, status: 'error', detail: 'boom' };
          throw new Error('boom');
        }
      );

      const { loopId } = (await server.handleRequest('startLoop', {
        chatId: 'c1',
        mode: 'send',
        content: 'hi',
      })) as { loopId: string };
      await settle();

      const ended = events.filter(e => e.type === 'loop_ended');
      expect(ended).toEqual([{ type: 'loop_ended', loopId, status: 'error', detail: 'boom' }]);
    });

    it('synthesizes loop_ended when the loop throws before yielding one', async () => {
      const events = collectChatEvents('c1');
      vi.spyOn(ChatRunner.prototype, 'run').mockImplementation(
        async function* (_params, _abort, loopId) {
          yield { type: 'loop_started', loopId };
          throw new Error('storage gone');
        }
      );

      const { loopId } = (await server.handleRequest('startLoop', {
        chatId: 'c1',
        mode: 'send',
        content: 'hi',
      })) as { loopId: string };
      await settle();

      expect(events.filter(e => e.type === 'loop_ended')).toEqual([
        { type: 'loop_ended', loopId, status: 'error', detail: 'storage gone' },
      ]);
    });
  });

  describe('active loops', () => {
    it('listActiveLoops returns an empty list initially', async () => {
      const loops = await server.handleRequest('listActiveLoops', {});
      expect(loops).toEqual([]);
    });

    it('abortLoop throws LOOP_NOT_FOUND for unknown id', async () => {
      await expect(server.handleRequest('abortLoop', { loopId: 'missing' })).rejects.toMatchObject({
        code: 'LOOP_NOT_FOUND',
      });
    });

    it('abortLoop succeeds when the registry has the loop', async () => {
      server.registry.register(
        {
          loopId: 'live',
          chatId: 'c1',
          startedAt: Date.now(),
          status: 'running',
          apiDefinitionId: 'api_1',
          modelId: 'm1',
        },
        new AbortController()
      );
      const result = await server.handleRequest('abortLoop', { loopId: 'live' });
      expect(result).toEqual({ ok: true });
    });

    it('softStopLoop sets the registry flag and succeeds', async () => {
      server.registry.register(
        {
          loopId: 'soft',
          chatId: 'c1',
          startedAt: Date.now(),
          status: 'running',
          apiDefinitionId: 'api_1',
          modelId: 'm1',
        },
        new AbortController()
      );
      expect(server.registry.isSoftStopRequested('soft')).toBe(false);
      const result = await server.handleRequest('softStopLoop', { loopId: 'soft' });
      expect(result).toEqual({ ok: true });
      expect(server.registry.isSoftStopRequested('soft')).toBe(true);
    });

    it('softStopLoop throws LOOP_NOT_FOUND for unknown id', async () => {
      await expect(
        server.handleRequest('softStopLoop', { loopId: 'missing' })
      ).rejects.toMatchObject({ code: 'LOOP_NOT_FOUND' });
    });
  });
});
