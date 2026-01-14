import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runAgenticLoop,
  populateToolRenderFields,
  createToolResultRenderBlock,
  getEnabledTools,
  buildStreamOptions,
  loadAttachmentsForMessages,
  type AgenticLoopContext,
  type AgenticLoopCallbacks,
  type PendingMessage,
} from '../agenticLoop';
import { storage } from '../../services/storage';
import { apiService } from '../../services/api/apiService';
import { executeClientSideTool, toolRegistry } from '../../services/tools/clientSideTools';
import { configureJsTool } from '../../services/tools/jsTool';
import type { Chat, Project, Message, APIDefinition, RenderingBlockGroup } from '../../types';
import type { ToolUseRenderBlock } from '../../types/content';

// Mock dependencies
vi.mock('../../services/storage');
vi.mock('../../services/api/apiService');
vi.mock('../../services/tools/clientSideTools', async () => {
  const actual = await vi.importActual('../../services/tools/clientSideTools');
  return {
    ...actual,
    executeClientSideTool: vi.fn(),
  };
});
vi.mock('../../services/tools/jsTool');
vi.mock('../../utils/idGenerator', () => ({
  generateUniqueId: vi.fn(() => 'msg_test_123'),
}));

describe('agenticLoop', () => {
  const mockProject: Project = {
    id: 'proj_123',
    name: 'Test Project',
    icon: '📁',
    createdAt: new Date('2024-01-01'),
    lastUsedAt: new Date('2024-01-01'),
    apiDefinitionId: 'api_123',
    modelId: 'gpt-4',
    systemPrompt: 'Test prompt',
    preFillResponse: '',
    webSearchEnabled: false,
    temperature: 1.0,
    maxOutputTokens: 2048,
    enableReasoning: false,
    reasoningBudgetTokens: 2048,
    memoryEnabled: false,
    jsExecutionEnabled: false,
    fsToolEnabled: false,
  };

  const mockChat: Chat = {
    id: 'chat_123',
    projectId: 'proj_123',
    name: 'Test Chat',
    createdAt: new Date('2024-01-01'),
    lastModifiedAt: new Date('2024-01-01'),
    apiDefinitionId: null,
    modelId: null,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCost: 0.001,
    contextWindowUsage: 150,
  };

  const mockApiDefinition: APIDefinition = {
    id: 'api_123',
    name: 'Anthropic',
    apiType: 'anthropic' as const,
    baseUrl: '',
    apiKey: 'test-key',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };

  const mockUserMessage: Message<string> = {
    id: 'msg_user_1',
    role: 'user',
    content: { type: 'text', content: 'Hello' },
    timestamp: new Date('2024-01-01'),
  };

  const mockCallbacks: AgenticLoopCallbacks = {
    onMessageSaved: vi.fn(),
    onStreamingStart: vi.fn(),
    onStreamingUpdate: vi.fn(),
    onStreamingEnd: vi.fn(),
    onFirstChunk: vi.fn(),
    onChatUpdated: vi.fn(),
    onProjectUpdated: vi.fn(),
    onError: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    vi.mocked(storage.saveMessage).mockResolvedValue();
    vi.mocked(storage.saveChat).mockResolvedValue();
    vi.mocked(storage.saveProject).mockResolvedValue();
    vi.mocked(storage.getModels).mockResolvedValue([
      { id: 'gpt-4', name: 'GPT-4', apiType: 'chatgpt' as const, contextWindow: 8192 },
    ]);
    vi.mocked(storage.getAttachments).mockResolvedValue([]);
    vi.mocked(apiService.calculateCost).mockReturnValue(0.0001);
    vi.mocked(apiService.mapStopReason).mockReturnValue('end_turn');
    vi.mocked(apiService.shouldPrependPrefill).mockReturnValue(false);
    vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);
    vi.mocked(executeClientSideTool).mockResolvedValue({ content: 'pong', isError: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('runAgenticLoop', () => {
    it('should process a simple message and return success', async () => {
      const mockStreamGenerator = async function* () {
        yield { type: 'content' as const, content: 'Hello ' };
        yield { type: 'content' as const, content: 'world' };
        return {
          textContent: 'Hello world',
          fullContent: {},
          inputTokens: 10,
          outputTokens: 5,
          stopReason: 'end_turn',
        };
      };
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStreamGenerator());

      const context: AgenticLoopContext = {
        chatId: 'chat_123',
        chat: mockChat,
        project: mockProject,
        apiDef: mockApiDefinition,
        modelId: 'gpt-4',
        currentMessages: [],
      };

      const pendingMessage: PendingMessage = { type: 'user', message: mockUserMessage };

      const result = await runAgenticLoop(context, [pendingMessage], mockCallbacks);

      expect(result.success).toBe(true);
      expect(result.savedMessages).toHaveLength(2); // user + assistant
      expect(mockCallbacks.onStreamingStart).toHaveBeenCalled();
      expect(mockCallbacks.onStreamingEnd).toHaveBeenCalled();
      expect(mockCallbacks.onChatUpdated).toHaveBeenCalled();
      expect(mockCallbacks.onProjectUpdated).toHaveBeenCalled();
    });

    it('should handle API errors gracefully', async () => {
      const mockStreamGenerator = async function* () {
        return {
          textContent: '',
          fullContent: {},
          error: { message: 'API Error', status: 500 },
          inputTokens: 0,
          outputTokens: 0,
        };
      };
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStreamGenerator());

      const context: AgenticLoopContext = {
        chatId: 'chat_123',
        chat: mockChat,
        project: mockProject,
        apiDef: mockApiDefinition,
        modelId: 'gpt-4',
        currentMessages: [],
      };

      const result = await runAgenticLoop(
        context,
        [{ type: 'user', message: mockUserMessage }],
        mockCallbacks
      );

      expect(result.success).toBe(true); // API error is handled, not thrown
      expect(result.savedMessages).toHaveLength(2); // user + error assistant
      expect(mockCallbacks.onStreamingEnd).toHaveBeenCalled();
    });

    it('should execute tools and continue loop on tool_use', async () => {
      // First response with tool_use
      const toolUseResponse = async function* () {
        yield { type: 'content' as const, content: 'Let me ping' };
        return {
          textContent: 'Let me ping',
          fullContent: [{ type: 'tool_use', id: 'tool_1', name: 'ping', input: {} }],
          inputTokens: 10,
          outputTokens: 5,
          stopReason: 'tool_use',
        };
      };

      // Second response after tool result
      const finalResponse = async function* () {
        yield { type: 'content' as const, content: 'Got pong!' };
        return {
          textContent: 'Got pong!',
          fullContent: {},
          inputTokens: 15,
          outputTokens: 10,
          stopReason: 'end_turn',
        };
      };

      vi.mocked(apiService.sendMessageStream)
        .mockReturnValueOnce(toolUseResponse())
        .mockReturnValueOnce(finalResponse());

      vi.mocked(apiService.extractToolUseBlocks).mockReturnValueOnce([
        { type: 'tool_use', id: 'tool_1', name: 'ping', input: {} },
      ]);

      vi.mocked(apiService.buildToolResultMessages).mockReturnValue([
        {
          id: 'msg_1',
          role: 'assistant',
          content: { type: 'text', content: '' },
          timestamp: new Date(),
        },
        {
          id: 'msg_2',
          role: 'user',
          content: {
            type: 'text',
            content: '',
            fullContent: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'pong' }],
          },
          timestamp: new Date(),
        },
      ]);

      const context: AgenticLoopContext = {
        chatId: 'chat_123',
        chat: mockChat,
        project: mockProject,
        apiDef: mockApiDefinition,
        modelId: 'gpt-4',
        currentMessages: [],
      };

      const result = await runAgenticLoop(
        context,
        [{ type: 'user', message: mockUserMessage }],
        mockCallbacks
      );

      expect(result.success).toBe(true);
      // user + assistant(tool_use) + tool_result + assistant(final)
      expect(result.savedMessages.length).toBeGreaterThanOrEqual(3);
      expect(executeClientSideTool).toHaveBeenCalledWith('ping', {});
    });

    it('should configure JS tool at loop start when JS enabled', async () => {
      const projectWithJs: Project = { ...mockProject, jsExecutionEnabled: true };

      const mockStreamGenerator = async function* () {
        yield { type: 'content' as const, content: 'Hello' };
        return {
          textContent: 'Hello',
          fullContent: {},
          inputTokens: 10,
          outputTokens: 5,
          stopReason: 'end_turn',
        };
      };
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStreamGenerator());

      const context: AgenticLoopContext = {
        chatId: 'chat_123',
        chat: mockChat,
        project: projectWithJs,
        apiDef: mockApiDefinition,
        modelId: 'gpt-4',
        currentMessages: [],
      };

      await runAgenticLoop(context, [{ type: 'user', message: mockUserMessage }], mockCallbacks);

      expect(configureJsTool).toHaveBeenCalledWith('proj_123', true);
    });

    it('should respect max iterations limit', async () => {
      // Create a stream that always returns tool_use
      const toolUseResponse = () =>
        (async function* () {
          yield { type: 'content' as const, content: 'Tool call' };
          return {
            textContent: 'Tool call',
            fullContent: [{ type: 'tool_use', id: `tool_${Date.now()}`, name: 'ping', input: {} }],
            inputTokens: 10,
            outputTokens: 5,
            stopReason: 'tool_use',
          };
        })();

      vi.mocked(apiService.sendMessageStream).mockImplementation(() => toolUseResponse());

      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([
        { type: 'tool_use', id: 'tool_1', name: 'ping', input: {} },
      ]);

      vi.mocked(apiService.buildToolResultMessages).mockReturnValue([
        {
          id: 'msg_1',
          role: 'assistant',
          content: { type: 'text', content: '' },
          timestamp: new Date(),
        },
        {
          id: 'msg_2',
          role: 'user',
          content: {
            type: 'text',
            content: '',
            fullContent: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'pong' }],
          },
          timestamp: new Date(),
        },
      ]);

      const context: AgenticLoopContext = {
        chatId: 'chat_123',
        chat: mockChat,
        project: mockProject,
        apiDef: mockApiDefinition,
        modelId: 'gpt-4',
        currentMessages: [],
      };

      const result = await runAgenticLoop(
        context,
        [{ type: 'user', message: mockUserMessage }],
        mockCallbacks
      );

      // Should stop at max iterations (50)
      expect(apiService.sendMessageStream).toHaveBeenCalledTimes(50);
      expect(result.success).toBe(true);
    });

    it('should accumulate costs across iterations', async () => {
      const firstResponse = async function* () {
        yield { type: 'content' as const, content: 'First' };
        return {
          textContent: 'First',
          fullContent: [{ type: 'tool_use', id: 'tool_1', name: 'ping', input: {} }],
          inputTokens: 100,
          outputTokens: 50,
          stopReason: 'tool_use',
        };
      };

      const secondResponse = async function* () {
        yield { type: 'content' as const, content: 'Second' };
        return {
          textContent: 'Second',
          fullContent: {},
          inputTokens: 150,
          outputTokens: 75,
          stopReason: 'end_turn',
        };
      };

      vi.mocked(apiService.sendMessageStream)
        .mockReturnValueOnce(firstResponse())
        .mockReturnValueOnce(secondResponse());

      vi.mocked(apiService.extractToolUseBlocks).mockReturnValueOnce([
        { type: 'tool_use', id: 'tool_1', name: 'ping', input: {} },
      ]);

      vi.mocked(apiService.buildToolResultMessages).mockReturnValue([
        {
          id: 'msg_1',
          role: 'assistant',
          content: { type: 'text', content: '' },
          timestamp: new Date(),
        },
        {
          id: 'msg_2',
          role: 'user',
          content: {
            type: 'text',
            content: '',
            fullContent: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'pong' }],
          },
          timestamp: new Date(),
        },
      ]);

      vi.mocked(apiService.calculateCost)
        .mockReturnValueOnce(0.001) // First call
        .mockReturnValueOnce(0.002); // Second call

      const context: AgenticLoopContext = {
        chatId: 'chat_123',
        chat: mockChat,
        project: mockProject,
        apiDef: mockApiDefinition,
        modelId: 'gpt-4',
        currentMessages: [],
      };

      const result = await runAgenticLoop(
        context,
        [{ type: 'user', message: mockUserMessage }],
        mockCallbacks
      );

      expect(result.totalTokens.inputTokens).toBe(250); // 100 + 150
      expect(result.totalTokens.outputTokens).toBe(125); // 50 + 75
      expect(result.totalTokens.cost).toBe(0.003); // 0.001 + 0.002
    });

    it('should call onFirstChunk only once per iteration', async () => {
      const mockStreamGenerator = async function* () {
        yield { type: 'content' as const, content: 'A' };
        yield { type: 'content' as const, content: 'B' };
        yield { type: 'content' as const, content: 'C' };
        return {
          textContent: 'ABC',
          fullContent: {},
          inputTokens: 10,
          outputTokens: 5,
          stopReason: 'end_turn',
        };
      };
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStreamGenerator());

      const context: AgenticLoopContext = {
        chatId: 'chat_123',
        chat: mockChat,
        project: mockProject,
        apiDef: mockApiDefinition,
        modelId: 'gpt-4',
        currentMessages: [],
      };

      await runAgenticLoop(context, [{ type: 'user', message: mockUserMessage }], mockCallbacks);

      expect(mockCallbacks.onFirstChunk).toHaveBeenCalledTimes(1);
    });

    it('should handle tool result messages in initial pending', async () => {
      const mockStreamGenerator = async function* () {
        yield { type: 'content' as const, content: 'Got the result' };
        return {
          textContent: 'Got the result',
          fullContent: {},
          inputTokens: 10,
          outputTokens: 5,
          stopReason: 'end_turn',
        };
      };
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStreamGenerator());

      const toolResultMessage: Message<unknown> = {
        id: 'msg_tool_result',
        role: 'user',
        content: {
          type: 'text',
          content: '',
          fullContent: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'pong' }],
        },
        timestamp: new Date(),
      };

      const context: AgenticLoopContext = {
        chatId: 'chat_123',
        chat: mockChat,
        project: mockProject,
        apiDef: mockApiDefinition,
        modelId: 'gpt-4',
        currentMessages: [mockUserMessage],
      };

      const result = await runAgenticLoop(
        context,
        [{ type: 'tool_result', message: toolResultMessage }],
        mockCallbacks
      );

      expect(result.success).toBe(true);
      expect(storage.saveMessage).toHaveBeenCalledWith('chat_123', toolResultMessage);
    });

    it('should handle errors gracefully and call callbacks', async () => {
      vi.mocked(apiService.sendMessageStream).mockImplementation(() => {
        throw new Error('Network error');
      });

      const context: AgenticLoopContext = {
        chatId: 'chat_123',
        chat: mockChat,
        project: mockProject,
        apiDef: mockApiDefinition,
        modelId: 'gpt-4',
        currentMessages: [],
      };

      const result = await runAgenticLoop(
        context,
        [{ type: 'user', message: mockUserMessage }],
        mockCallbacks
      );

      expect(result.success).toBe(false);
      expect(mockCallbacks.onError).toHaveBeenCalled();
      expect(mockCallbacks.onStreamingEnd).toHaveBeenCalled();
    });
  });

  describe('populateToolRenderFields', () => {
    it('should populate render fields for tool_use blocks', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'backstage',
          blocks: [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'ping',
              input: { message: 'test' },
            } as ToolUseRenderBlock,
          ],
        },
      ];

      populateToolRenderFields(groups);

      const block = groups[0].blocks[0] as ToolUseRenderBlock;
      expect(block.icon).toBeDefined();
      expect(block.renderedInput).toBeDefined();
    });

    it('should handle empty input', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'backstage',
          blocks: [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'ping',
              input: {},
            } as ToolUseRenderBlock,
          ],
        },
      ];

      populateToolRenderFields(groups);

      const block = groups[0].blocks[0] as ToolUseRenderBlock;
      expect(block.renderedInput).toBe('');
    });
  });

  describe('createToolResultRenderBlock', () => {
    it('should create success result block', () => {
      const block = createToolResultRenderBlock('tool_1', 'ping', 'pong', false);

      expect(block.type).toBe('tool_result');
      expect(block.tool_use_id).toBe('tool_1');
      expect(block.content).toBe('pong');
      expect(block.is_error).toBe(false);
      expect(block.name).toBe('ping');
      expect(block.icon).toBe('✅');
    });

    it('should create error result block', () => {
      const block = createToolResultRenderBlock('tool_1', 'ping', 'Error occurred', true);

      expect(block.is_error).toBe(true);
      expect(block.icon).toBe('❌');
    });
  });

  describe('getEnabledTools', () => {
    it('should return empty array when no tools enabled', () => {
      const tools = getEnabledTools(mockProject);
      expect(tools).toEqual([]);
    });

    it('should return enabled tools', () => {
      const projectWithTools: Project = {
        ...mockProject,
        memoryEnabled: true,
        jsExecutionEnabled: true,
        fsToolEnabled: true,
      };

      const tools = getEnabledTools(projectWithTools);
      expect(tools).toContain('memory');
      expect(tools).toContain('javascript');
      expect(tools).toContain('filesystem');
    });
  });

  describe('buildStreamOptions', () => {
    it('should build options from project settings', () => {
      const options = buildStreamOptions(mockProject, []);

      expect(options.temperature).toBe(1.0);
      expect(options.maxTokens).toBe(2048);
      expect(options.enableReasoning).toBe(false);
      expect(options.systemPrompt).toBe('Test prompt');
    });

    it('should combine system prompts with tool prompts', () => {
      // Register a mock tool system prompt
      const originalGet = toolRegistry.getSystemPrompts;
      vi.spyOn(toolRegistry, 'getSystemPrompts').mockReturnValue(['Tool system prompt']);

      const options = buildStreamOptions(mockProject, ['memory']);

      expect(options.systemPrompt).toContain('Test prompt');
      expect(options.systemPrompt).toContain('Tool system prompt');

      // Restore
      toolRegistry.getSystemPrompts = originalGet;
    });
  });

  describe('loadAttachmentsForMessages', () => {
    it('should load attachments for user messages', async () => {
      const messageWithAttachments: Message<string> = {
        ...mockUserMessage,
        content: {
          type: 'text',
          content: 'Check this',
          attachmentIds: ['att_1'],
        },
      };

      vi.mocked(storage.getAttachments).mockResolvedValue([
        { id: 'att_1', type: 'image', mimeType: 'image/jpeg', data: 'base64data' },
      ]);

      const result = await loadAttachmentsForMessages([messageWithAttachments]);

      expect(result[0].attachments).toHaveLength(1);
    });

    it('should add system note for missing attachments', async () => {
      const messageWithAttachments: Message<string> = {
        ...mockUserMessage,
        content: {
          type: 'text',
          content: 'Check this',
          attachmentIds: ['att_1', 'att_2'],
          originalAttachmentCount: 2,
        },
      };

      // Only return one attachment (one missing)
      vi.mocked(storage.getAttachments).mockResolvedValue([
        { id: 'att_1', type: 'image', mimeType: 'image/jpeg', data: 'base64data' },
      ]);

      const result = await loadAttachmentsForMessages([messageWithAttachments]);

      expect(result[0].content.content).toContain('1 attachment(s) removed to save space');
      expect(result[0].content.attachmentIds).toEqual(['att_1']);
    });

    it('should not modify messages without attachments', async () => {
      const result = await loadAttachmentsForMessages([mockUserMessage]);

      expect(result[0]).toEqual(mockUserMessage);
      expect(storage.getAttachments).not.toHaveBeenCalled();
    });
  });
});
