/**
 * ChatRunner happy-path + abort + lock tests.
 *
 * The agentic loop itself is mocked — these tests verify the runner's
 * adaptation layer: registry register/end, message persistence, event
 * shape, incomplete-tail rejection, and abort propagation. The
 * `agenticLoopGenerator.test.ts` suite covers the actual loop semantics.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatRunner } from '../ChatRunner';
import { LoopRegistry } from '../LoopRegistry';
import type { BackendDeps } from '../backendDeps';
import type { APIService } from '../../services/api/apiService';
import type { EncryptionCore } from '../../services/encryption/encryptionCore';
import { UnifiedStorage } from '../../services/storage/unifiedStorage';
import {
  createMockAdapter,
  createMockEncryptionService,
} from '../../services/storage/__tests__/testUtils';
import type { ClientSideToolRegistry } from '../../services/tools/clientSideTools';
import type {
  AgenticLoopEvent,
  AgenticLoopResult,
} from '../../services/agentic/agenticLoopGenerator';
import type { APIDefinition, Chat, Message, Model, Project } from '../../protocol/types';
import type { LoopEvent } from '../../protocol/protocol';

// Mock the heavy dependencies. The runner only sees `runAgenticLoop` as
// an opaque generator, so we can drive it from the test.
const runAgenticLoopMock = vi.fn();
vi.mock('../../services/agentic/agenticLoopGenerator', async () => {
  const real = await vi.importActual<typeof import('../../services/agentic/agenticLoopGenerator')>(
    '../../services/agentic/agenticLoopGenerator'
  );
  return {
    ...real,
    runAgenticLoop: (...args: unknown[]) => runAgenticLoopMock(...args),
  };
});

// `buildAgenticLoopOptionsForContext` builds the agentic loop options. We
// don't care what's in them for these tests — just stub the helper so it
// doesn't try to load tool prompts / VFS / encryptionService. The signature
// gained a `deps` parameter in Phase 1 so the runner can thread the
// injected backend bundle through to the loop.
vi.mock('../buildLoopOptions', async () => {
  const real = await vi.importActual<typeof import('../buildLoopOptions')>('../buildLoopOptions');
  return {
    ...real,
    buildAgenticLoopOptionsForContext: vi.fn(async (deps, _ctx, signal, loopId, parentLoopId) => ({
      // Only the fields the test cares about — the runner forwards this
      // straight to the (mocked) runAgenticLoop.
      apiDef: { id: 'api_1' },
      model: { id: 'm1', name: 'M1', apiType: 'chatgpt' },
      projectId: 'p1',
      chatId: 'c1',
      maxTokens: 1024,
      webSearchEnabled: false,
      enabledTools: [],
      toolOptions: {},
      disableStream: false,
      extendedContext: false,
      enableReasoning: false,
      reasoningBudgetTokens: 0,
      signal,
      loopId,
      parentLoopId,
      preFillResponse: '',
      deps,
    })),
  };
});

// `messageMetadata`'s `generateMessageWithMetadata` writes the user
// message text — pass it through unchanged for these tests.
vi.mock('../messageMetadata', () => ({
  generateMessageWithMetadata: (text: string) => text,
}));

const mkProject = (id: string): Project => ({
  id,
  name: `proj-${id}`,
  icon: '📁',
  createdAt: new Date(),
  lastUsedAt: new Date(),
  apiDefinitionId: 'api_1',
  modelId: 'm1',
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
  apiDefinitionId: 'api_1',
  modelId: 'm1',
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

const mkModel = (id: string): Model => ({
  id,
  name: `Model ${id}`,
  apiType: 'chatgpt',
});

const mkAssistantMessage = (id: string, text: string, incomplete?: boolean): Message<unknown> => ({
  id,
  role: 'assistant',
  content: { type: 'text', content: text },
  timestamp: new Date(),
  ...(incomplete ? { incomplete: true } : {}),
});

function makeStorageStub(): UnifiedStorage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub: any = {
    initialize: vi.fn(async () => {}),
    getChat: vi.fn(async () => null),
    getProject: vi.fn(async () => null),
    getAPIDefinition: vi.fn(async () => null),
    getModel: vi.fn(async () => undefined),
    getMessages: vi.fn(async () => []),
    saveMessage: vi.fn(async () => {}),
    saveAttachment: vi.fn(async () => {}),
    saveChat: vi.fn(async () => {}),
    saveProject: vi.fn(async () => {}),
    deleteMessageAndAfter: vi.fn(async () => {}),
  };
  // patchChat/patchProject merge `fields` onto the mocked getChat/getProject
  // result so the runner's `currentChat = patch(...)` chain behaves like real
  // storage without a full UnifiedStorage instance.
  stub.patchChat = vi.fn(
    async (
      chatId: string,
      fields: Partial<Chat>,
      opts?: { touch?: boolean; unset?: (keyof Chat)[] }
    ) => {
      const base = (await stub.getChat(chatId)) ?? mkChat(chatId, 'p1');
      const merged: Record<string, unknown> = { ...base, ...fields };
      for (const key of opts?.unset ?? []) delete merged[key as string];
      if (opts?.touch) merged.lastModifiedAt = new Date();
      return merged;
    }
  );
  stub.patchProject = vi.fn(
    async (projectId: string, fields: Partial<Project>, opts?: { touch?: boolean }) => {
      const base = (await stub.getProject(projectId)) ?? mkProject(projectId);
      const merged: Record<string, unknown> = { ...base, ...fields };
      if (opts?.touch) merged.lastUsedAt = new Date();
      return merged;
    }
  );
  return stub as unknown as UnifiedStorage;
}

/**
 * Build a stub `BackendDeps` bundle. Only `storage` is meaningfully
 * exercised — the rest are placeholder shells the runner forwards into
 * the (mocked) buildAgenticLoopOptionsForContext. `loopRegistry` is the
 * one passed in by the test (each `describe` block constructs a fresh
 * one) so register/end calls actually flow through to the same instance
 * the test is asserting on.
 */
