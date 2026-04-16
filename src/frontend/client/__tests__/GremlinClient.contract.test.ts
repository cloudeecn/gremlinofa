/**
 * GremlinClient ↔ InProcessTransport ↔ GremlinServer end-to-end CRUD tests.
 *
 * This is the contract suite the plan calls out: each method goes through
 * the full client → transport → server → storage chain so we catch shape
 * drift between the three layers. The same suite will be reused against
 * `WorkerTransport` (PR 13) and `WebSocketTransport` (Phase 2) without
 * modification.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GremlinClient } from '../GremlinClient';
import { GremlinServer } from '../../../shared/engine/GremlinServer';
import { LoopRegistry } from '../../../shared/engine/LoopRegistry';
import type { BackendDeps } from '../../../shared/engine/backendDeps';
import { InProcessTransport } from '../../../shared/engine/transports/inProcess';
import type { APIService } from '../../../shared/services/api/apiService';
import type { EncryptionCore } from '../../../shared/services/encryption/encryptionCore';
import type { UnifiedStorage } from '../../../shared/services/storage/unifiedStorage';
import type { ClientSideToolRegistry } from '../../../shared/services/tools/clientSideTools';
import type {
  APIDefinition,
  Chat,
  Message,
  MinionChat,
  Project,
} from '../../../shared/protocol/types';

/**
 * Build a `BackendDeps` stub from a `UnifiedStorage` stub. Only the
 * `apiService.discoverModels` method is exercised by the contract suite;
 * the other fields are placeholder shells.
 */
function makeBackendDepsStub(storage: UnifiedStorage): BackendDeps {
  const apiServiceStub = {
    discoverModels: vi.fn(async () => [
      { id: 'm1', name: 'M1', apiType: 'chatgpt' },
      { id: 'm2', name: 'M2', apiType: 'chatgpt' },
    ]),
  } as unknown as APIService;
  return {
    storage,
    encryption: {} as unknown as EncryptionCore,
    apiService: apiServiceStub,
    toolRegistry: {
      getVisibleTools: vi.fn(() => []),
    } as unknown as ClientSideToolRegistry,
    loopRegistry: new LoopRegistry(),
  };
}

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

const mkMessage = (id: string): Message<unknown> => ({
  id,
  role: 'user',
  content: { type: 'text', content: 'hi' },
  timestamp: new Date(),
});

const mkMinionChat = (id: string): MinionChat => ({
  id,
  parentChatId: 'parent_chat',
  projectId: 'p1',
  apiDefinitionId: 'api_1',
  modelId: 'm1',
  createdAt: new Date(),
  lastModifiedAt: new Date(),
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
    getStorageQuota: vi.fn(async () => ({ usage: 100, quota: 1000 })),
    purgeAllData: vi.fn(async () => {}),
    compressAllMessages: vi.fn(async () => ({
      total: 5,
      compressed: 3,
      skipped: 2,
      errors: 0,
    })),
  } as unknown as UnifiedStorage;
}

async function setup(): Promise<{ client: GremlinClient; storage: UnifiedStorage }> {
  const storage = makeStorageStub();
  const deps = makeBackendDepsStub(storage);
  const server = new GremlinServer(deps);
  const transport = new InProcessTransport(server);
  const client = new GremlinClient(transport);
  await client.init();
  return { client, storage };
}

