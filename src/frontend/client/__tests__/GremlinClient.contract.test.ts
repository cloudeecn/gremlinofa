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
import type { Transport } from '../../../shared/protocol/protocol';
import type { APIService } from '../../../shared/services/api/apiService';
import type { EncryptionCore } from '../../../shared/services/encryption/encryptionCore';
import type { VfsService } from '../../../shared/services/vfs/vfsService';
import type { UnifiedStorage } from '../../../shared/services/storage/unifiedStorage';
import type { ClientSideToolRegistry } from '../../../shared/services/tools/clientSideTools';
import { Tables } from '../../../shared/services/storage/StorageAdapter';
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
    inspectProviderMessage: vi.fn(async () => ({
      entry: '{"uuid":"u1"}',
      sessionId: 'sess-1',
      foundVia: 'stated' as const,
    })),
  } as unknown as APIService;
  return {
    storage,
    encryption: {} as unknown as EncryptionCore,
    vfsService: {} as unknown as VfsService,
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
    patchProject: vi.fn(async (_id: string, fields: Record<string, unknown>) => ({ ...fields })),
    deleteProject: vi.fn(async () => {}),
    getChats: vi.fn(async () => []),
    getChat: vi.fn(async () => null),
    saveChat: vi.fn(async () => {}),
    patchChat: vi.fn(async (_id: string, fields: Record<string, unknown>) => ({ ...fields })),
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
    adminGetRecord: vi.fn(async () => ({
      json: '{"name":"x"}',
      compressed: false,
      encrypted: true,
    })),
    adminSaveRecord: vi.fn(async () => {}),
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

    it('cloneMinionChat surfaces MINION_CHAT_NOT_FOUND across the transport', async () => {
      // The clone orchestration itself is covered by cloneMinionChat.test.ts;
      // what matters here is that a typed error survives the round trip
      // instead of arriving as a generic string.
      await expect(client.cloneMinionChat('missing')).rejects.toMatchObject({
        code: 'MINION_CHAT_NOT_FOUND',
      });
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

  describe('admin / diagnostics', () => {
    it('adminGetRecord returns the decrypted record view', async () => {
      const view = await client.adminGetRecord('chats', 'chat_1');
      expect(view).toEqual({ json: '{"name":"x"}', compressed: false, encrypted: true });
      expect(storage.adminGetRecord).toHaveBeenCalledWith('chats', 'chat_1');
    });

    it('adminSaveRecord delegates table/id/json to storage', async () => {
      await client.adminSaveRecord('messages', 'msg_1', '{"a":1}');
      expect(storage.adminSaveRecord).toHaveBeenCalledWith('messages', 'msg_1', '{"a":1}');
    });

    it('claudeAgentInspectMessage returns the provider entry', async () => {
      const found = await client.claudeAgentInspectMessage('sess-1', 'u1');
      expect(found).toEqual({ entry: '{"uuid":"u1"}', sessionId: 'sess-1', foundVia: 'stated' });
    });
  });

  describe('chatgpt-subscription sign-in', () => {
    const oauth = { accessToken: 'a', refreshToken: 'r', expiresAt: 1, accountId: 'acct' };
    const subDef = (): APIDefinition => ({
      ...mkAPIDef('sub_1'),
      apiType: 'chatgpt-subscription',
      apiKey: '',
    });

    it('saveAPIDefinition keeps the stored oauth block over whatever the client sends', async () => {
      vi.mocked(storage.getAPIDefinition).mockResolvedValue({ ...subDef(), oauth });
      const stale = { ...subDef(), oauth: { ...oauth, refreshToken: 'stale' } };
      await client.saveAPIDefinition(stale);
      expect(storage.saveAPIDefinition).toHaveBeenCalledWith({ ...stale, oauth });
    });

    it('chatgptOAuthSignOut clears the tokens', async () => {
      vi.mocked(storage.getAPIDefinition).mockResolvedValue({ ...subDef(), oauth });
      await client.chatgptOAuthSignOut('sub_1');
      expect(storage.saveAPIDefinition).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sub_1', oauth: undefined })
      );
    });

    it('chatgptOAuthAuthorizeUrl returns a Codex authorize URL plus the PKCE verifier', async () => {
      vi.mocked(storage.getAPIDefinition).mockResolvedValue(subDef());
      const authorize = await client.chatgptOAuthAuthorizeUrl('sub_1');
      expect(authorize.url).toMatch(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
      expect(authorize.codeVerifier).toBeTruthy();
      expect(authorize.state).toBeTruthy();
    });

    it('chatgptOAuthExchange rejects a state mismatch without touching storage', async () => {
      vi.mocked(storage.getAPIDefinition).mockResolvedValue(subDef());
      const outcome = await client.chatgptOAuthExchange(
        'sub_1',
        'http://localhost:1455/auth/callback?code=c&state=other',
        'verifier',
        'expected'
      );
      expect(outcome).toMatchObject({ status: 'error' });
      expect(storage.saveAPIDefinition).not.toHaveBeenCalled();
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

describe('GremlinClient transport lifecycle', () => {
  it('registering callbacks or reading connectionState never constructs the transport', () => {
    const factory = vi.fn(() => {
      throw new Error('transport must not be constructed');
    });
    const client = new GremlinClient(factory as unknown as () => Transport);

    client.onReconnect(() => {});
    client.onConnectionStateChange(() => {});
    expect(client.connectionState).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it('rebindTransport disposes the old transport and keeps subscribers wired', async () => {
    const reconnectFired = vi.fn();
    const makeFakeTransport = () => {
      let reconnectCb: (() => void) | null = null;
      return {
        dispose: vi.fn(),
        request: vi.fn(async () => []),
        stream: vi.fn(),
        onReconnect: (cb: () => void) => {
          reconnectCb = cb;
          return () => {
            reconnectCb = null;
          };
        },
        fireReconnect: () => reconnectCb?.(),
      };
    };
    const first = makeFakeTransport();
    const second = makeFakeTransport();
    const client = new GremlinClient(first as unknown as Transport);
    client.onReconnect(reconnectFired);

    client.rebindTransport(() => second as unknown as Transport);
    expect(first.dispose).toHaveBeenCalled();

    // The subscriber registered before the rebind fires on the NEW
    // transport's reconnect.
    second.fireReconnect();
    expect(reconnectFired).toHaveBeenCalledTimes(1);
    // The old transport's callback was unsubscribed.
    first.fireReconnect();
    expect(reconnectFired).toHaveBeenCalledTimes(1);
  });

  it("rebindTransport announces the new transport's initial connection state", () => {
    const socketIn = (connectionState: string) =>
      ({
        connectionState,
        dispose: vi.fn(),
        request: vi.fn(),
        stream: vi.fn(),
        onConnectionStateChange: () => () => {},
      }) as unknown as Transport;
    const workerLike = { request: vi.fn(), stream: vi.fn() } as unknown as Transport;
    const client = new GremlinClient(socketIn('disconnected'));
    const onState = vi.fn();
    client.onConnectionStateChange(onState);

    client.rebindTransport(() => socketIn('connecting'));
    expect(onState).toHaveBeenLastCalledWith('connecting');

    // Same state as before: nothing new to announce
    client.rebindTransport(() => socketIn('connecting'));
    expect(onState).toHaveBeenCalledTimes(1);

    // A worker has no state; subscribers read it as connected
    client.rebindTransport(() => workerLike);
    expect(onState).toHaveBeenLastCalledWith('connected');
    expect(onState).toHaveBeenCalledTimes(2);
  });

  it('announces the initial state of a lazily built socket', async () => {
    const socket = {
      connectionState: 'connecting',
      request: vi.fn(async () => []),
      stream: vi.fn(),
      onConnectionStateChange: () => () => {},
    } as unknown as Transport;
    const client = new GremlinClient(() => socket);
    const onState = vi.fn();
    client.onConnectionStateChange(onState);

    await client.getProjects();
    expect(onState).toHaveBeenCalledWith('connecting');
  });
});

describe('GremlinClient streamed-RPC error propagation', () => {
  const streamOf = (envelopes: unknown[]): Transport =>
    ({
      request: vi.fn(),
      stream: () =>
        (async function* () {
          for (const env of envelopes) yield env;
        })(),
    }) as unknown as Transport;

  it('importFromBytes throws when the stream ends with an error status', async () => {
    const client = new GremlinClient(
      streamOf([
        {
          kind: 'stream_event',
          requestId: 'r1',
          event: { type: 'progress', processed: 1, imported: 1, skipped: 0, errors: 0 },
        },
        { kind: 'stream_end', requestId: 'r1', status: 'error', detail: 'transport disconnected' },
      ])
    );
    // Before the fix this resolved with {imported: 0, ...} — a disconnect
    // mid-import looked like a successful empty import.
    await expect(client.importFromBytes(new Uint8Array([1, 2, 3]), 'cek', 'merge')).rejects.toThrow(
      /transport disconnected/
    );
  });

  it('importFromBytes throws when the stream completes without a done event', async () => {
    const client = new GremlinClient(
      streamOf([{ kind: 'stream_end', requestId: 'r1', status: 'complete' }])
    );
    await expect(client.importFromBytes(new Uint8Array([1]), 'cek', 'merge')).rejects.toThrow(
      /without a done event/
    );
  });

  it('exportToBlob throws when the stream ends with an error status', async () => {
    const client = new GremlinClient(
      streamOf([{ kind: 'stream_end', requestId: 'r1', status: 'error', detail: 'boom' }])
    );
    await expect(client.exportToBlob()).rejects.toThrow(/boom/);
  });
});

describe('GremlinClient.exportProjectBundle abort', () => {
  const fileIds = ['f1', 'f2', 'f3', 'f4', 'f5'];

  /** In-process server whose project has five VFS files; counts file reads. */
  async function setupExport() {
    const storage = makeStorageStub();
    const tree = {
      children: Object.fromEntries(fileIds.map(id => [`${id}.txt`, { type: 'file', fileId: id }])),
    };
    const vfsGet = vi.fn(async (table: string, id: string) =>
      table === Tables.VFS_META
        ? { encryptedData: JSON.stringify(tree) }
        : { encryptedData: JSON.stringify({ content: `content of ${id}` }) }
    );
    vi.mocked(storage.getProject).mockResolvedValue(mkProject('p1'));
    (storage as unknown as { getAdapter: () => unknown }).getAdapter = () => ({ get: vfsGet });
    const deps = {
      ...makeBackendDepsStub(storage),
      encryption: {
        decryptWithDecompression: async (payload: string) => payload,
      } as unknown as EncryptionCore,
    };
    const client = new GremlinClient(new InProcessTransport(new GremlinServer(deps)));
    await client.init();
    const fileReads = () =>
      vfsGet.mock.calls.filter(([table]) => table === Tables.VFS_FILES).length;
    return { client, fileReads };
  }

  it('exports every file when not aborted', async () => {
    const { client, fileReads } = await setupExport();
    const exported = await client.exportProjectBundle(
      'p1',
      undefined,
      new AbortController().signal
    );
    expect(exported.fileCount).toBe(5);
    expect(fileReads()).toBe(5);
  });

  it('stops the backend between files and rejects with AbortError', async () => {
    const { client, fileReads } = await setupExport();
    const controller = new AbortController();
    const onProgress = vi.fn((loaded: number) => {
      if (loaded === 1) controller.abort();
    });

    const exporting = client.exportProjectBundle('p1', onProgress, controller.signal);

    await expect(exporting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(exporting).rejects.toBeInstanceOf(DOMException);
    // Progress events after the abort are dropped, and the generator was
    // closed instead of reading the remaining files
    expect(onProgress.mock.calls.map(([loaded]) => loaded)).toEqual([0, 1]);
    expect(fileReads()).toBeLessThan(fileIds.length);
  });

  it('rejects without starting a stream when the signal is already aborted', async () => {
    const stream = vi.fn();
    const client = new GremlinClient({ request: vi.fn(), stream } as unknown as Transport);
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.exportProjectBundle('p1', undefined, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(stream).not.toHaveBeenCalled();
  });

  it('leaves the transport stream at the first event after the abort', async () => {
    let closed = false;
    // Set only if the client asks for another envelope after the abort
    let pulledPastDone = false;
    const controller = new AbortController();
    const transport = {
      request: vi.fn(),
      stream: () =>
        (async function* () {
          try {
            yield {
              kind: 'stream_event',
              requestId: 'r1',
              event: { type: 'progress', loaded: 0, total: 2 },
            };
            controller.abort();
            yield {
              kind: 'stream_event',
              requestId: 'r1',
              event: {
                type: 'done',
                bundleJson: '{}',
                fileCount: 2,
                dirCount: 0,
                projectName: 'p',
              },
            };
            pulledPastDone = true;
            yield { kind: 'stream_end', requestId: 'r1', status: 'complete' };
          } finally {
            closed = true;
          }
        })(),
    } as unknown as Transport;
    const client = new GremlinClient(transport);

    // The bundle arrived after the abort: still no result
    await expect(
      client.exportProjectBundle('p1', undefined, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    // Closed by the client's early exit (which sends stream_cancel), not by
    // running into stream_end
    expect(pulledPastDone).toBe(false);
    expect(closed).toBe(true);
  });
});