function makeBackendDepsStub(storage: UnifiedStorage, loopRegistry: LoopRegistry): BackendDeps {
  return {
    storage,
    encryption: {} as unknown as EncryptionCore,
    apiService: {} as unknown as APIService,
    toolRegistry: {} as unknown as ClientSideToolRegistry,
    loopRegistry,
  };
}

const mkUserMessage = (id: string, text: string): Message<unknown> => ({
  id,
  role: 'user',
  content: { type: 'text', content: text },
  timestamp: new Date(),
});

/**
 * Build a fake `runAgenticLoop` generator that yields a fixed sequence of
 * events and returns a final result. The runner adapts these into protocol
 * LoopEvents.
 */
function fakeLoopGen(
  events: AgenticLoopEvent[],
  finalResult: AgenticLoopResult
): AsyncGenerator<AgenticLoopEvent, AgenticLoopResult, void> {
  async function* gen() {
    for (const ev of events) {
      yield ev;
    }
    return finalResult;
  }
  return gen();
}

describe('ChatRunner', () => {
  let storage: UnifiedStorage;
  let deps: BackendDeps;
  let registry: LoopRegistry;
  let runner: ChatRunner;

  beforeEach(() => {
    storage = makeStorageStub();
    registry = new LoopRegistry();
    deps = makeBackendDepsStub(storage, registry);
    runner = new ChatRunner(deps, registry);
    runAgenticLoopMock.mockReset();
  });

  describe('happy path', () => {
    beforeEach(() => {
      vi.mocked(storage.getChat).mockResolvedValue(mkChat('c1', 'p1'));
      vi.mocked(storage.getProject).mockResolvedValue(mkProject('p1'));
      vi.mocked(storage.getAPIDefinition).mockResolvedValue(mkAPIDef('api_1'));
      vi.mocked(storage.getModel).mockResolvedValue(mkModel('m1'));
      vi.mocked(storage.getMessages).mockResolvedValue([]);
    });

    it('yields loop_started, adapts stream events, and ends with chat_updated + project_updated', async () => {
      const assistantMsg = mkAssistantMessage('msg_a1', 'hello world');
      runAgenticLoopMock.mockImplementation(() =>
        fakeLoopGen(
          [
            { type: 'streaming_start' },
            { type: 'first_chunk' },
            {
              type: 'streaming_chunk',
              groups: [{ category: 'text', blocks: [{ type: 'text', text: 'hi' }] }],
            },
            { type: 'message_created', message: assistantMsg },
            { type: 'streaming_end' },
          ],
          {
            status: 'complete',
            messages: [assistantMsg],
            tokens: {
              inputTokens: 10,
              outputTokens: 5,
              reasoningTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              webSearchCount: 0,
              cost: 0.001,
              costUnreliable: false,
            },
          }
        )
      );

      const events: LoopEvent[] = [];
      const ctrl = new AbortController();
      const gen = runner.run({ chatId: 'c1', mode: 'send', content: 'hi' }, ctrl, 'loop_test_1');
      for await (const ev of gen) {
        events.push(ev);
      }

      // First event should be loop_started carrying the loopId.
      expect(events[0]).toEqual({
        type: 'loop_started',
        loopId: 'loop_test_1',
        parentLoopId: undefined,
      });

      const types = events.map(e => e.type);
      expect(types).toContain('streaming_start');
      expect(types).toContain('first_chunk');
      expect(types).toContain('streaming_chunk');
      expect(types).toContain('message_created');
      expect(types).toContain('streaming_end');
      expect(types).toContain('chat_updated');
      expect(types).toContain('project_updated');

      // Assistant message persisted via storage.saveMessage.
      expect(storage.saveMessage).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ id: 'msg_a1' })
      );

      // The user message we synthesized should also have been persisted.
      expect(storage.saveMessage).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ role: 'user' })
      );

      // Project lastUsedAt bumped via a surgical patch (touch), not a
      // whole-object save.
      expect(storage.patchProject).toHaveBeenCalledWith('p1', {}, { touch: true });

      // Registry should be empty after the loop ends.
      expect(registry.list()).toEqual([]);
    });

    it('registers the loop with LoopRegistry while running', async () => {
      let registryDuringRun: ReturnType<typeof registry.list> | undefined;
      runAgenticLoopMock.mockImplementation(() => {
        async function* gen() {
          // Capture the registry contents while the loop is running.
          registryDuringRun = registry.list();
          yield { type: 'streaming_start' as const };
          return {
            status: 'complete' as const,
            messages: [],
            tokens: {
              inputTokens: 0,
              outputTokens: 0,
              reasoningTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              webSearchCount: 0,
              cost: 0,
              costUnreliable: false,
            },
          };
        }
        return gen();
      });

      const ctrl = new AbortController();
      const gen = runner.run({ chatId: 'c1', mode: 'send', content: 'hi' }, ctrl, 'loop_reg_1');
      for await (const _ev of gen) {
        // drain
      }

      expect(registryDuringRun).toBeDefined();
      expect(registryDuringRun).toHaveLength(1);
      expect(registryDuringRun?.[0].loopId).toBe('loop_reg_1');
      // After the loop ends, the registry should be empty again.
      expect(registry.list()).toHaveLength(0);
    });

    it('updates chat totals on tokens_consumed and yields chat_updated', async () => {
      runAgenticLoopMock.mockImplementation(() =>
        fakeLoopGen(
          [
            { type: 'streaming_start' },
            {
              type: 'tokens_consumed',
              tokens: {
                inputTokens: 100,
                outputTokens: 50,
                reasoningTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                webSearchCount: 0,
                cost: 0.05,
                costUnreliable: false,
              },
            },
            { type: 'streaming_end' },
          ],
          {
            status: 'complete',
            messages: [],
            tokens: {
              inputTokens: 100,
              outputTokens: 50,
              reasoningTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              webSearchCount: 0,
              cost: 0.05,
              costUnreliable: false,
            },
          }
        )
      );

      const events: LoopEvent[] = [];
      const gen = runner.run(
        { chatId: 'c1', mode: 'send', content: 'hi' },
        new AbortController(),
        'loop_tok_1'
      );
      for await (const ev of gen) {
        events.push(ev);
      }

      // Find the tokens_consumed event in the output.
      const tokensEvent = events.find(e => e.type === 'tokens_consumed');
      expect(tokensEvent).toBeDefined();

      // patchChat should have been called at least twice: once on
      // tokens_consumed and once on the final chat update — surgically, never
      // a whole-object saveChat.
      expect(
        (storage.patchChat as ReturnType<typeof vi.fn>).mock.calls.length
      ).toBeGreaterThanOrEqual(2);
      expect(storage.saveChat).not.toHaveBeenCalled();

      // The chat_updated event carries the running token totals.
      const chatUpdated = events.find(e => e.type === 'chat_updated');
      expect(chatUpdated).toMatchObject({ chat: { totalInputTokens: 100, totalOutputTokens: 50 } });
    });
  });

  describe('incomplete-tail lock', () => {
    beforeEach(() => {
      vi.mocked(storage.getChat).mockResolvedValue(mkChat('c1', 'p1'));
      vi.mocked(storage.getProject).mockResolvedValue(mkProject('p1'));
      vi.mocked(storage.getAPIDefinition).mockResolvedValue(mkAPIDef('api_1'));
      vi.mocked(storage.getModel).mockResolvedValue(mkModel('m1'));
    });

    it('throws ChatIncompleteTailError when last message is incomplete', async () => {
      vi.mocked(storage.getMessages).mockResolvedValue([
        mkAssistantMessage('m_partial', 'half a thought', true),
      ]);

      const gen = runner.run(
        { chatId: 'c1', mode: 'send', content: 'hi' },
        new AbortController(),
        'loop_lock_1'
      );

      await expect(async () => {
        for await (const _ev of gen) {
          // drain
        }
      }).rejects.toMatchObject({ code: 'CHAT_INCOMPLETE_TAIL' });

      // runAgenticLoop must NOT have been called — the lock should fire
      // before the loop is started.
      expect(runAgenticLoopMock).not.toHaveBeenCalled();
      // And the registry should never have registered the loop.
      expect(registry.list()).toEqual([]);
    });
  });

  describe('chat busy lock', () => {
    beforeEach(() => {
      vi.mocked(storage.getChat).mockResolvedValue(mkChat('c1', 'p1'));
      vi.mocked(storage.getProject).mockResolvedValue(mkProject('p1'));
      vi.mocked(storage.getAPIDefinition).mockResolvedValue(mkAPIDef('api_1'));
      vi.mocked(storage.getModel).mockResolvedValue(mkModel('m1'));
      vi.mocked(storage.getMessages).mockResolvedValue([]);
    });

    it('throws CHAT_BUSY when a loop is already running for the chat', async () => {
      // Pre-register a phantom loop on the same chat.
      registry.register(
        {
          loopId: 'pre_existing',
          chatId: 'c1',
          startedAt: Date.now(),
          status: 'running',
          apiDefinitionId: 'api_1',
          modelId: 'm1',
        },
        new AbortController()
      );

      const gen = runner.run(
        { chatId: 'c1', mode: 'send', content: 'hi' },
        new AbortController(),
        'loop_busy_1'
      );

      await expect(async () => {
        for await (const _ev of gen) {
          // drain
        }
      }).rejects.toMatchObject({ code: 'CHAT_BUSY' });
    });
  });

  describe('retry mode', () => {
    beforeEach(() => {
      vi.mocked(storage.getChat).mockResolvedValue(mkChat('c1', 'p1'));
      vi.mocked(storage.getProject).mockResolvedValue(mkProject('p1'));
      vi.mocked(storage.getAPIDefinition).mockResolvedValue(mkAPIDef('api_1'));
      vi.mocked(storage.getModel).mockResolvedValue(mkModel('m1'));

      // Bare-bones loop generator — these tests only care about the events
      // ChatRunner emits *before* runAgenticLoop runs.
      runAgenticLoopMock.mockImplementation(() =>
        fakeLoopGen([{ type: 'streaming_start' }, { type: 'streaming_end' }], {
          status: 'complete',
          messages: [],
          tokens: {
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            webSearchCount: 0,
            cost: 0,
            costUnreliable: false,
          },
        })
      );
    });

    it('truncates downstream messages and yields messages_truncated when there is something to drop', async () => {
      const userMsg = mkUserMessage('msg_user_1', 'first turn');
      const assistantMsg = mkAssistantMessage('msg_assistant_1', 'first answer');
      vi.mocked(storage.getMessages).mockResolvedValue([userMsg, assistantMsg]);

      const events: LoopEvent[] = [];
      const gen = runner.run(
        { chatId: 'c1', mode: 'retry', fromMessageId: 'msg_user_1' },
        new AbortController(),
        'loop_retry_1'
      );
      for await (const ev of gen) {
        events.push(ev);
      }

      // Storage delete fired against the message right after the anchor.
      expect(storage.deleteMessageAndAfter).toHaveBeenCalledWith('c1', 'msg_assistant_1');

      // The truncation event must reach subscribers so live views can drop
      // the deleted assistant turn from React state.
      const truncated = events.find(e => e.type === 'messages_truncated');
      expect(truncated).toEqual({ type: 'messages_truncated', afterMessageId: 'msg_user_1' });
    });

    it('does not yield messages_truncated when retrying the last message (nothing to drop)', async () => {
      const userMsg = mkUserMessage('msg_user_only', 'lone turn');
      vi.mocked(storage.getMessages).mockResolvedValue([userMsg]);

      const events: LoopEvent[] = [];
      const gen = runner.run(
        { chatId: 'c1', mode: 'retry', fromMessageId: 'msg_user_only' },
        new AbortController(),
        'loop_retry_2'
      );
      for await (const ev of gen) {
        events.push(ev);
      }

      expect(storage.deleteMessageAndAfter).not.toHaveBeenCalled();
      expect(events.find(e => e.type === 'messages_truncated')).toBeUndefined();
    });
  });

  describe('missing chat', () => {
    it('throws CHAT_NOT_FOUND when storage.getChat returns null', async () => {
      vi.mocked(storage.getChat).mockResolvedValue(null);
      const gen = runner.run(
        { chatId: 'missing', mode: 'send', content: 'hi' },
        new AbortController(),
        'loop_missing_1'
      );
      await expect(async () => {
        for await (const _ev of gen) {
          // drain
        }
      }).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' });
    });
  });
});

