import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GremlinServer, ProtocolError } from '../GremlinServer';
import { LoopRegistry } from '../LoopRegistry';
import type { BackendDeps } from '../backendDeps';
import type { APIService } from '../../services/api/apiService';
import type { EncryptionCore } from '../../services/encryption/encryptionCore';
import type { UnifiedStorage } from '../../services/storage/unifiedStorage';
import type { ClientSideToolRegistry } from '../../services/tools/clientSideTools';
import type { APIDefinition, Chat, Project } from '../../protocol/types';

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
    deleteProject: vi.fn(async () => {}),
    getChats: vi.fn(async () => []),
    getChat: vi.fn(async () => null),
    saveChat: vi.fn(async () => {}),
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
