import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useChat } from '../useChat';
import { storage } from '../../services/storage';
import { apiService } from '../../services/api/apiService';
import * as modelMetadata from '../../services/api/modelMetadata';
import { generateUniqueId } from '../../utils/idGenerator';
import * as alerts from '../../utils/alerts';
import type { Chat, Project, Message, APIDefinition } from '../../types';

// Mock dependencies
vi.mock('../../services/storage');
vi.mock('../../services/api/apiService');
vi.mock('../../services/api/modelMetadata');
vi.mock('../../utils/idGenerator');
vi.mock('../../utils/alerts');
// Note: agenticLoopGenerator is NOT mocked - we let the real generator run
// which will call the mocked apiService.sendMessageStream

describe('useChat', () => {
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
    name: 'OpenAI',
    apiType: 'chatgpt' as const,
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

  const mockAssistantMessage: Message<unknown> = {
    id: 'msg_assistant_1',
    role: 'assistant',
    content: { type: 'text', content: 'Hi there!' },
    timestamp: new Date('2024-01-01'),
    metadata: {
      model: 'gpt-4',
      inputTokens: 10,
      outputTokens: 5,
      messageCost: 0.0001,
      contextWindow: 8192,
      contextWindowUsage: 15,
    },
  };

  const mockCallbacks = {
    onMessagesLoaded: vi.fn(),
    onMessageAppended: vi.fn(),
    onMessagesRemovedOnAndAfter: vi.fn(),
    onStreamingStart: vi.fn(),
    onStreamingEnd: vi.fn(),
    onChatMetadataChanged: vi.fn(),
    onForkMessageLoaded: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    vi.mocked(storage.getChat).mockResolvedValue(mockChat);
    vi.mocked(storage.getProject).mockResolvedValue(mockProject);
    vi.mocked(storage.getMessages).mockResolvedValue([mockUserMessage, mockAssistantMessage]);
    vi.mocked(storage.getAPIDefinition).mockResolvedValue(mockApiDefinition);
    vi.mocked(storage.saveChat).mockResolvedValue();
    vi.mocked(storage.saveMessage).mockResolvedValue();
    vi.mocked(storage.saveProject).mockResolvedValue();
    vi.mocked(storage.saveAttachment).mockResolvedValue();
    vi.mocked(storage.getAttachments).mockResolvedValue([]);
    vi.mocked(storage.deleteMessageAndAfter).mockResolvedValue();
    vi.mocked(storage.cloneChat).mockResolvedValue({ ...mockChat, id: 'chat_forked' });
    vi.mocked(storage.getModel).mockResolvedValue({
      id: 'gpt-4',
      name: 'gpt-4',
      apiType: 'chatgpt',
      matchedMode: 'exact',
      inputPrice: 2.5,
      outputPrice: 10,
      contextWindow: 128000,
    });
    vi.mocked(generateUniqueId).mockReturnValue('msg_new_123');
    vi.mocked(alerts.showAlert).mockResolvedValue();
    vi.mocked(modelMetadata.calculateCost).mockReturnValue(0.0001);
    vi.mocked(modelMetadata.getModelMetadataFor).mockReturnValue({
      id: 'gpt-4',
      name: 'gpt-4',
      apiType: 'chatgpt',
      matchedMode: 'exact',
      inputPrice: 2.5,
      outputPrice: 10,
      contextWindow: 128000,
    });
    vi.mocked(apiService.migrateMessageRendering).mockReturnValue({
      renderingContent: [{ category: 'text', blocks: [{ type: 'text', text: 'test' }] }],
      stopReason: 'end_turn',
    });
    vi.mocked(apiService.shouldPrependPrefill).mockReturnValue(false);
    vi.mocked(apiService.mapStopReason).mockReturnValue('end_turn');
    vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Initial Loading', () => {
    it('should load chat, project, messages, and API definition', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.chat).toEqual(mockChat);
      });

      expect(result.current.messages).toEqual([mockUserMessage, mockAssistantMessage]);
      expect(storage.getChat).toHaveBeenCalledWith('chat_123');
      expect(storage.getProject).toHaveBeenCalledWith('proj_123');
      expect(storage.getMessages).toHaveBeenCalledWith('chat_123');
      expect(storage.getAPIDefinition).toHaveBeenCalledWith('api_123');
    });

    it('should call onMessagesLoaded callback', async () => {
      renderHook(() => useChat({ chatId: 'chat_123', callbacks: mockCallbacks }));

      await waitFor(() => {
        expect(mockCallbacks.onMessagesLoaded).toHaveBeenCalledWith('chat_123', [
          mockUserMessage,
          mockAssistantMessage,
        ]);
      });
    });

    it('should use chat-level API definition override', async () => {
      const chatWithOverride = {
        ...mockChat,
        apiDefinitionId: 'api_override',
      };
      vi.mocked(storage.getChat).mockResolvedValue(chatWithOverride);

      renderHook(() => useChat({ chatId: 'chat_123', callbacks: mockCallbacks }));

      await waitFor(() => {
        expect(storage.getAPIDefinition).toHaveBeenCalledWith('api_override');
      });
    });

    it('should calculate token usage from chat totals', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.tokenUsage).toEqual({
          input: 100,
          output: 50,
          cost: 0.001,
        });
      });
    });
  });

  describe('Chat Migration', () => {
    it('should migrate old chats to new token tracking', async () => {
      const oldChat: Chat = {
        ...mockChat,
        totalCost: undefined,
        sinkInputTokens: 50,
        sinkOutputTokens: 25,
        sinkCost: 0.0005,
      };
      vi.mocked(storage.getChat).mockResolvedValue(oldChat);

      renderHook(() => useChat({ chatId: 'chat_123', callbacks: mockCallbacks }));

      await waitFor(() => {
        expect(storage.saveChat).toHaveBeenCalledWith(
          expect.objectContaining({
            totalInputTokens: expect.any(Number),
            totalOutputTokens: expect.any(Number),
            totalCost: expect.any(Number),
            sinkInputTokens: undefined,
            sinkOutputTokens: undefined,
            sinkCost: undefined,
          })
        );
      });
    });

    it('should migrate message contextWindowUsage', async () => {
      const oldChat = { ...mockChat, contextWindowUsageMigrated: false };
      const messageWithoutCWU = {
        ...mockAssistantMessage,
        metadata: {
          ...mockAssistantMessage.metadata!,
          contextWindowUsage: undefined,
        },
      };

      vi.mocked(storage.getChat).mockResolvedValue(oldChat);
      vi.mocked(storage.getMessages).mockResolvedValue([messageWithoutCWU]);

      renderHook(() => useChat({ chatId: 'chat_123', callbacks: mockCallbacks }));

      await waitFor(() => {
        expect(storage.saveMessage).toHaveBeenCalled();
        expect(storage.saveChat).toHaveBeenCalledWith(
          expect.objectContaining({
            contextWindowUsageMigrated: true,
          })
        );
      });
    });
  });

  describe('Pending State Resolution', () => {
    it('should resolve userMessage pending state and send to API', async () => {
      const chatWithPending: Chat = {
        ...mockChat,
        pendingState: {
          type: 'userMessage',
          content: { message: 'Test message' },
        },
      };

      vi.mocked(storage.getChat).mockResolvedValue(chatWithPending);

      // Mock API stream
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { type: 'content' as const, content: 'Response' };
          return {
            textContent: 'Response',
            fullContent: {},
            inputTokens: 10,
            outputTokens: 5,
          };
        },
      };
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as any);

      renderHook(() => useChat({ chatId: 'chat_123', callbacks: mockCallbacks }));

      await waitFor(() => {
        expect(storage.saveChat).toHaveBeenCalledWith(
          expect.objectContaining({
            pendingState: undefined,
          })
        );
      });

      await waitFor(() => {
        expect(apiService.sendMessageStream).toHaveBeenCalled();
      });
    });

    it('should resolve forkMessage pending state without sending', async () => {
      const chatWithForkPending: Chat = {
        ...mockChat,
        pendingState: {
          type: 'forkMessage',
          content: { message: 'Forked message' },
        },
      };

      vi.mocked(storage.getChat).mockResolvedValue(chatWithForkPending);

      renderHook(() => useChat({ chatId: 'chat_123', callbacks: mockCallbacks }));

      await waitFor(() => {
        expect(storage.saveChat).toHaveBeenCalledWith(
          expect.objectContaining({
            pendingState: undefined,
          })
        );
      });

      await waitFor(() => {
        expect(mockCallbacks.onForkMessageLoaded).toHaveBeenCalledWith(
          'chat_123',
          'Forked message'
        );
      });

      expect(apiService.sendMessageStream).not.toHaveBeenCalled();
    });
  });

  describe('sendMessage', () => {
    it('should send message and handle streaming response', async () => {
      // Create a proper async generator function and call it to get the generator
      const mockStreamGenerator = async function* () {
        yield { type: 'content' as const, content: 'Hello ' };
        yield { type: 'content' as const, content: 'world' };
        return {
          textContent: 'Hello world',
          fullContent: {},
          inputTokens: 10,
          outputTokens: 5,
        };
      };
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStreamGenerator());

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.chat).toBeTruthy();
      });

      await result.current.sendMessage('chat_123', 'Test message');

      await waitFor(() => {
        expect(mockCallbacks.onStreamingStart).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(mockCallbacks.onStreamingEnd).toHaveBeenCalled();
      });

      expect(storage.saveMessage).toHaveBeenCalledTimes(2); // user + assistant
    });

    it('should ignore mismatched chatId (race condition protection)', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.chat).toBeTruthy();
      });

      await result.current.sendMessage('chat_different', 'Test');

      expect(apiService.sendMessageStream).not.toHaveBeenCalled();
    });

    it('should handle API errors gracefully', async () => {
      // Create a proper async generator function that returns an error in the result
      const mockStreamGenerator = async function* () {
        // No error chunk yielded - error is returned in result
        return {
          textContent: '',
          fullContent: {},
          error: { message: 'API Error', status: 500 },
          inputTokens: 0,
          outputTokens: 0,
        };
      };
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStreamGenerator());

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.chat).toBeTruthy();
      });

      await result.current.sendMessage('chat_123', 'Test');

      await waitFor(() => {
        // Error is now communicated via renderingContent with ErrorRenderBlock
        expect(storage.saveMessage).toHaveBeenCalledWith(
          'chat_123',
          expect.objectContaining({
            content: expect.objectContaining({
              renderingContent: expect.arrayContaining([
                expect.objectContaining({
                  category: 'error',
                }),
              ]),
            }),
          })
        );
      });
    });

    it('should prepend metadata when enabled', async () => {
      const projectWithMetadata: Project = {
        ...mockProject,
        sendMessageMetadata: true,
        metadataTimestampMode: 'utc',
      };
      vi.mocked(storage.getProject).mockResolvedValue(projectWithMetadata);

      const mockStream = {
        async *[Symbol.asyncIterator]() {
          return {
            textContent: 'Response',
            fullContent: {},
            inputTokens: 10,
            outputTokens: 5,
          };
        },
      };
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStream as any);

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.chat).toBeTruthy();
      });

      await result.current.sendMessage('chat_123', 'Test');

      await waitFor(() => {
        expect(storage.saveMessage).toHaveBeenCalledWith(
          'chat_123',
          expect.objectContaining({
            content: expect.objectContaining({
              content: expect.stringContaining('<metadata>'),
            }),
          })
        );
      });
    });
  });

  describe('editMessage', () => {
    it('should delete message and all after it', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(2);
      });

      await result.current.editMessage('chat_123', 'msg_assistant_1', '');

      expect(storage.deleteMessageAndAfter).toHaveBeenCalledWith('chat_123', 'msg_assistant_1');
      expect(mockCallbacks.onMessagesRemovedOnAndAfter).toHaveBeenCalled();
    });

    it('should recalculate context window usage', async () => {
      const messages = [
        mockUserMessage,
        {
          ...mockAssistantMessage,
          id: 'msg_assistant_1',
          metadata: { ...mockAssistantMessage.metadata!, contextWindowUsage: 100 },
        },
        {
          ...mockAssistantMessage,
          id: 'msg_assistant_2',
          metadata: { ...mockAssistantMessage.metadata!, contextWindowUsage: 150 },
        },
      ];
      vi.mocked(storage.getMessages).mockResolvedValue(messages);

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(3);
      });

      // Edit last message - should use previous assistant message's CWU
      await result.current.editMessage('chat_123', 'msg_assistant_2', '');

      await waitFor(() => {
        expect(storage.saveChat).toHaveBeenCalledWith(
          expect.objectContaining({
            contextWindowUsage: 100,
          })
        );
      });
    });

    it('should ignore mismatched chatId', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.chat).toBeTruthy();
      });

      await result.current.editMessage('chat_different', 'msg_1', '');

      expect(storage.deleteMessageAndAfter).not.toHaveBeenCalled();
    });
  });

  describe('copyMessage', () => {
    it('should copy message content to clipboard', async () => {
      const mockWriteText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText: mockWriteText },
      });

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(2);
      });

      await result.current.copyMessage('chat_123', 'msg_user_1');

      expect(mockWriteText).toHaveBeenCalledWith('Hello');
      expect(alerts.showAlert).toHaveBeenCalledWith('Copied', 'Message copied to clipboard');
    });

    it('should strip metadata from copied content', async () => {
      const messageWithMetadata: Message<string> = {
        ...mockUserMessage,
        content: {
          type: 'text',
          content: '<metadata><timestamp>2024</timestamp></metadata>\n\nActual message',
        },
      };
      vi.mocked(storage.getMessages).mockResolvedValue([messageWithMetadata]);

      const mockWriteText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText: mockWriteText },
      });

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(1);
      });

      await result.current.copyMessage('chat_123', messageWithMetadata.id);

      expect(mockWriteText).toHaveBeenCalledWith('Actual message');
    });

    it('should handle copy errors', async () => {
      Object.assign(navigator, {
        clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Failed')) },
      });

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(2);
      });

      await result.current.copyMessage('chat_123', 'msg_user_1');

      expect(alerts.showAlert).toHaveBeenCalledWith('Error', 'Failed to copy message');
    });
  });

  describe('forkChat', () => {
    it('should create forked chat with message history', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.chat).toBeTruthy();
      });

      const forkedChat = await result.current.forkChat('chat_123', 'msg_user_1');

      expect(storage.cloneChat).toHaveBeenCalledWith('chat_123', 'proj_123', 'msg_user_1', 'Hello');
      expect(forkedChat?.id).toBe('chat_forked');
    });

    it('should ignore mismatched chatId', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.chat).toBeTruthy();
      });

      const forkedChat = await result.current.forkChat('chat_different', 'msg_1');

      expect(forkedChat).toBeNull();
      expect(storage.cloneChat).not.toHaveBeenCalled();
    });
  });

  describe('overrideModel', () => {
    it('should update chat with new API definition and model', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.chat).toBeTruthy();
      });

      await result.current.overrideModel('chat_123', 'api_new', 'gpt-3.5');

      expect(storage.saveChat).toHaveBeenCalledWith(
        expect.objectContaining({
          apiDefinitionId: 'api_new',
          modelId: 'gpt-3.5',
        })
      );
      expect(mockCallbacks.onChatMetadataChanged).toHaveBeenCalled();
    });

    it('should ignore mismatched chatId', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.chat).toBeTruthy();
      });

      const saveCallsBefore = vi.mocked(storage.saveChat).mock.calls.length;
      await result.current.overrideModel('chat_different', 'api_new', 'gpt-3.5');

      // Should not save (beyond initial loads)
      expect(vi.mocked(storage.saveChat).mock.calls.length).toBe(saveCallsBefore);
    });
  });

  describe('updateChatName', () => {
    it('should update chat name', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.chat).toBeTruthy();
      });

      await result.current.updateChatName('chat_123', 'New Name');

      expect(storage.saveChat).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Name',
        })
      );
      expect(mockCallbacks.onChatMetadataChanged).toHaveBeenCalled();
    });

    it('should ignore mismatched chatId', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.chat).toBeTruthy();
      });

      const saveCallsBefore = vi.mocked(storage.saveChat).mock.calls.length;
      await result.current.updateChatName('chat_different', 'New Name');

      expect(vi.mocked(storage.saveChat).mock.calls.length).toBe(saveCallsBefore);
    });

    it('should ignore empty names', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.chat).toBeTruthy();
      });

      const saveCallsBefore = vi.mocked(storage.saveChat).mock.calls.length;
      await result.current.updateChatName('chat_123', '   ');

      expect(vi.mocked(storage.saveChat).mock.calls.length).toBe(saveCallsBefore);
    });
  });

  describe('resolvePendingToolCalls', () => {
    const mockAssistantWithToolUse: Message<unknown> = {
      id: 'msg_assistant_tooluse',
      role: 'assistant',
      content: {
        type: 'text',
        content: '',
        modelFamily: 'anthropic',
        fullContent: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'ping',
            input: {},
          },
        ],
        renderingContent: [
          {
            category: 'backstage',
            blocks: [{ type: 'tool_use', id: 'tool_1', name: 'ping', input: {} }],
          },
        ],
      },
      timestamp: new Date('2024-01-01'),
    };

    beforeEach(() => {
      // Setup: return messages with unresolved tool use
      vi.mocked(storage.getMessages).mockResolvedValue([mockUserMessage, mockAssistantWithToolUse]);
      // Mock extractToolUseBlocks to return the tool_use block from fullContent
      vi.mocked(apiService.extractToolUseBlocks).mockReturnValue([
        { type: 'tool_use', id: 'tool_1', name: 'ping', input: {} },
      ]);
      // Mock buildToolResultMessage to return API-specific formatted message
      vi.mocked(apiService.buildToolResultMessage).mockImplementation((apiType, toolResults) => ({
        id: 'msg_tool_result',
        role: 'user',
        content: {
          type: 'text',
          content: '',
          modelFamily: apiType,
          fullContent: toolResults,
        },
        timestamp: new Date(),
      }));
    });

    it('should detect unresolved tool calls', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.unresolvedToolCalls).not.toBeNull();
        expect(result.current.unresolvedToolCalls).toHaveLength(1);
        expect(result.current.unresolvedToolCalls![0].name).toBe('ping');
      });
    });

    it('stop mode + empty message: saves tool results and sends error to API', async () => {
      // Mock stream for stop mode API call
      const mockStreamGenerator = async function* () {
        yield { type: 'content' as const, content: 'Understood' };
        return {
          textContent: 'Understood',
          fullContent: {},
          inputTokens: 10,
          outputTokens: 5,
        };
      };
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStreamGenerator());

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.unresolvedToolCalls).not.toBeNull();
      });

      await result.current.resolvePendingToolCalls('stop');

      // Should save tool result message with error
      await waitFor(() => {
        expect(storage.saveMessage).toHaveBeenCalledWith(
          'chat_123',
          expect.objectContaining({
            role: 'user',
            content: expect.objectContaining({
              fullContent: expect.arrayContaining([
                expect.objectContaining({
                  type: 'tool_result',
                  is_error: true,
                  content: expect.stringContaining('Token limit reached'),
                }),
              ]),
            }),
          })
        );
      });

      // Stop mode now correctly sends error to API (Bug #2 fix)
      await waitFor(() => {
        expect(apiService.sendMessageStream).toHaveBeenCalled();
      });
    });

    it('continue mode + empty message: saves tool results, calls API', async () => {
      // Mock stream for continuation
      const mockStreamGenerator = async function* () {
        yield { type: 'content' as const, content: 'Response' };
        return {
          textContent: 'Response',
          fullContent: {},
          inputTokens: 10,
          outputTokens: 5,
        };
      };
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStreamGenerator());

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.unresolvedToolCalls).not.toBeNull();
      });

      await result.current.resolvePendingToolCalls('continue');

      // Should save tool result message (with executed result, not error)
      await waitFor(() => {
        expect(storage.saveMessage).toHaveBeenCalledWith(
          'chat_123',
          expect.objectContaining({
            role: 'user',
            content: expect.objectContaining({
              fullContent: expect.arrayContaining([
                expect.objectContaining({
                  type: 'tool_result',
                  // ping tool returns pong, not an error
                }),
              ]),
            }),
          })
        );
      });

      // Should call API for continuation
      await waitFor(() => {
        expect(apiService.sendMessageStream).toHaveBeenCalled();
      });
    });

    it('stop mode + user message: saves tool results, calls sendMessageToAPI', async () => {
      const mockStreamGenerator = async function* () {
        yield { type: 'content' as const, content: 'Response' };
        return {
          textContent: 'Response',
          fullContent: {},
          inputTokens: 10,
          outputTokens: 5,
        };
      };
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStreamGenerator());

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.unresolvedToolCalls).not.toBeNull();
      });

      await result.current.resolvePendingToolCalls('stop', 'User follow-up message');

      // Should save tool result message with error
      await waitFor(() => {
        expect(storage.saveMessage).toHaveBeenCalledWith(
          'chat_123',
          expect.objectContaining({
            role: 'user',
            content: expect.objectContaining({
              fullContent: expect.arrayContaining([
                expect.objectContaining({
                  type: 'tool_result',
                  is_error: true,
                }),
              ]),
            }),
          })
        );
      });

      // Should call API with user message
      await waitFor(() => {
        expect(apiService.sendMessageStream).toHaveBeenCalled();
      });

      // Verify the API was called with a user message containing the follow-up
      const streamCalls = vi.mocked(apiService.sendMessageStream).mock.calls;
      const lastCall = streamCalls[streamCalls.length - 1];
      const messagesArg = lastCall[0];
      const userFollowUp = messagesArg.find(
        (m: Message<unknown>) => m.role === 'user' && m.content.content === 'User follow-up message'
      );
      expect(userFollowUp).toBeDefined();
    });

    it('continue mode + user message: saves tool results, calls sendMessageToAPI', async () => {
      const mockStreamGenerator = async function* () {
        yield { type: 'content' as const, content: 'Response' };
        return {
          textContent: 'Response',
          fullContent: {},
          inputTokens: 10,
          outputTokens: 5,
        };
      };
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStreamGenerator());

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.unresolvedToolCalls).not.toBeNull();
      });

      await result.current.resolvePendingToolCalls('continue', 'User follow-up message');

      // Should save tool result message (executed, not error)
      await waitFor(() => {
        expect(storage.saveMessage).toHaveBeenCalledWith(
          'chat_123',
          expect.objectContaining({
            role: 'user',
            content: expect.objectContaining({
              fullContent: expect.arrayContaining([
                expect.objectContaining({
                  type: 'tool_result',
                }),
              ]),
            }),
          })
        );
      });

      // Should call API with user message
      await waitFor(() => {
        expect(apiService.sendMessageStream).toHaveBeenCalled();
      });

      // Verify the API was called with a user message containing the follow-up
      const streamCalls = vi.mocked(apiService.sendMessageStream).mock.calls;
      const lastCall = streamCalls[streamCalls.length - 1];
      const messagesArg = lastCall[0];
      const userFollowUp = messagesArg.find(
        (m: Message<unknown>) => m.role === 'user' && m.content.content === 'User follow-up message'
      );
      expect(userFollowUp).toBeDefined();
    });

    it('should not detect unresolved tools when tool_result exists', async () => {
      // Add a tool result message after the assistant tool use
      const toolResultMessage: Message<unknown> = {
        id: 'msg_toolresult',
        role: 'user',
        content: {
          type: 'text',
          content: '',
          fullContent: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: 'pong',
            },
          ],
          renderingContent: [
            {
              category: 'backstage',
              blocks: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'pong' }],
            },
          ],
        },
        timestamp: new Date('2024-01-01'),
      };

      vi.mocked(storage.getMessages).mockResolvedValue([
        mockUserMessage,
        mockAssistantWithToolUse,
        toolResultMessage,
      ]);

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(3);
      });

      // Should NOT detect unresolved tool calls
      expect(result.current.unresolvedToolCalls).toBeNull();
    });
  });

  describe('Effect cleanup and re-execution', () => {
    it('should reload when chatId changes', async () => {
      const { result, rerender } = renderHook(
        ({ chatId }) => useChat({ chatId, callbacks: mockCallbacks }),
        { initialProps: { chatId: 'chat_123' } }
      );

      await waitFor(() => {
        expect(result.current.chat?.id).toBe('chat_123');
      });

      // Change chatId
      const newChat = { ...mockChat, id: 'chat_456', name: 'New Chat' };
      vi.mocked(storage.getChat).mockResolvedValue(newChat);

      rerender({ chatId: 'chat_456' });

      await waitFor(() => {
        expect(storage.getChat).toHaveBeenCalledWith('chat_456');
      });

      await waitFor(() => {
        expect(result.current.chat?.id).toBe('chat_456');
      });
    });
  });

  describe('Model Information', () => {
    it('should provide current and parent API/model IDs', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.currentApiDefId).toBe('api_123');
        expect(result.current.currentModelId).toBe('gpt-4');
        expect(result.current.parentApiDefId).toBe('api_123');
        expect(result.current.parentModelId).toBe('gpt-4');
      });
    });

    it('should use chat overrides for current, project for parent', async () => {
      const chatWithOverride: Chat = {
        ...mockChat,
        apiDefinitionId: 'api_override',
        modelId: 'claude-3',
      };
      vi.mocked(storage.getChat).mockResolvedValue(chatWithOverride);

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.currentApiDefId).toBe('api_override');
        expect(result.current.currentModelId).toBe('claude-3');
        expect(result.current.parentApiDefId).toBe('api_123');
        expect(result.current.parentModelId).toBe('gpt-4');
      });
    });
  });

  describe('Missing Attachment Handling', () => {
    it('should prepend system note when attachments are missing', async () => {
      // Setup user message with attachmentIds but no actual attachments returned
      const messageWithAttachments: Message<string> = {
        ...mockUserMessage,
        content: {
          type: 'text',
          content: 'Check this image',
          attachmentIds: ['att_1', 'att_2', 'att_3'], // 3 attachments expected
        },
      };

      vi.mocked(storage.getMessages).mockResolvedValue([messageWithAttachments]);

      // Only return 1 attachment (2 missing)
      vi.mocked(storage.getAttachments).mockResolvedValue([
        { id: 'att_1', type: 'image', mimeType: 'image/jpeg', data: 'base64data' },
      ]);

      // Create stream generator
      const mockStreamGenerator = async function* () {
        yield { type: 'content' as const, content: 'Response' };
        return {
          textContent: 'Response',
          fullContent: {},
          inputTokens: 10,
          outputTokens: 5,
        };
      };
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStreamGenerator());

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.chat).toBeTruthy();
      });

      // Send new message to trigger API call
      await result.current.sendMessage('chat_123', 'New message');

      await waitFor(() => {
        expect(apiService.sendMessageStream).toHaveBeenCalled();
      });

      // Check that the message sent to API has the system note prepended
      const streamCall = vi.mocked(apiService.sendMessageStream).mock.calls[0];
      const messagesArg = streamCall[0];

      // Find the history message (not the new user message)
      const historyMessage = messagesArg.find(
        (m: Message<unknown>) => m.role === 'user' && m.content.content.includes('system-note')
      );

      expect(historyMessage).toBeDefined();
      expect(historyMessage?.content.content).toContain(
        '<system-note>2 attachment(s) removed to save space.</system-note>'
      );
      // Original content should still be there
      expect(historyMessage?.content.content).toContain('Check this image');
      // Only the found attachment ID should remain
      expect(historyMessage?.content.attachmentIds).toEqual(['att_1']);
    });

    it('should not modify messages when all attachments are present', async () => {
      // Setup user message with attachmentIds
      const messageWithAttachments: Message<string> = {
        ...mockUserMessage,
        content: {
          type: 'text',
          content: 'Check this image',
          attachmentIds: ['att_1', 'att_2'],
        },
      };

      vi.mocked(storage.getMessages).mockResolvedValue([messageWithAttachments]);

      // Return all attachments
      vi.mocked(storage.getAttachments).mockResolvedValue([
        { id: 'att_1', type: 'image', mimeType: 'image/jpeg', data: 'base64data1' },
        { id: 'att_2', type: 'image', mimeType: 'image/png', data: 'base64data2' },
      ]);

      const mockStreamGenerator = async function* () {
        yield { type: 'content' as const, content: 'Response' };
        return {
          textContent: 'Response',
          fullContent: {},
          inputTokens: 10,
          outputTokens: 5,
        };
      };
      vi.mocked(apiService.sendMessageStream).mockReturnValue(mockStreamGenerator());

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.chat).toBeTruthy();
      });

      await result.current.sendMessage('chat_123', 'New message');

      await waitFor(() => {
        expect(apiService.sendMessageStream).toHaveBeenCalled();
      });

      // Check that no system note was added
      const streamCall = vi.mocked(apiService.sendMessageStream).mock.calls[0];
      const messagesArg = streamCall[0];

      const historyMessage = messagesArg.find(
        (m: Message<unknown>) => m.role === 'user' && m.content.content === 'Check this image'
      );

      expect(historyMessage).toBeDefined();
      expect(historyMessage?.content.content).not.toContain('system-note');
      expect(historyMessage?.content.attachmentIds).toEqual(['att_1', 'att_2']);
    });
  });
});
