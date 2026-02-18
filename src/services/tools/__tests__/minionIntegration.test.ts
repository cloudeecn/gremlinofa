/**
 * Minion Integration Tests
 *
 * Tests the full minion tool flow:
 * minion tool call → agentic loop → result → renderingGroups
 *
 * Uses mocked storage and apiService to test the integration
 * between minionTool, agenticLoopGenerator, and storage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { minionTool, CHECKPOINT_START } from '../minionTool';
import type {
  APIDefinition,
  APIType,
  Message,
  MinionChat,
  Model,
  Project,
  ToolContext,
  ToolOptions,
  ToolResult,
  ToolStreamEvent,
  ToolExecuteReturn,
} from '../../../types';

// Mock dependencies
vi.mock('../../api/apiService', () => ({
  apiService: {
    sendMessageStream: vi.fn(),
    extractToolUseBlocks: vi.fn(),
    buildToolResultMessage: vi.fn(),
    mapStopReason: vi.fn((_, reason) => reason || 'end_turn'),
    shouldPrependPrefill: vi.fn(() => false),
  },
}));

vi.mock('../../api/modelMetadata', () => ({
  calculateCost: vi.fn(() => 0.001),
  isCostUnreliable: vi.fn(() => false),
}));

vi.mock('../../streaming/StreamingContentAssembler', () => {
  return {
    StreamingContentAssembler: class MockStreamingContentAssembler {
      pushChunk() {}
      getGroups() {
        return [{ category: 'text', blocks: [{ type: 'text', text: 'test response' }] }];
      }
      finalize() {
        return [{ category: 'text', blocks: [{ type: 'text', text: 'test response' }] }];
      }
      finalizeWithError(err: { message: string }) {
        return [{ category: 'error', blocks: [{ type: 'error', message: err.message }] }];
      }
    },
  };
});

// Mock storage with tracking
const mockStorageData = {
  projects: new Map<string, Project>(),
  apiDefinitions: new Map<string, APIDefinition>(),
  models: new Map<string, Model>(),
  minionChats: new Map<string, MinionChat>(),
  minionMessages: new Map<string, Message<unknown>[]>(),
  attachments: new Map<string, unknown[]>(),
};

vi.mock('../../storage', () => ({
  storage: {
    getProject: vi.fn((id: string) => Promise.resolve(mockStorageData.projects.get(id))),
    getAPIDefinition: vi.fn((id: string) =>
      Promise.resolve(mockStorageData.apiDefinitions.get(id))
    ),
    getModel: vi.fn((apiDefId: string, modelId: string) =>
      Promise.resolve(mockStorageData.models.get(`${apiDefId}:${modelId}`))
    ),
    getMinionChat: vi.fn((id: string) => Promise.resolve(mockStorageData.minionChats.get(id))),
    getMinionMessages: vi.fn((chatId: string) =>
      Promise.resolve(mockStorageData.minionMessages.get(chatId) ?? [])
    ),
    saveMinionChat: vi.fn((chat: MinionChat) => {
      mockStorageData.minionChats.set(chat.id, chat);
      return Promise.resolve();
    }),
    saveMinionMessage: vi.fn((chatId: string, msg: Message<unknown>) => {
      const messages = mockStorageData.minionMessages.get(chatId) ?? [];
      messages.push(msg);
      mockStorageData.minionMessages.set(chatId, messages);
      return Promise.resolve();
    }),
    getAttachments: vi.fn(() => Promise.resolve([])),
    deleteMessagesAfter: vi.fn((chatId: string, messageId: string) => {
      const messages = mockStorageData.minionMessages.get(chatId) ?? [];
      const idx = messages.findIndex(m => m.id === messageId);
      if (idx >= 0) {
        mockStorageData.minionMessages.set(chatId, messages.slice(0, idx + 1));
      }
      return Promise.resolve();
    }),
    deleteMessageAndAfter: vi.fn((chatId: string, messageId: string) => {
      const messages = mockStorageData.minionMessages.get(chatId) ?? [];
      const idx = messages.findIndex(m => m.id === messageId);
      if (idx >= 0) {
        mockStorageData.minionMessages.set(chatId, messages.slice(0, idx));
      }
      return Promise.resolve();
    }),
  },
}));

vi.mock('../clientSideTools', () => ({
  executeClientSideTool: vi.fn(),
  toolRegistry: {
    get: vi.fn(() => ({
      iconInput: '🔧',
      iconOutput: '✅',
      renderInput: undefined,
      renderOutput: undefined,
    })),
    getSystemPrompts: vi.fn(() => Promise.resolve([])),
  },
}));

vi.mock('../../../utils/idGenerator', () => ({
  generateUniqueId: vi.fn(prefix => `${prefix}_${Math.random().toString(36).slice(2, 10)}`),
}));

import { apiService } from '../../api/apiService';
import { executeClientSideTool } from '../clientSideTools';

/** Consume an async generator to get the final ToolResult, collecting yielded events */
async function collectToolResult(
  gen: ToolExecuteReturn,
  eventCollector?: ToolStreamEvent[]
): Promise<ToolResult> {
  if (gen instanceof Promise) return gen;
  let result = await gen.next();
  while (!result.done) {
    if (eventCollector) eventCollector.push(result.value);
    result = await gen.next();
  }
  return result.value;
}

/** Helper to create a mock async generator that returns a ToolResult */
async function* mockToolGenerator(result: ToolResult): AsyncGenerator<ToolStreamEvent, ToolResult> {
  return result;
}

// Helper to create async generator from chunks
async function* createMockStream(
  chunks: Array<{ type: string; content?: string }>,
  finalResult: unknown
): AsyncGenerator<unknown, unknown, unknown> {
  for (const chunk of chunks) {
    yield chunk;
  }
  return finalResult;
}