describe('GremlinClient (in-process contract)', () => {
  let client: GremlinClient;
  let storage: UnifiedStorage;

  beforeEach(async () => {
    ({ client, storage } = await setup());
  });

  describe('init', () => {
    it('returns a subscriber id and calls storage.initialize', async () => {
      // beforeEach already called init once.
      expect(storage.initialize).toHaveBeenCalledTimes(1);
    });

    it('lazy-inits the in-process server on first call', async () => {
      const lazyStorage = makeStorageStub();
      const lazyDeps = makeBackendDepsStub(lazyStorage);
      const fresh = new GremlinClient(new InProcessTransport(new GremlinServer(lazyDeps)));
      // No explicit init() — calling a CRUD method should bring up storage.
      await fresh.getProjects();
      expect(lazyStorage.initialize).toHaveBeenCalledTimes(1);
    });
  });

  describe('projects', () => {
    it('round-trips getProjects through to storage', async () => {
      const projects = [mkProject('p1'), mkProject('p2')];
      vi.mocked(storage.getProjects).mockResolvedValue(projects);
      const result = await client.getProjects();
      expect(result).toEqual(projects);
    });

    it('getProject forwards id', async () => {
      const proj = mkProject('p1');
      vi.mocked(storage.getProject).mockResolvedValue(proj);
      const result = await client.getProject('p1');
      expect(storage.getProject).toHaveBeenCalledWith('p1');
      expect(result).toEqual(proj);
    });

    it('saveProject + deleteProject delegate to storage', async () => {
      const proj = mkProject('p1');
      await client.saveProject(proj);
      await client.deleteProject('p1');
      expect(storage.saveProject).toHaveBeenCalledWith(proj);
      expect(storage.deleteProject).toHaveBeenCalledWith('p1');
    });
  });

  describe('chats', () => {
    it('getChats / getChat / saveChat / deleteChat round-trip', async () => {
      const chat = mkChat('c1', 'p1');
      vi.mocked(storage.getChats).mockResolvedValue([chat]);
      vi.mocked(storage.getChat).mockResolvedValue(chat);

      expect(await client.getChats('p1')).toEqual([chat]);
      expect(await client.getChat('c1')).toEqual(chat);
      await client.saveChat(chat);
      await client.deleteChat('c1');

      expect(storage.getChats).toHaveBeenCalledWith('p1');
      expect(storage.getChat).toHaveBeenCalledWith('c1');
      expect(storage.saveChat).toHaveBeenCalledWith(chat);
      expect(storage.deleteChat).toHaveBeenCalledWith('c1');
    });

    it('cloneChat returns the new chat id', async () => {
      const source = mkChat('source', 'p1');
      const cloned = mkChat('cloned', 'p1');
      vi.mocked(storage.getChat).mockResolvedValue(source);
      vi.mocked(storage.cloneChat).mockResolvedValue(cloned);

      const result = await client.cloneChat('source');
      expect(result).toEqual({ newChatId: 'cloned' });
    });

    it('getMessageCount unwraps the count', async () => {
      vi.mocked(storage.getMessageCount).mockResolvedValue(7);
      expect(await client.getMessageCount('c1')).toBe(7);
    });
  });

  describe('messages', () => {
    it('getMessages / saveMessage / deleteMessageAndAfter / deleteSingleMessage', async () => {
      const msg = mkMessage('m1');
      vi.mocked(storage.getMessages).mockResolvedValue([msg]);

      expect(await client.getMessages('c1')).toEqual([msg]);
      await client.saveMessage('c1', msg);
      await client.deleteMessageAndAfter('c1', 'm1');
      await client.deleteSingleMessage('m1');

      expect(storage.saveMessage).toHaveBeenCalledWith('c1', msg);
      expect(storage.deleteMessageAndAfter).toHaveBeenCalledWith('c1', 'm1');
      expect(storage.deleteSingleMessage).toHaveBeenCalledWith('m1');
    });
  });

  describe('minion chats', () => {
    it('getMinionChat / getMinionMessages forward to storage', async () => {
      const minion = mkMinionChat('mc1');
      vi.mocked(storage.getMinionChat).mockResolvedValue(minion);
      vi.mocked(storage.getMinionMessages).mockResolvedValue([mkMessage('m1')]);

      expect(await client.getMinionChat('mc1')).toEqual(minion);
      expect(await client.getMinionMessages('mc1')).toHaveLength(1);
      expect(storage.getMinionChat).toHaveBeenCalledWith('mc1');
      expect(storage.getMinionMessages).toHaveBeenCalledWith('mc1');
    });
  });

  describe('API definitions / models', () => {
    it('listAPIDefinitions / getAPIDefinition / save / delete round-trip', async () => {
      const def = mkAPIDef('api_1');
      vi.mocked(storage.getAPIDefinitions).mockResolvedValue([def]);
      vi.mocked(storage.getAPIDefinition).mockResolvedValue(def);

      expect(await client.getAPIDefinitions()).toEqual([def]);
      expect(await client.getAPIDefinition('api_1')).toEqual(def);
      await client.saveAPIDefinition(def);
      await client.deleteAPIDefinition('api_1');

      expect(storage.saveAPIDefinition).toHaveBeenCalledWith(def);
      expect(storage.deleteAPIDefinition).toHaveBeenCalledWith('api_1');
    });

    it('discoverModels resolves the API def then returns model list', async () => {
      vi.mocked(storage.getAPIDefinition).mockResolvedValue(mkAPIDef('api_1'));
      const models = await client.discoverModels('api_1');
      expect(models).toHaveLength(2);
    });

    it('getModelsCache returns models + numeric cachedAt', async () => {
      const cachedAt = new Date('2026-01-01T00:00:00Z');
      vi.mocked(storage.getModelsWithCache).mockResolvedValue({
        models: [{ id: 'm1', name: 'M1', apiType: 'chatgpt' }],
        cachedAt,
      });
      const result = await client.getModelsCache('api_1');
      expect(result.cachedAt).toBe(cachedAt.getTime());
      expect(result.models).toHaveLength(1);
    });

    it('getModelsCache surfaces null cachedAt when there is no cache', async () => {
      vi.mocked(storage.getModelsWithCache).mockResolvedValue({ models: [], cachedAt: null });
      const result = await client.getModelsCache('api_1');
      expect(result).toEqual({ models: [], cachedAt: null });
    });

    it('saveModelsCache / deleteModelsCache delegate to storage', async () => {
      const models = [{ id: 'm1', name: 'M1', apiType: 'chatgpt' as const }];
      await client.saveModelsCache('api_1', models);
      await client.deleteModelsCache('api_1');
      expect(storage.saveModels).toHaveBeenCalledWith('api_1', models);
      expect(storage.deleteModels).toHaveBeenCalledWith('api_1');
    });
  });

  describe('storage / data', () => {
    it('getStorageQuota returns the storage value', async () => {
      const quota = await client.getStorageQuota();
      expect(quota).toEqual({ usage: 100, quota: 1000 });
    });

    it('purgeAllData delegates to storage', async () => {
      await client.purgeAllData();
      expect(storage.purgeAllData).toHaveBeenCalled();
    });

    it('compressAllMessages returns compressed count', async () => {
      const result = await client.compressAllMessages();
      expect(result).toEqual({ compressedCount: 3 });
    });
  });

  describe('active loops', () => {
    it('listActiveLoops returns the registry contents', async () => {
      const loops = await client.listActiveLoops();
      expect(loops).toEqual([]);
    });

    it('abortLoop throws LOOP_NOT_FOUND for unknown id', async () => {
      await expect(client.abortLoop('nope')).rejects.toMatchObject({ code: 'LOOP_NOT_FOUND' });
    });
  });
});