/**
 * Regression: a user edit (rename) made WHILE a loop runs must survive the
 * loop's final persist. The runner used to write the whole in-memory chat back
 * at the end, clobbering any concurrent edit; it now patches only the fields it
 * owns. Driven against a REAL UnifiedStorage so the read-merge-write actually
 * happens.
 */
describe('ChatRunner surgical persistence', () => {
  let storage: UnifiedStorage;
  let registry: LoopRegistry;
  let runner: ChatRunner;

  beforeEach(async () => {
    const adapter = createMockAdapter();
    const encryption = createMockEncryptionService() as unknown as EncryptionCore;
    storage = new UnifiedStorage(adapter, encryption);
    await storage.initialize();

    await storage.saveProject(mkProject('p1'));
    await storage.saveChat({ ...mkChat('c1', 'p1'), name: 'Original', totalInputTokens: 0 });
    await storage.saveAPIDefinition(mkAPIDef('api_1'));
    await storage.saveModels('api_1', [mkModel('m1')]);

    registry = new LoopRegistry();
    runner = new ChatRunner(makeBackendDepsStub(storage, registry), registry);
    runAgenticLoopMock.mockReset();
  });

  it('keeps a concurrent rename and still records the loop token totals', async () => {
    const assistantMsg = mkAssistantMessage('msg_a1', 'hi');
    const tokens = {
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      webSearchCount: 0,
      cost: 0.001,
      costUnreliable: false,
    };

    runAgenticLoopMock.mockImplementation(() => {
      async function* gen() {
        yield { type: 'streaming_start' } as AgenticLoopEvent;
        yield { type: 'message_created', message: assistantMsg } as AgenticLoopEvent;
        yield { type: 'tokens_consumed', tokens, isToolCost: false } as AgenticLoopEvent;
        // Simulate the user renaming the chat mid-run (after the loop already
        // snapshotted it at start). A whole-object final save would lose this.
        await storage.patchChat('c1', { name: 'Renamed' }, { touch: true });
        return { status: 'complete', messages: [assistantMsg], tokens } as AgenticLoopResult;
      }
      return gen();
    });

    const gen = runner.run(
      { chatId: 'c1', mode: 'send', content: 'hi' },
      new AbortController(),
      'loop_x'
    );
    for await (const _ev of gen) {
      // drain
    }

    const finalChat = await storage.getChat('c1');
    expect(finalChat?.name).toBe('Renamed');
    expect(finalChat?.totalInputTokens).toBe(10);
  });
});