// Test fixtures
function setupMockData() {
  mockStorageData.projects.clear();
  mockStorageData.apiDefinitions.clear();
  mockStorageData.models.clear();
  mockStorageData.minionChats.clear();
  mockStorageData.minionMessages.clear();
  mockStorageData.attachments.clear();

  const project: Project = {
    id: 'proj_test',
    name: 'Test Project',
    apiDefinitionId: 'api_test',
    modelId: 'claude-3-sonnet',
    enabledTools: ['memory', 'javascript'],
    toolOptions: {},
    maxOutputTokens: 4096,
    createdAt: new Date(),
    lastUsedAt: new Date(),
    systemPrompt: '',
    preFillResponse: '',
    webSearchEnabled: false,
    temperature: null,
    enableReasoning: false,
    reasoningBudgetTokens: 1024,
  };
  mockStorageData.projects.set('proj_test', project);

  const apiDef: APIDefinition = {
    id: 'api_test',
    apiType: 'anthropic',
    name: 'Test API',
    baseUrl: '',
    apiKey: 'test-key',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  mockStorageData.apiDefinitions.set('api_test', apiDef);

  const model: Model = {
    id: 'claude-3-sonnet',
    name: 'Claude 3 Sonnet',
    apiType: 'anthropic',
    contextWindow: 200000,
    inputPrice: 3,
    outputPrice: 15,
  };
  mockStorageData.models.set('api_test:claude-3-sonnet', model);

  return { project, apiDef, model };
}

describe('Minion Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMockData();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('full flow: minion tool → agentic loop → result', () => {
    it('completes simple task and returns result with renderingGroups', async () => {
      const mockResult = {
        textContent: 'Task completed successfully!',
        fullContent: [{ type: 'text', text: 'Task completed successfully!' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      const mockStream = createMockStream(
        [{ type: 'content', content: 'Task completed successfully!' }],
        mockResult
      );

      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
        systemPrompt: 'You are a helpful minion.',
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      const result = await collectToolResult(
        minionTool.execute({ message: 'Do a simple task' }, toolOptions, context)
      );

      // Result JSON contains text output, stopReason, and minionChatId
      expect(result.isError).toBeUndefined();
      const parsedContent = JSON.parse(result.content);
      expect(parsedContent.text).toBe('Task completed successfully!');
      expect(parsedContent.stopReason).toBe('end_turn');
      expect(parsedContent.result).toBeUndefined(); // No return tool used
      expect(parsedContent.minionChatId).toBeDefined();

      // renderingGroups starts with ToolInfoRenderBlock
      expect(result.renderingGroups).toBeDefined();
      expect(result.renderingGroups!.length).toBeGreaterThan(0);
      const infoBlock = result.renderingGroups![0].blocks[0];
      expect(infoBlock.type).toBe('tool_info');
      if (infoBlock.type === 'tool_info') {
        expect(infoBlock.input).toBe('Do a simple task');
        expect(infoBlock.chatId).toBe(parsedContent.minionChatId);
      }

      // Minion chat was saved
      expect(mockStorageData.minionChats.size).toBe(1);
      const savedChat = [...mockStorageData.minionChats.values()][0];
      expect(savedChat.projectId).toBe('proj_test');
      expect(savedChat.parentChatId).toBe('chat_test');

      // Messages saved (user message + assistant message)
      const savedMessages = mockStorageData.minionMessages.get(savedChat.id) ?? [];
      expect(savedMessages.length).toBeGreaterThanOrEqual(2);
    });

    it('handles minion using return tool for explicit result', async () => {
      const returnToolUse = [
        {
          type: 'tool_use' as const,
          id: 'toolu_1',
          name: 'return',
          input: { result: 'Explicitly returned value' },
        },
      ];

      const mockResult = {
        textContent: '',
        fullContent: returnToolUse,
        stopReason: 'tool_use',
        inputTokens: 100,
        outputTokens: 50,
      };

      const mockStream = createMockStream([], mockResult);

      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue(returnToolUse);
      vi.mocked(apiService.buildToolResultMessage).mockReturnValue({
        id: 'msg_tool_result',
        role: 'user',
        content: { type: 'text', content: '' },
        timestamp: new Date(),
      });

      // Mock executeClientSideTool to return with breakLoop
      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({
          content: 'Explicitly returned value',
          isError: false,
          breakLoop: { returnValue: 'Explicitly returned value' },
        })
      );

      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      const result = await collectToolResult(
        minionTool.execute({ message: 'Return something' }, toolOptions, context)
      );

      // Content JSON has the return value, text output, stopReason, and minionChatId
      expect(result.isError).toBeUndefined();
      const parsedContent = JSON.parse(result.content);
      expect(parsedContent.result).toBe('Explicitly returned value');
      expect(parsedContent.text).toBe(''); // Assistant text empty when only tool_use
      expect(parsedContent.stopReason).toBe('end_turn'); // tool_use mapped to end_turn for return tool
      expect(parsedContent.minionChatId).toBeDefined();

      // renderingGroups present with ToolInfoRenderBlock
      expect(result.renderingGroups).toBeDefined();
      const infoBlock = result.renderingGroups![0].blocks[0];
      expect(infoBlock.type).toBe('tool_info');
    });

    it('yields groups_update events during streaming', async () => {
      const mockResult = {
        textContent: 'Done!',
        fullContent: [{ type: 'text', text: 'Done!' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      const mockStream = createMockStream(
        [
          { type: 'content', content: 'Working...' },
          { type: 'content', content: 'Done!' },
        ],
        mockResult
      );

      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      // Collect yielded events from the generator
      const events: ToolStreamEvent[] = [];
      const result = await collectToolResult(
        minionTool.execute({ message: 'Stream test' }, toolOptions, context),
        events
      );

      // Verify generator yielded groups_update events
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe('groups_update');
      // First group should be the ToolInfoRenderBlock
      const firstGroups = events[0].groups;
      expect(firstGroups[0].category).toBe('backstage');
      expect(firstGroups[0].blocks[0].type).toBe('tool_info');

      // Result should have renderingGroups
      expect(result.renderingGroups).toBeDefined();
      expect(result.renderingGroups!.length).toBeGreaterThan(0);
      expect(result.renderingGroups![0].blocks[0].type).toBe('tool_info');
    });

    it('continues existing minion conversation', async () => {
      const existingChat: MinionChat = {
        id: 'minion_existing',
        parentChatId: 'chat_test',
        projectId: 'proj_test',
        createdAt: new Date(),
        lastModifiedAt: new Date(),
        totalInputTokens: 100,
        totalOutputTokens: 50,
      };
      mockStorageData.minionChats.set('minion_existing', existingChat);

      const existingMessages: Message<unknown>[] = [
        {
          id: 'msg_user_1',
          role: 'user',
          content: { type: 'text', content: 'First message' },
          timestamp: new Date(),
        },
        {
          id: 'msg_assistant_1',
          role: 'assistant',
          content: { type: 'text', content: 'First response' },
          timestamp: new Date(),
        },
      ];
      mockStorageData.minionMessages.set('minion_existing', existingMessages);

      const mockResult = {
        textContent: 'Continued conversation!',
        fullContent: [{ type: 'text', text: 'Continued conversation!' }],
        stopReason: 'end_turn',
        inputTokens: 150,
        outputTokens: 75,
      };

      const mockStream = createMockStream(
        [{ type: 'content', content: 'Continued conversation!' }],
        mockResult
      );

      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      const result = await collectToolResult(
        minionTool.execute(
          { message: 'Continue the task', minionChatId: 'minion_existing' },
          toolOptions,
          context
        )
      );

      // Result references the existing chat with text from this turn only
      const parsedContent = JSON.parse(result.content);
      expect(parsedContent.text).toBe('Continued conversation!');
      expect(parsedContent.stopReason).toBe('end_turn');
      expect(parsedContent.result).toBeUndefined(); // No return tool used
      expect(parsedContent.minionChatId).toBe('minion_existing');

      // ToolInfoRenderBlock chatId matches
      expect(result.renderingGroups).toBeDefined();
      const infoBlock = result.renderingGroups![0].blocks[0];
      if (infoBlock.type === 'tool_info') {
        expect(infoBlock.chatId).toBe('minion_existing');
      }

      // Tokens accumulated on the existing chat
      const updatedChat = mockStorageData.minionChats.get('minion_existing');
      expect(updatedChat?.totalInputTokens).toBe(250); // 100 + 150
      expect(updatedChat?.totalOutputTokens).toBe(125); // 50 + 75
    });

    it('preserves stored model on continuation instead of falling back to default', async () => {
      // Setup: a second API + model that the minion was previously using
      const apiDef2: APIDefinition = {
        id: 'api_other',
        apiType: 'anthropic',
        name: 'Other API',
        baseUrl: '',
        apiKey: 'other-key',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockStorageData.apiDefinitions.set('api_other', apiDef2);

      const model2: Model = {
        id: 'claude-3-opus',
        name: 'Claude 3 Opus',
        apiType: 'anthropic',
        contextWindow: 200000,
        inputPrice: 15,
        outputPrice: 75,
      };
      mockStorageData.models.set('api_other:claude-3-opus', model2);

      // Existing minion chat was previously run with api_other:claude-3-opus
      const existingChat: MinionChat = {
        id: 'minion_model_test',
        parentChatId: 'chat_test',
        projectId: 'proj_test',
        createdAt: new Date(),
        lastModifiedAt: new Date(),
        totalInputTokens: 100,
        totalOutputTokens: 50,
        apiDefinitionId: 'api_other',
        modelId: 'claude-3-opus',
      };
      mockStorageData.minionChats.set('minion_model_test', existingChat);
      mockStorageData.minionMessages.set('minion_model_test', [
        {
          id: 'msg_u1',
          role: 'user',
          content: { type: 'text', content: 'First message' },
          timestamp: new Date(),
        },
        {
          id: 'msg_a1',
          role: 'assistant',
          content: { type: 'text', content: 'First response' },
          timestamp: new Date(),
        },
      ]);

      const mockResult = {
        textContent: 'Continued!',
        fullContent: [{ type: 'text', text: 'Continued!' }],
        stopReason: 'end_turn',
        inputTokens: 50,
        outputTokens: 25,
      };
      const mockStream = createMockStream([{ type: 'content', content: 'Continued!' }], mockResult);
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      // toolOptions.model is the DEFAULT (api_test:claude-3-sonnet) — should NOT override stored model
      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
      };
      const context: ToolContext = { projectId: 'proj_test', chatId: 'chat_test' };

      const result = await collectToolResult(
        minionTool.execute(
          { message: 'Continue please', minionChatId: 'minion_model_test' },
          toolOptions,
          context
        )
      );

      expect(result.isError).toBeUndefined();

      // The stored model (api_other:claude-3-opus) should have been used, not the default
      const { storage } = await import('../../storage');
      expect(storage.getModel).toHaveBeenCalledWith('api_other', 'claude-3-opus');

      // The minionChat should still have the original model
      const updatedChat = mockStorageData.minionChats.get('minion_model_test');
      expect(updatedChat?.apiDefinitionId).toBe('api_other');
      expect(updatedChat?.modelId).toBe('claude-3-opus');
    });

    it('preserves stored enabledTools on continuation when not re-specified', async () => {
      // Existing minion chat was created with enabledTools
      const existingChat: MinionChat = {
        id: 'minion_tools_test',
        parentChatId: 'chat_test',
        projectId: 'proj_test',
        createdAt: new Date(),
        lastModifiedAt: new Date(),
        totalInputTokens: 100,
        totalOutputTokens: 50,
        enabledTools: ['memory', 'javascript'],
      };
      mockStorageData.minionChats.set('minion_tools_test', existingChat);
      mockStorageData.minionMessages.set('minion_tools_test', [
        {
          id: 'msg_u1',
          role: 'user',
          content: { type: 'text', content: 'First message' },
          timestamp: new Date(),
        },
        {
          id: 'msg_a1',
          role: 'assistant',
          content: { type: 'text', content: 'First response' },
          timestamp: new Date(),
        },
      ]);

      const mockResult = {
        textContent: 'Continued!',
        fullContent: [{ type: 'text', text: 'Continued!' }],
        stopReason: 'end_turn',
        inputTokens: 50,
        outputTokens: 25,
      };
      const mockStream = createMockStream([{ type: 'content', content: 'Continued!' }], mockResult);
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
      };
      const context: ToolContext = { projectId: 'proj_test', chatId: 'chat_test' };

      // Continue WITHOUT specifying enabledTools — should use stored ones
      const result = await collectToolResult(
        minionTool.execute(
          { message: 'Continue please', minionChatId: 'minion_tools_test' },
          toolOptions,
          context
        )
      );

      expect(result.isError).toBeUndefined();

      // The stored tools should have been used: memory, javascript, return
      const callArgs = vi.mocked(apiService.sendMessageStream).mock.calls[0];
      const streamOptions = callArgs[3];
      expect(streamOptions.enabledTools).toContain('memory');
      expect(streamOptions.enabledTools).toContain('javascript');
      expect(streamOptions.enabledTools).toContain('return');
      expect(streamOptions.enabledTools).toHaveLength(3);

      // The minionChat should still have the enabledTools
      const updatedChat = mockStorageData.minionChats.get('minion_tools_test');
      expect(updatedChat?.enabledTools).toEqual(['memory', 'javascript']);
    });

    it('scopes tools correctly (excludes minion, includes return)', async () => {
      const mockResult = {
        textContent: 'Done',
        fullContent: [{ type: 'text', text: 'Done' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      const mockStream = createMockStream([], mockResult);

      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      // Request minion with specific project tools
      await collectToolResult(
        minionTool.execute(
          { message: 'Test', enabledTools: ['memory', 'javascript'] },
          toolOptions,
          context
        )
      );

      // Check the stream options passed to apiService
      expect(apiService.sendMessageStream).toHaveBeenCalled();
      const callArgs = vi.mocked(apiService.sendMessageStream).mock.calls[0];
      const streamOptions = callArgs[3];

      // enabledTools should include memory, javascript, return but NOT minion
      expect(streamOptions.enabledTools).toContain('memory');
      expect(streamOptions.enabledTools).toContain('javascript');
      expect(streamOptions.enabledTools).toContain('return');
      expect(streamOptions.enabledTools).not.toContain('minion');
    });
  });

  describe('error handling', () => {
    it('returns Phase 2 error when project not found', async () => {
      mockStorageData.projects.clear(); // Remove project

      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
      };

      const context: ToolContext = {
        projectId: 'proj_nonexistent',
        chatId: 'chat_test',
      };

      const result = await collectToolResult(
        minionTool.execute({ message: 'Test' }, toolOptions, context)
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('Project not found');
      expect(result.content).toContain('Resend with the message to reattempt.');
    });

    it('returns Phase 2 error when API definition not found', async () => {
      mockStorageData.apiDefinitions.clear(); // Remove API def

      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_nonexistent', modelId: 'claude-3-sonnet' },
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      const result = await collectToolResult(
        minionTool.execute({ message: 'Test' }, toolOptions, context)
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('API definition not found');
      expect(result.content).toContain('Resend with the message to reattempt.');
    });

    it('returns Phase 2 error when model not found', async () => {
      mockStorageData.models.clear(); // Remove model

      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'nonexistent-model' },
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      const result = await collectToolResult(
        minionTool.execute({ message: 'Test' }, toolOptions, context)
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('Model not found');
      expect(result.content).toContain('Resend with the message to reattempt.');
    });

    it('returns Phase 1 error when minion chat not found (continue mode)', async () => {
      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      const result = await collectToolResult(
        minionTool.execute(
          { message: 'Continue', minionChatId: 'minion_nonexistent' },
          toolOptions,
          context
        )
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('Minion chat not found');
      expect(result.content).toContain('Resend to reattempt.');
    });

    it('returns error with renderingGroups when agentic loop fails', async () => {
      vi.mocked(apiService.sendMessageStream).mockImplementation(() => {
        throw new Error('API connection failed');
      });

      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      const result = await collectToolResult(
        minionTool.execute({ message: 'Test' }, toolOptions, context)
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('API connection failed');

      // renderingGroups preserved even on error (contains ToolInfoRenderBlock)
      expect(result.renderingGroups).toBeDefined();
      expect(result.renderingGroups!.length).toBeGreaterThan(0);
      expect(result.renderingGroups![0].blocks[0].type).toBe('tool_info');
    });

    it('returns error when max iterations reached', async () => {
      // Setup: API keeps returning tool_use forever
      const toolUseBlocks = [
        {
          type: 'tool_use' as const,
          id: 'toolu_1',
          name: 'memory',
          input: { command: 'view', path: '/' },
        },
      ];

      const mockResult = {
        textContent: '',
        fullContent: toolUseBlocks,
        stopReason: 'tool_use',
        inputTokens: 10,
        outputTokens: 5,
      };

      // Return tool_use result every time
      vi.mocked(apiService.sendMessageStream).mockImplementation(
        () => createMockStream([], mockResult) as never
      );
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue(toolUseBlocks);
      vi.mocked(apiService.buildToolResultMessage).mockReturnValue({
        id: 'msg_tool_result',
        role: 'user',
        content: { type: 'text', content: '' },
        timestamp: new Date(),
      });

      // executeClientSideTool returns normal result (no breakLoop)
      vi.mocked(executeClientSideTool).mockImplementation(() =>
        mockToolGenerator({
          content: 'Files listed',
          isError: false,
        })
      );

      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      const result = await collectToolResult(
        minionTool.execute({ message: 'Infinite loop test' }, toolOptions, context)
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('maximum iterations');
    });
  });

  describe('return tool resumption', () => {
    it('sends tool_result instead of user message when resuming after return tool', async () => {
      // Setup: Create existing minion chat where last message has pending return tool
      const existingChat: MinionChat = {
        id: 'minion_return_pending',
        parentChatId: 'chat_test',
        projectId: 'proj_test',
        createdAt: new Date(),
        lastModifiedAt: new Date(),
        totalInputTokens: 100,
        totalOutputTokens: 50,
      };
      mockStorageData.minionChats.set('minion_return_pending', existingChat);

      // Last assistant message has a pending return tool call
      const existingMessages: Message<unknown>[] = [
        {
          id: 'msg_user_1',
          role: 'user',
          content: { type: 'text', content: 'Do something' },
          timestamp: new Date(),
        },
        {
          id: 'msg_assistant_1',
          role: 'assistant',
          content: {
            type: 'text',
            content: '',
            fullContent: [
              {
                type: 'tool_use',
                id: 'toolu_return_1',
                name: 'return',
                input: { result: 'partial result' },
              },
            ],
          },
          timestamp: new Date(),
        },
      ];
      mockStorageData.minionMessages.set('minion_return_pending', existingMessages);

      // Mock extractToolUseBlocks to return the pending return tool from existing message
      vi.mocked(apiService.extractToolUseBlocks).mockImplementation((_apiType, fullContent) => {
        // Return the return tool from the existing message
        if (fullContent && Array.isArray(fullContent)) {
          const returnTool = fullContent.find(
            (b: { type: string; name?: string }) => b.type === 'tool_use' && b.name === 'return'
          );
          if (returnTool) {
            return [
              returnTool as {
                type: 'tool_use';
                id: string;
                name: string;
                input: Record<string, unknown>;
              },
            ];
          }
        }
        return [];
      });

      // Mock buildToolResultMessage to track that it was called
      vi.mocked(apiService.buildToolResultMessage).mockReturnValue({
        id: 'msg_tool_result_resume',
        role: 'user',
        content: { type: 'text', content: '' },
        timestamp: new Date(),
      });

      const mockResult = {
        textContent: 'Continued after return!',
        fullContent: [{ type: 'text', text: 'Continued after return!' }],
        stopReason: 'end_turn',
        inputTokens: 150,
        outputTokens: 75,
      };

      const mockStream = createMockStream([], mockResult);
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);

      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      // Resume the minion chat with a message (which becomes the return tool result)
      await collectToolResult(
        minionTool.execute(
          { message: 'Continue with this value', minionChatId: 'minion_return_pending' },
          toolOptions,
          context
        )
      );

      // Verify buildToolResultMessage was called with the user's message as content
      expect(apiService.buildToolResultMessage).toHaveBeenCalledWith('anthropic', [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_return_1',
          content: 'Continue with this value',
        },
      ]);

      // Verify the saved messages include a tool_result message, not a user message
      const savedMessages = mockStorageData.minionMessages.get('minion_return_pending') ?? [];
      // Should have: original user + original assistant + tool_result + new assistant
      expect(savedMessages.length).toBeGreaterThanOrEqual(3);

      // The third message should be the tool_result (not a regular user message)
      const thirdMessage = savedMessages[2];
      expect(thirdMessage.id).toBe('msg_tool_result_resume');
    });
  });

  describe('checkpoint population', () => {
    it('sets checkpoint to last message ID when continuing minion chat', async () => {
      // Setup: Create existing minion chat with messages
      const existingChat: MinionChat = {
        id: 'minion_checkpoint_test',
        parentChatId: 'chat_test',
        projectId: 'proj_test',
        createdAt: new Date(),
        lastModifiedAt: new Date(),
        totalInputTokens: 100,
        totalOutputTokens: 50,
        // No checkpoint initially
      };
      mockStorageData.minionChats.set('minion_checkpoint_test', existingChat);

      const existingMessages: Message<unknown>[] = [
        {
          id: 'msg_user_1',
          role: 'user',
          content: { type: 'text', content: 'First message' },
          timestamp: new Date(),
        },
        {
          id: 'msg_assistant_1',
          role: 'assistant',
          content: { type: 'text', content: 'First response' },
          timestamp: new Date(),
        },
        {
          id: 'msg_user_2',
          role: 'user',
          content: { type: 'text', content: 'Second message' },
          timestamp: new Date(),
        },
        {
          id: 'msg_assistant_2',
          role: 'assistant',
          content: { type: 'text', content: 'Second response' },
          timestamp: new Date(),
        },
      ];
      mockStorageData.minionMessages.set('minion_checkpoint_test', existingMessages);

      const mockResult = {
        textContent: 'Continued!',
        fullContent: [{ type: 'text', text: 'Continued!' }],
        stopReason: 'end_turn',
        inputTokens: 150,
        outputTokens: 75,
      };

      const mockStream = createMockStream([], mockResult);
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      // Continue the minion chat
      await collectToolResult(
        minionTool.execute(
          { message: 'Continue', minionChatId: 'minion_checkpoint_test' },
          toolOptions,
          context
        )
      );

      // Verify checkpoint was set to the last message ID before this run
      const updatedChat = mockStorageData.minionChats.get('minion_checkpoint_test');
      expect(updatedChat?.checkpoint).toBe('msg_assistant_2');
    });

    it('sets CHECKPOINT_START for new minion chat', async () => {
      const mockResult = {
        textContent: 'Done!',
        fullContent: [{ type: 'text', text: 'Done!' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      const mockStream = createMockStream([], mockResult);
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      // Create a new minion (no minionChatId)
      await collectToolResult(minionTool.execute({ message: 'New task' }, toolOptions, context));

      // Find the newly created minion chat
      const newChat = [...mockStorageData.minionChats.values()].find(
        c => c.id !== 'minion_checkpoint_test'
      );

      // New chats get CHECKPOINT_START sentinel (enables first-run retry)
      expect(newChat?.checkpoint).toBe(CHECKPOINT_START);
    });
  });

  describe('tool options integration', () => {
    it('uses custom system prompt from toolOptions', async () => {
      const mockResult = {
        textContent: 'Done',
        fullContent: [{ type: 'text', text: 'Done' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      const mockStream = createMockStream([], mockResult);

      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
        systemPrompt: 'You are a specialized coding minion.',
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      await collectToolResult(minionTool.execute({ message: 'Test' }, toolOptions, context));

      // Check the stream options passed to apiService
      const callArgs = vi.mocked(apiService.sendMessageStream).mock.calls[0];
      const streamOptions = callArgs[3];

      expect(streamOptions.systemPrompt).toContain('You are a specialized coding minion.');
    });

    it('returns Phase 2 error when enableWeb is true but allowWebSearch is not enabled', async () => {
      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
        // allowWebSearch not set (defaults to false)
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      const result = await collectToolResult(
        minionTool.execute({ message: 'Search test', enableWeb: true }, toolOptions, context)
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('Web search is not allowed');
      expect(result.content).toContain('Resend with the message to reattempt.');
    });

    it('uses web search when enableWeb is true and allowWebSearch is enabled', async () => {
      const mockResult = {
        textContent: 'Search results',
        fullContent: [{ type: 'text', text: 'Search results' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      const mockStream = createMockStream([], mockResult);

      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
        allowWebSearch: true,
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      await collectToolResult(
        minionTool.execute({ message: 'Search test', enableWeb: true }, toolOptions, context)
      );

      // Check the stream options passed to apiService
      const callArgs = vi.mocked(apiService.sendMessageStream).mock.calls[0];
      const streamOptions = callArgs[3];

      expect(streamOptions.webSearchEnabled).toBe(true);
    });
  });

  describe('retry action', () => {
    const toolOptions: ToolOptions = {
      model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
    };
    const context: ToolContext = { projectId: 'proj_test', chatId: 'chat_test' };

    function setupChatWithCheckpoint() {
      const chat: MinionChat = {
        id: 'minion_retry',
        parentChatId: 'chat_test',
        projectId: 'proj_test',
        createdAt: new Date(),
        lastModifiedAt: new Date(),
        totalInputTokens: 200,
        totalOutputTokens: 100,
        totalCost: 0.005,
        checkpoint: 'msg_assistant_1',
      };
      mockStorageData.minionChats.set('minion_retry', chat);

      const messages: Message<unknown>[] = [
        {
          id: 'msg_user_1',
          role: 'user',
          content: { type: 'text', content: 'First message' },
          timestamp: new Date(),
        },
        {
          id: 'msg_assistant_1',
          role: 'assistant',
          content: { type: 'text', content: 'First response' },
          timestamp: new Date(),
        },
        {
          id: 'msg_user_2',
          role: 'user',
          content: { type: 'text', content: 'Second message' },
          timestamp: new Date(),
        },
        {
          id: 'msg_assistant_2',
          role: 'assistant',
          content: { type: 'text', content: 'Second response' },
          timestamp: new Date(),
          metadata: { inputTokens: 80, outputTokens: 40, messageCost: 0.002 },
        },
      ];
      mockStorageData.minionMessages.set('minion_retry', messages);
      return { chat, messages };
    }

    function setupMockStream() {
      const mockResult = {
        textContent: 'Retried response!',
        fullContent: [{ type: 'text', text: 'Retried response!' }],
        stopReason: 'end_turn',
        inputTokens: 90,
        outputTokens: 45,
      };
      const mockStream = createMockStream([], mockResult);
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);
    }

    it('rolls back to checkpoint and re-sends original message', async () => {
      setupChatWithCheckpoint();
      setupMockStream();

      const result = await collectToolResult(
        minionTool.execute({ action: 'retry', minionChatId: 'minion_retry' }, toolOptions, context)
      );

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.minionChatId).toBe('minion_retry');
      expect(parsed.text).toBe('Retried response!');

      // Original message "Second message" was re-sent to the API
      const callArgs = vi.mocked(apiService.sendMessageStream).mock.calls[0];
      const sentMessages = callArgs[0] as Message<unknown>[];
      const lastUserMsg = sentMessages.filter(m => m.role === 'user').pop();
      expect(lastUserMsg?.content.content).toBe('Second message');
    });

    it('uses provided message as replacement when retrying', async () => {
      setupChatWithCheckpoint();
      setupMockStream();

      const result = await collectToolResult(
        minionTool.execute(
          { action: 'retry', minionChatId: 'minion_retry', message: 'Revised instruction' },
          toolOptions,
          context
        )
      );

      expect(result.isError).toBeUndefined();

      // The replacement message was sent to the API
      const callArgs = vi.mocked(apiService.sendMessageStream).mock.calls[0];
      const sentMessages = callArgs[0] as Message<unknown>[];
      const lastUserMsg = sentMessages.filter(m => m.role === 'user').pop();
      expect(lastUserMsg?.content.content).toBe('Revised instruction');
    });

    it('subtracts rolled-back token metadata from chat totals', async () => {
      setupChatWithCheckpoint();
      setupMockStream();

      await collectToolResult(
        minionTool.execute({ action: 'retry', minionChatId: 'minion_retry' }, toolOptions, context)
      );

      const chat = mockStorageData.minionChats.get('minion_retry')!;
      // Original: 200 input, 100 output, 0.005 cost
      // Rolled back msg_assistant_2: -80 input, -40 output, -0.002 cost
      // New run: +90 input, +45 output
      expect(chat.totalInputTokens).toBe(200 - 80 + 90);
      expect(chat.totalOutputTokens).toBe(100 - 40 + 45);
      expect(chat.totalCost).toBeCloseTo(0.005 - 0.002 + 0.001); // 0.001 from calculateCost mock
    });

    it('returns Phase 1 error when checkpoint is missing', async () => {
      const chat: MinionChat = {
        id: 'minion_no_cp',
        parentChatId: 'chat_test',
        projectId: 'proj_test',
        createdAt: new Date(),
        lastModifiedAt: new Date(),
        // checkpoint: undefined — no checkpoint
      };
      mockStorageData.minionChats.set('minion_no_cp', chat);
      mockStorageData.minionMessages.set('minion_no_cp', []);

      const result = await collectToolResult(
        minionTool.execute({ action: 'retry', minionChatId: 'minion_no_cp' }, toolOptions, context)
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('no checkpoint');
      expect(result.content).toContain('Resend to reattempt.');
    });

    it('returns Phase 1 error when no messages after checkpoint', async () => {
      const chat: MinionChat = {
        id: 'minion_empty_cp',
        parentChatId: 'chat_test',
        projectId: 'proj_test',
        createdAt: new Date(),
        lastModifiedAt: new Date(),
        checkpoint: 'msg_last',
      };
      mockStorageData.minionChats.set('minion_empty_cp', chat);
      mockStorageData.minionMessages.set('minion_empty_cp', [
        {
          id: 'msg_last',
          role: 'assistant',
          content: { type: 'text', content: 'Last message' },
          timestamp: new Date(),
        },
      ]);

      const result = await collectToolResult(
        minionTool.execute(
          { action: 'retry', minionChatId: 'minion_empty_cp' },
          toolOptions,
          context
        )
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('No messages after checkpoint');
      expect(result.content).toContain('Resend to reattempt.');
    });

    it('deletes messages after checkpoint via storage', async () => {
      setupChatWithCheckpoint();
      setupMockStream();

      const { storage } = await import('../../storage');

      await collectToolResult(
        minionTool.execute({ action: 'retry', minionChatId: 'minion_retry' }, toolOptions, context)
      );

      expect(storage.deleteMessagesAfter).toHaveBeenCalledWith('minion_retry', 'msg_assistant_1');
    });

    it('retries first run when checkpoint is CHECKPOINT_START', async () => {
      // Chat with CHECKPOINT_START (first run that generated some messages)
      const chat: MinionChat = {
        id: 'minion_first_retry',
        parentChatId: 'chat_test',
        projectId: 'proj_test',
        createdAt: new Date(),
        lastModifiedAt: new Date(),
        totalInputTokens: 100,
        totalOutputTokens: 50,
        checkpoint: CHECKPOINT_START,
      };
      mockStorageData.minionChats.set('minion_first_retry', chat);

      const messages: Message<unknown>[] = [
        {
          id: 'msg_user_1',
          role: 'user',
          content: { type: 'text', content: 'Original first message' },
          timestamp: new Date(),
        },
        {
          id: 'msg_assistant_1',
          role: 'assistant',
          content: { type: 'text', content: 'Failed response' },
          timestamp: new Date(),
          metadata: { inputTokens: 50, outputTokens: 30 },
        },
      ];
      mockStorageData.minionMessages.set('minion_first_retry', messages);
      setupMockStream();

      const { storage } = await import('../../storage');

      const result = await collectToolResult(
        minionTool.execute(
          { action: 'retry', minionChatId: 'minion_first_retry' },
          toolOptions,
          context
        )
      );

      expect(result.isError).toBeUndefined();
      // Uses deleteMessageAndAfter (not deleteMessagesAfter) for CHECKPOINT_START
      expect(storage.deleteMessageAndAfter).toHaveBeenCalledWith(
        'minion_first_retry',
        'msg_user_1'
      );
      // Original message re-sent
      const callArgs = vi.mocked(apiService.sendMessageStream).mock.calls[0];
      const sentMessages = callArgs[0] as Message<unknown>[];
      const lastUserMsg = sentMessages.filter(m => m.role === 'user').pop();
      expect(lastUserMsg?.content.content).toBe('Original first message');
    });

    it('checkpoint stays unchanged after retry', async () => {
      setupChatWithCheckpoint();
      setupMockStream();

      await collectToolResult(
        minionTool.execute({ action: 'retry', minionChatId: 'minion_retry' }, toolOptions, context)
      );

      const chat = mockStorageData.minionChats.get('minion_retry')!;
      // Checkpoint should still point to the same position (not recalculated)
      expect(chat.checkpoint).toBe('msg_assistant_1');
    });

    describe('retry-without-message on tool_result messages', () => {
      function setupToolResultRetryChat(modelFamily: APIType) {
        const chat: MinionChat = {
          id: 'minion_tr_retry',
          parentChatId: 'chat_test',
          projectId: 'proj_test',
          createdAt: new Date(),
          lastModifiedAt: new Date(),
          totalInputTokens: 100,
          totalOutputTokens: 50,
          checkpoint: 'msg_assistant_1',
        };
        mockStorageData.minionChats.set('minion_tr_retry', chat);

        // The rolled-back message is a tool_result with empty content.content
        // (as produced by buildToolResultMessage)
        const toolResultFullContent = [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_return_1',
            content: 'The return value text',
          },
        ];

        const messages: Message<unknown>[] = [
          {
            id: 'msg_user_1',
            role: 'user',
            content: { type: 'text', content: 'Do something' },
            timestamp: new Date(),
          },
          {
            id: 'msg_assistant_1',
            role: 'assistant',
            content: {
              type: 'text',
              content: '',
              fullContent: [
                {
                  type: 'tool_use',
                  id: 'toolu_return_1',
                  name: 'return',
                  input: { result: 'partial' },
                },
              ],
            },
            timestamp: new Date(),
          },
          {
            id: 'msg_tool_result_2',
            role: 'user',
            content: {
              type: 'text',
              content: '', // buildToolResultMessage always sets this to ''
              modelFamily,
              fullContent: toolResultFullContent,
            },
            timestamp: new Date(),
          },
          {
            id: 'msg_assistant_2',
            role: 'assistant',
            content: { type: 'text', content: 'Response after tool result' },
            timestamp: new Date(),
            metadata: { inputTokens: 50, outputTokens: 25 },
          },
        ];
        mockStorageData.minionMessages.set('minion_tr_retry', messages);
        return { chat, messages };
      }

      it('re-uses fullContent directly when modelFamily matches apiDef.apiType', async () => {
        // modelFamily 'anthropic' matches the test API def's apiType 'anthropic'
        setupToolResultRetryChat('anthropic');
        setupMockStream();

        const result = await collectToolResult(
          minionTool.execute(
            { action: 'retry', minionChatId: 'minion_tr_retry' },
            toolOptions,
            context
          )
        );

        expect(result.isError).toBeUndefined();

        // The message sent to the API should have the stashed fullContent re-used
        const callArgs = vi.mocked(apiService.sendMessageStream).mock.calls[0];
        const sentMessages = callArgs[0] as Message<unknown>[];
        const lastUserMsg = sentMessages.filter(m => m.role === 'user').pop();

        // fullContent should be the original tool_result array (not reconstructed)
        expect(lastUserMsg?.content.fullContent).toEqual([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_return_1',
            content: 'The return value text',
          },
        ]);
        expect(lastUserMsg?.content.modelFamily).toBe('anthropic');
        // Text extracted from fullContent should be set as content
        expect(lastUserMsg?.content.content).toBe('The return value text');
      });

      it('extracts text from fullContent when modelFamily does not match', async () => {
        // modelFamily 'responses_api' does NOT match the test API def's apiType 'anthropic'
        const chat: MinionChat = {
          id: 'minion_tr_incompat',
          parentChatId: 'chat_test',
          projectId: 'proj_test',
          createdAt: new Date(),
          lastModifiedAt: new Date(),
          totalInputTokens: 100,
          totalOutputTokens: 50,
          checkpoint: 'msg_assistant_1',
        };
        mockStorageData.minionChats.set('minion_tr_incompat', chat);

        const messages: Message<unknown>[] = [
          {
            id: 'msg_user_1',
            role: 'user',
            content: { type: 'text', content: 'Do something' },
            timestamp: new Date(),
          },
          {
            id: 'msg_assistant_1',
            role: 'assistant',
            content: { type: 'text', content: 'Response' },
            timestamp: new Date(),
          },
          {
            id: 'msg_tool_result_2',
            role: 'user',
            content: {
              type: 'text',
              content: '', // Empty — typical for buildToolResultMessage
              modelFamily: 'responses_api',
              fullContent: [
                {
                  type: 'function_call_output',
                  call_id: 'call_1',
                  output: 'Extracted output text',
                },
              ],
            },
            timestamp: new Date(),
          },
          {
            id: 'msg_assistant_2',
            role: 'assistant',
            content: { type: 'text', content: 'Final response' },
            timestamp: new Date(),
            metadata: { inputTokens: 50, outputTokens: 25 },
          },
        ];
        mockStorageData.minionMessages.set('minion_tr_incompat', messages);
        setupMockStream();

        const result = await collectToolResult(
          minionTool.execute(
            { action: 'retry', minionChatId: 'minion_tr_incompat' },
            toolOptions,
            context
          )
        );

        expect(result.isError).toBeUndefined();

        // Since modelFamily doesn't match, text was extracted and a normal user message built
        const callArgs = vi.mocked(apiService.sendMessageStream).mock.calls[0];
        const sentMessages = callArgs[0] as Message<unknown>[];
        const lastUserMsg = sentMessages.filter(m => m.role === 'user').pop();

        // Should be a plain text message (no fullContent from stash)
        expect(lastUserMsg?.content.content).toBe('Extracted output text');
        // No modelFamily on a plain text user message
        expect(lastUserMsg?.content.fullContent).toBeUndefined();
      });

      it('extracts text from Bedrock-format fullContent', async () => {
        const chat: MinionChat = {
          id: 'minion_tr_bedrock',
          parentChatId: 'chat_test',
          projectId: 'proj_test',
          createdAt: new Date(),
          lastModifiedAt: new Date(),
          totalInputTokens: 100,
          totalOutputTokens: 50,
          checkpoint: 'msg_assistant_1',
        };
        mockStorageData.minionChats.set('minion_tr_bedrock', chat);

        const messages: Message<unknown>[] = [
          {
            id: 'msg_user_1',
            role: 'user',
            content: { type: 'text', content: 'Do something' },
            timestamp: new Date(),
          },
          {
            id: 'msg_assistant_1',
            role: 'assistant',
            content: { type: 'text', content: 'Response' },
            timestamp: new Date(),
          },
          {
            id: 'msg_tool_result_2',
            role: 'user',
            content: {
              type: 'text',
              content: '',
              modelFamily: 'bedrock',
              fullContent: [
                {
                  toolResult: {
                    toolUseId: 'tool_1',
                    content: [{ text: 'Bedrock result text' }],
                    status: 'success',
                  },
                },
              ],
            },
            timestamp: new Date(),
          },
          {
            id: 'msg_assistant_2',
            role: 'assistant',
            content: { type: 'text', content: 'Final' },
            timestamp: new Date(),
            metadata: { inputTokens: 50, outputTokens: 25 },
          },
        ];
        mockStorageData.minionMessages.set('minion_tr_bedrock', messages);
        setupMockStream();

        const result = await collectToolResult(
          minionTool.execute(
            { action: 'retry', minionChatId: 'minion_tr_bedrock' },
            toolOptions,
            context
          )
        );

        expect(result.isError).toBeUndefined();

        const callArgs = vi.mocked(apiService.sendMessageStream).mock.calls[0];
        const sentMessages = callArgs[0] as Message<unknown>[];
        const lastUserMsg = sentMessages.filter(m => m.role === 'user').pop();
        expect(lastUserMsg?.content.content).toBe('Bedrock result text');
      });
    });

    it('Phase 2 errors after checkpoint do not corrupt retry state', async () => {
      // Setup a chat with valid checkpoint
      const chat: MinionChat = {
        id: 'minion_phase2',
        parentChatId: 'chat_test',
        projectId: 'proj_test',
        createdAt: new Date(),
        lastModifiedAt: new Date(),
        checkpoint: 'msg_assistant_1',
      };
      mockStorageData.minionChats.set('minion_phase2', chat);
      mockStorageData.minionMessages.set('minion_phase2', [
        {
          id: 'msg_user_1',
          role: 'user',
          content: { type: 'text', content: 'First message' },
          timestamp: new Date(),
        },
        {
          id: 'msg_assistant_1',
          role: 'assistant',
          content: { type: 'text', content: 'Response' },
          timestamp: new Date(),
        },
      ]);

      // Clear models to trigger Phase 2 error
      mockStorageData.models.clear();

      const result = await collectToolResult(
        minionTool.execute(
          { message: 'Continue', minionChatId: 'minion_phase2' },
          toolOptions,
          context
        )
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('Resend with the message to reattempt.');

      // Checkpoint was advanced (normal continuation saves checkpoint)
      const updatedChat = mockStorageData.minionChats.get('minion_phase2')!;
      expect(updatedChat.checkpoint).toBe('msg_assistant_1');

      // Messages remain intact (no rollback or deletion happened)
      const msgs = mockStorageData.minionMessages.get('minion_phase2')!;
      expect(msgs).toHaveLength(2);
    });
  });

  describe('tool scoping defaults and validation', () => {
    it('defaults to only return tool when enabledTools omitted', async () => {
      const mockResult = {
        textContent: 'Done',
        fullContent: [{ type: 'text', text: 'Done' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      const mockStream = createMockStream([], mockResult);
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      // No enabledTools specified
      await collectToolResult(minionTool.execute({ message: 'Test' }, toolOptions, context));

      const callArgs = vi.mocked(apiService.sendMessageStream).mock.calls[0];
      const streamOptions = callArgs[3];

      // Only 'return' should be available
      expect(streamOptions.enabledTools).toEqual(['return']);
    });

    it('returns Phase 2 error when enabledTools contains tools not in project', async () => {
      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      const result = await collectToolResult(
        minionTool.execute(
          { message: 'Test', enabledTools: ['memory', 'nonexistent'] },
          toolOptions,
          context
        )
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('Tools not available in project: nonexistent');
      expect(result.content).toContain('Resend with the message to reattempt.');
    });

    it('does not trigger validation error when return is in enabledTools', async () => {
      const mockResult = {
        textContent: 'Done',
        fullContent: [{ type: 'text', text: 'Done' }],
        stopReason: 'end_turn',
        inputTokens: 100,
        outputTokens: 50,
      };

      const mockStream = createMockStream([], mockResult);
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as never);
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);

      const toolOptions: ToolOptions = {
        model: { apiDefinitionId: 'api_test', modelId: 'claude-3-sonnet' },
      };

      const context: ToolContext = {
        projectId: 'proj_test',
        chatId: 'chat_test',
      };

      // 'return' is always available, shouldn't trigger validation
      const result = await collectToolResult(
        minionTool.execute(
          { message: 'Test', enabledTools: ['memory', 'return'] },
          toolOptions,
          context
        )
      );

      expect(result.isError).toBeUndefined();

      const callArgs = vi.mocked(apiService.sendMessageStream).mock.calls[0];
      const streamOptions = callArgs[3];
      expect(streamOptions.enabledTools).toContain('memory');
      expect(streamOptions.enabledTools).toContain('return');
    });
  });
});
