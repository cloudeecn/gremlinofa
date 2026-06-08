import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useChat } from '../useChat';
import { generateUniqueId } from '../../../shared/protocol/idGenerator';
import * as alerts from '../../lib/alerts';
import type {
  Chat,
  Project,
  Message,
  APIDefinition,
  ToolUseBlock,
} from '../../../shared/protocol/types';
import type { LoopEvent } from '../../../shared/protocol/protocol';

// ============================================================================
// Mock GremlinClient + GremlinSession at the boundary
//
// The previous incarnation of these tests mocked `services/storage` and
// `services/api/apiService` at module level and relied on the in-process
// GremlinServer to dispatch hook calls into those mocked singletons. With
// the singletons gone, the test surface is the GremlinClient RPC contract
// plus the push-based GremlinSession event stream — both of which we now
// stub directly. Tests assert on the stub method calls and drive event
// state by invoking handlers registered via `session.onEvent(...)`.
// ============================================================================

interface StubSession {
  attach: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
  softStop: ReturnType<typeof vi.fn>;
  continueLoop: ReturnType<typeof vi.fn>;
  resolveContinue: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  onEnd: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  /** Captured chatId from the constructor */
  chatId: string;
  /** Drive an event into the registered onEvent handler */
  fireEvent(event: LoopEvent): void;
}

let activeSession: StubSession | null = null;
const sessionConstructorCalls: Array<{ chatId: string }> = [];

vi.mock('../../client', () => {
  class MockGremlinSession implements StubSession {
    chatId: string;
    private eventHandlers: Array<(event: LoopEvent) => void> = [];

    attach = vi.fn().mockResolvedValue(undefined);
    dispose = vi.fn();
    send = vi.fn().mockResolvedValue(undefined);
    retry = vi.fn().mockResolvedValue(undefined);
    softStop = vi.fn().mockResolvedValue(undefined);
    continueLoop = vi.fn().mockResolvedValue(undefined);
    resolveContinue = vi.fn().mockResolvedValue(undefined);
    onEnd = vi.fn();
    onError = vi.fn();
    setKnownMessageIdsProvider = vi.fn();

    constructor(_client: unknown, chatId: string) {
      this.chatId = chatId;
      sessionConstructorCalls.push({ chatId });
      activeSession = this;
    }

    onEvent = vi.fn((handler: (event: LoopEvent) => void) => {
      this.eventHandlers.push(handler);
    });

    fireEvent(event: LoopEvent) {
      for (const handler of this.eventHandlers) {
        handler(event);
      }
    }
  }

  return {
    gremlinClient: {
      getChat: vi.fn(),
      getProject: vi.fn(),
      getAPIDefinition: vi.fn(),
      saveChat: vi.fn(),
      patchChat: vi.fn(),
      saveMessage: vi.fn(),
      deleteMessageAndAfter: vi.fn(),
      cloneChat: vi.fn(),
    },
    GremlinSession: MockGremlinSession,
  };
});

vi.mock('../../../shared/protocol/idGenerator');
vi.mock('../../lib/alerts');

import { gremlinClient } from '../../client';

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

  /** Drive the standard "snapshot" sequence so the hook lands in the loaded state. */
  function emitInitialSnapshot(
    messages: Message<unknown>[] = [mockUserMessage, mockAssistantMessage]
  ) {
    if (!activeSession) throw new Error('no active session');
    activeSession.fireEvent({ type: 'chat_updated', chat: mockChat });
    for (const msg of messages) {
      activeSession.fireEvent({ type: 'message_created', message: msg });
    }
    activeSession.fireEvent({ type: 'snapshot_complete' });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    activeSession = null;
    sessionConstructorCalls.length = 0;

    // Default mock implementations for the auxiliary RPC loads useChat
    // fires alongside the attachChat session.
    vi.mocked(gremlinClient.getChat).mockResolvedValue(mockChat);
    vi.mocked(gremlinClient.getProject).mockResolvedValue(mockProject);
    vi.mocked(gremlinClient.getAPIDefinition).mockResolvedValue(mockApiDefinition);
    vi.mocked(gremlinClient.saveChat).mockResolvedValue(undefined);
    vi.mocked(gremlinClient.saveMessage).mockResolvedValue(undefined);
    vi.mocked(gremlinClient.deleteMessageAndAfter).mockResolvedValue(undefined);
    vi.mocked(gremlinClient.cloneChat).mockResolvedValue({
      newChatId: 'chat_forked',
    });
    vi.mocked(generateUniqueId).mockReturnValue('msg_new_123');
    vi.mocked(alerts.showAlert).mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Initial Loading', () => {
    it('should construct a GremlinSession for the chatId and load auxiliary chat data', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.chat).toBeTruthy();
      });

      expect(sessionConstructorCalls).toEqual([{ chatId: 'chat_123' }]);
      expect(activeSession?.attach).toHaveBeenCalled();
      expect(gremlinClient.getChat).toHaveBeenCalledWith('chat_123');
      expect(gremlinClient.getProject).toHaveBeenCalledWith('proj_123');
      expect(gremlinClient.getAPIDefinition).toHaveBeenCalledWith('api_123');
    });

    it('should initialize loopPhase to idle on mount', () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );
      expect(result.current.loopPhase).toBe('idle');
    });

    it('should call onMessagesLoaded when the snapshot stream completes', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.chat).toBeTruthy();
      });

      act(() => {
        emitInitialSnapshot();
      });

      await waitFor(() => {
        expect(mockCallbacks.onMessagesLoaded).toHaveBeenCalledWith('chat_123', [
          mockUserMessage,
          mockAssistantMessage,
        ]);
      });
    });

    it('should use chat-level API definition override when present', async () => {
      const chatWithOverride = { ...mockChat, apiDefinitionId: 'api_override' };
      vi.mocked(gremlinClient.getChat).mockResolvedValue(chatWithOverride);

      renderHook(() => useChat({ chatId: 'chat_123', callbacks: mockCallbacks }));

      await waitFor(() => {
        expect(gremlinClient.getAPIDefinition).toHaveBeenCalledWith('api_override');
      });
    });

    it('should calculate token usage from chat totals', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => {
        expect(result.current.chat).toBeTruthy();
      });

      expect(result.current.tokenUsage).toEqual({
        input: 100,
        output: 50,
        cost: 0.001,
      });
    });
  });

  describe('Loop event handling', () => {
    it('transitions loopPhase to pending on loop_started, streaming on first_chunk, idle on loop_ended', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      expect(result.current.loopPhase).toBe('idle');

      act(() => {
        activeSession!.fireEvent({ type: 'loop_started', loopId: 'loop_1' });
      });
      expect(result.current.loopPhase).toBe('pending');

      act(() => {
        activeSession!.fireEvent({ type: 'first_chunk' });
      });
      expect(result.current.loopPhase).toBe('streaming');

      act(() => {
        activeSession!.fireEvent({ type: 'loop_ended', loopId: 'loop_1', status: 'complete' });
      });
      expect(result.current.loopPhase).toBe('idle');
      expect(mockCallbacks.onStreamingEnd).toHaveBeenCalledWith('chat_123');
    });

    it('appends messages from message_created events', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      act(() => {
        activeSession!.fireEvent({ type: 'message_created', message: mockUserMessage });
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].id).toBe('msg_user_1');
      expect(mockCallbacks.onMessageAppended).toHaveBeenCalledWith('chat_123', mockUserMessage);
    });

    it('reflects chat metadata updates from chat_updated events', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      const updatedChat = { ...mockChat, totalCost: 0.5, totalInputTokens: 999 };
      act(() => {
        activeSession!.fireEvent({ type: 'chat_updated', chat: updatedChat });
      });

      expect(result.current.chat?.totalCost).toBe(0.5);
      expect(result.current.tokenUsage.cost).toBe(0.5);
      expect(mockCallbacks.onChatMetadataChanged).toHaveBeenCalled();
    });

    it('drops trailing messages on messages_truncated events', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      act(() => {
        emitInitialSnapshot();
      });

      expect(result.current.messages).toHaveLength(2);

      act(() => {
        activeSession!.fireEvent({ type: 'messages_truncated', afterMessageId: 'msg_user_1' });
      });

      // After truncation, only the anchor (msg_user_1) remains.
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].id).toBe('msg_user_1');
      expect(mockCallbacks.onMessagesRemovedOnAndAfter).toHaveBeenCalledWith(
        'chat_123',
        'msg_user_1'
      );
    });
  });

  describe('sendMessage', () => {
    it('delegates to GremlinSession.send and transitions loopPhase to pending', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      await act(async () => {
        await result.current.sendMessage('chat_123', 'Test message');
      });

      expect(activeSession?.send).toHaveBeenCalledWith('Test message', undefined);
      expect(result.current.loopPhase).toBe('pending');
    });

    it('ignores mismatched chatId (race condition protection)', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      await result.current.sendMessage('chat_different', 'Test');

      expect(activeSession?.send).not.toHaveBeenCalled();
    });

    it('refuses to send when the chat is locked by an incomplete tail', async () => {
      const incompleteAssistant: Message<unknown> = {
        ...mockAssistantMessage,
        id: 'msg_assistant_partial',
        incomplete: true,
      };

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      act(() => {
        emitInitialSnapshot([mockUserMessage, incompleteAssistant]);
        // Phase 1.7: backend pushes the lock state via lock_state_changed
        // immediately before snapshot_complete. Tests drive it explicitly.
        activeSession!.fireEvent({ type: 'lock_state_changed', locked: true });
      });

      await waitFor(() => expect(result.current.isLockedByIncompleteTail).toBe(true));

      await result.current.sendMessage('chat_123', 'Test');

      expect(activeSession?.send).not.toHaveBeenCalled();
      expect(alerts.showAlert).toHaveBeenCalledWith(
        'Chat Locked',
        expect.stringContaining('aborted')
      );
    });
  });

  describe('editMessage', () => {
    it('truncates messages and calls deleteMessageAndAfter', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      act(() => {
        emitInitialSnapshot();
      });

      await waitFor(() => expect(result.current.messages).toHaveLength(2));

      await act(async () => {
        await result.current.editMessage('chat_123', 'msg_assistant_1', '');
      });

      expect(gremlinClient.deleteMessageAndAfter).toHaveBeenCalledWith(
        'chat_123',
        'msg_assistant_1'
      );
      expect(mockCallbacks.onMessagesRemovedOnAndAfter).toHaveBeenCalled();
      // Edited message + everything after dropped from local state.
      expect(result.current.messages.find(m => m.id === 'msg_assistant_1')).toBeUndefined();
    });

    it('recalculates context window usage from the previous assistant message', async () => {
      const messages: Message<unknown>[] = [
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

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      act(() => {
        emitInitialSnapshot(messages);
      });

      await waitFor(() => expect(result.current.messages).toHaveLength(3));

      // Edit the last assistant — should pick up CWU from msg_assistant_1
      await act(async () => {
        await result.current.editMessage('chat_123', 'msg_assistant_2', '');
      });

      expect(gremlinClient.patchChat).toHaveBeenCalledWith(
        'chat_123',
        expect.objectContaining({ contextWindowUsage: 100 }),
        expect.objectContaining({ touch: true })
      );
    });

    it('ignores mismatched chatId', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      await result.current.editMessage('chat_different', 'msg_1', '');

      expect(gremlinClient.deleteMessageAndAfter).not.toHaveBeenCalled();
    });
  });

  describe('resendFromMessage', () => {
    it('delegates to GremlinSession.retry', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      await act(async () => {
        await result.current.resendFromMessage('msg_user_1');
      });

      expect(activeSession?.retry).toHaveBeenCalledWith('msg_user_1');
      expect(result.current.loopPhase).toBe('pending');
    });
  });

  describe('rollbackToMessage', () => {
    it('keeps target message and deletes everything after', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());
      act(() => emitInitialSnapshot());
      await waitFor(() => expect(result.current.messages).toHaveLength(2));

      await act(async () => {
        await result.current.rollbackToMessage('chat_123', 'msg_user_1');
      });

      // Target message kept, assistant message deleted
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].id).toBe('msg_user_1');
      expect(gremlinClient.deleteMessageAndAfter).toHaveBeenCalledWith(
        'chat_123',
        'msg_assistant_1'
      );
      expect(mockCallbacks.onMessagesRemovedOnAndAfter).toHaveBeenCalledWith(
        'chat_123',
        'msg_assistant_1'
      );
    });

    it('is a no-op when target is the last message', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());
      act(() => emitInitialSnapshot());
      await waitFor(() => expect(result.current.messages).toHaveLength(2));

      await act(async () => {
        await result.current.rollbackToMessage('chat_123', 'msg_assistant_1');
      });

      expect(result.current.messages).toHaveLength(2);
      expect(gremlinClient.deleteMessageAndAfter).not.toHaveBeenCalled();
    });

    it('ignores mismatched chatId', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      await result.current.rollbackToMessage('chat_different', 'msg_user_1');

      expect(gremlinClient.deleteMessageAndAfter).not.toHaveBeenCalled();
    });
  });

  describe('copyMessage', () => {
    it('copies message content to clipboard', async () => {
      const mockWriteText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText: mockWriteText } });

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());
      act(() => emitInitialSnapshot());

      await result.current.copyMessage('chat_123', 'msg_user_1');

      expect(mockWriteText).toHaveBeenCalledWith('Hello');
      expect(alerts.showAlert).toHaveBeenCalledWith('Copied', 'Message copied to clipboard');
    });

    it('strips metadata from copied content', async () => {
      const messageWithMetadata: Message<string> = {
        ...mockUserMessage,
        content: {
          type: 'text',
          content: '<metadata><timestamp>2024</timestamp></metadata>\n\nActual message',
        },
      };

      const mockWriteText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText: mockWriteText } });

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());
      act(() => emitInitialSnapshot([messageWithMetadata]));

      await result.current.copyMessage('chat_123', messageWithMetadata.id);

      expect(mockWriteText).toHaveBeenCalledWith('Actual message');
    });

    it('handles copy errors', async () => {
      Object.assign(navigator, {
        clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Failed')) },
      });

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());
      act(() => emitInitialSnapshot());

      await result.current.copyMessage('chat_123', 'msg_user_1');

      expect(alerts.showAlert).toHaveBeenCalledWith('Error', 'Failed to copy message');
    });
  });

  describe('forkChat', () => {
    it('calls cloneChat and returns the new chat id', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());
      act(() => emitInitialSnapshot());

      const forkedChat = await result.current.forkChat('chat_123', 'msg_user_1');

      expect(gremlinClient.cloneChat).toHaveBeenCalledWith('chat_123', 'msg_user_1', 'Hello');
      expect(forkedChat?.id).toBe('chat_forked');
    });

    it('ignores mismatched chatId', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      const forkedChat = await result.current.forkChat('chat_different', 'msg_1');

      expect(forkedChat).toBeNull();
      expect(gremlinClient.cloneChat).not.toHaveBeenCalled();
    });
  });

  describe('overrideModel', () => {
    it('updates chat with new API definition and model', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      await result.current.overrideModel('chat_123', 'api_new', 'gpt-3.5');

      expect(gremlinClient.patchChat).toHaveBeenCalledWith(
        'chat_123',
        expect.objectContaining({ apiDefinitionId: 'api_new', modelId: 'gpt-3.5' }),
        expect.objectContaining({ touch: true })
      );
      expect(mockCallbacks.onChatMetadataChanged).toHaveBeenCalled();
    });

    it('ignores mismatched chatId', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      const callsBefore = vi.mocked(gremlinClient.patchChat).mock.calls.length;
      await result.current.overrideModel('chat_different', 'api_new', 'gpt-3.5');
      expect(vi.mocked(gremlinClient.patchChat).mock.calls.length).toBe(callsBefore);
    });
  });

  describe('updateChatName', () => {
    it('updates chat name', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      await result.current.updateChatName('chat_123', 'New Name');

      expect(gremlinClient.patchChat).toHaveBeenCalledWith(
        'chat_123',
        expect.objectContaining({ name: 'New Name' }),
        expect.objectContaining({ touch: true })
      );
      expect(mockCallbacks.onChatMetadataChanged).toHaveBeenCalled();
    });

    it('ignores mismatched chatId', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      const callsBefore = vi.mocked(gremlinClient.patchChat).mock.calls.length;
      await result.current.updateChatName('chat_different', 'New Name');
      expect(vi.mocked(gremlinClient.patchChat).mock.calls.length).toBe(callsBefore);
    });

    it('ignores empty names', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      const callsBefore = vi.mocked(gremlinClient.patchChat).mock.calls.length;
      await result.current.updateChatName('chat_123', '   ');
      expect(vi.mocked(gremlinClient.patchChat).mock.calls.length).toBe(callsBefore);
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
        fullContent: [{ type: 'tool_use', id: 'tool_1', name: 'ping', input: {} }],
        // Phase 1.8 leak fix: backend pre-extracts `toolUseBlocks` at every
        // wire boundary. The frontend reads this field directly instead of
        // re-running the provider parser; tests must populate it the same
        // way `prepareMessageForWire` would.
        toolUseBlocks: [{ type: 'tool_use', id: 'tool_1', name: 'ping', input: {} }],
        renderingContent: [
          {
            category: 'backstage',
            blocks: [{ type: 'tool_use', id: 'tool_1', name: 'ping', input: {} }],
          },
        ],
      },
      timestamp: new Date('2024-01-01'),
    };

    it('detects unresolved tool calls from the chat tail', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      act(() => emitInitialSnapshot([mockUserMessage, mockAssistantWithToolUse]));

      await waitFor(() => {
        expect(result.current.unresolvedToolCalls).not.toBeNull();
        expect(result.current.unresolvedToolCalls).toHaveLength(1);
        expect(result.current.unresolvedToolCalls![0].name).toBe('ping');
      });
    });

    it('continue mode delegates to GremlinSession.resolveContinue', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());
      act(() => emitInitialSnapshot([mockUserMessage, mockAssistantWithToolUse]));

      await waitFor(() => expect(result.current.unresolvedToolCalls).not.toBeNull());

      await act(async () => {
        await result.current.resolvePendingToolCalls('continue', 'follow up');
      });

      expect(activeSession?.resolveContinue).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'tool_1', name: 'ping' } as Partial<ToolUseBlock>),
        ]),
        'follow up',
        undefined
      );
    });

    it('stop mode saves a synthetic tool_result message and continues the loop', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());
      act(() => emitInitialSnapshot([mockUserMessage, mockAssistantWithToolUse]));

      await waitFor(() => expect(result.current.unresolvedToolCalls).not.toBeNull());

      await act(async () => {
        await result.current.resolvePendingToolCalls('stop');
      });

      // The hook saves a synthetic user message carrying the tool_result
      // rejection blocks, then asks the session to continue.
      expect(gremlinClient.saveMessage).toHaveBeenCalledWith(
        'chat_123',
        expect.objectContaining({
          role: 'user',
          content: expect.objectContaining({
            toolResults: expect.arrayContaining([
              expect.objectContaining({
                type: 'tool_result',
                is_error: true,
                content: expect.stringContaining('User rejected the tool call'),
              }),
            ]),
          }),
        })
      );
      expect(activeSession?.continueLoop).toHaveBeenCalled();
    });

    it('stop mode + user message: saves both the rejection and the follow-up', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());
      act(() => emitInitialSnapshot([mockUserMessage, mockAssistantWithToolUse]));

      await waitFor(() => expect(result.current.unresolvedToolCalls).not.toBeNull());

      await act(async () => {
        await result.current.resolvePendingToolCalls('stop', 'User follow-up message');
      });

      // Two saveMessage calls: rejection + follow-up.
      const saveCalls = vi.mocked(gremlinClient.saveMessage).mock.calls;
      const followUp = saveCalls.find(
        ([, msg]) =>
          (msg as Message<unknown>).role === 'user' &&
          (msg as Message<unknown>).content.content === 'User follow-up message'
      );
      expect(followUp).toBeDefined();
      expect(activeSession?.continueLoop).toHaveBeenCalled();
    });

    it('does not detect unresolved tools when a tool_result already exists', async () => {
      const toolResultMessage: Message<unknown> = {
        id: 'msg_toolresult',
        role: 'user',
        content: {
          type: 'text',
          content: '',
          fullContent: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'pong' }],
          renderingContent: [
            {
              category: 'backstage',
              blocks: [
                { type: 'tool_result', tool_use_id: 'tool_1', content: 'pong', name: 'test' },
              ],
            },
          ],
        },
        timestamp: new Date('2024-01-01'),
      };

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());
      act(() =>
        emitInitialSnapshot([mockUserMessage, mockAssistantWithToolUse, toolResultMessage])
      );

      await waitFor(() => expect(result.current.messages).toHaveLength(3));

      expect(result.current.unresolvedToolCalls).toBeNull();
    });
  });

  describe('Effect cleanup and re-execution', () => {
    it('disposes the old session and constructs a new one when chatId changes', async () => {
      const { result, rerender } = renderHook(
        ({ chatId }) => useChat({ chatId, callbacks: mockCallbacks }),
        { initialProps: { chatId: 'chat_123' } }
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());
      const firstSession = activeSession!;

      const newChat = { ...mockChat, id: 'chat_456', name: 'New Chat' };
      vi.mocked(gremlinClient.getChat).mockResolvedValue(newChat);

      rerender({ chatId: 'chat_456' });

      await waitFor(() => expect(activeSession).not.toBe(firstSession));

      expect(firstSession.dispose).toHaveBeenCalled();
      expect(sessionConstructorCalls).toEqual([{ chatId: 'chat_123' }, { chatId: 'chat_456' }]);
      expect(gremlinClient.getChat).toHaveBeenCalledWith('chat_456');
    });
  });

  describe('Model Information', () => {
    it('provides current and parent API/model IDs', async () => {
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

    it('uses chat overrides for current and project for parent', async () => {
      const chatWithOverride: Chat = {
        ...mockChat,
        apiDefinitionId: 'api_override',
        modelId: 'claude-3',
      };
      vi.mocked(gremlinClient.getChat).mockResolvedValue(chatWithOverride);

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

  // ==========================================================================
  // Reconnect reconciliation
  // ==========================================================================

  describe('Reconnect reconciliation', () => {
    function makeMsg(id: string, role: 'user' | 'assistant' = 'user'): Message<unknown> {
      return {
        id,
        role,
        content: { type: 'text', content: `content-${id}` },
        timestamp: new Date('2024-01-01'),
      };
    }

    it('skips duplicate messages when snapshot replays identical history', async () => {
      const msgs = [
        makeMsg('m1'),
        makeMsg('m2', 'assistant'),
        makeMsg('m3'),
        makeMsg('m4', 'assistant'),
      ];
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );
      await waitFor(() => expect(result.current.chat).toBeTruthy());

      act(() => emitInitialSnapshot(msgs));
      await waitFor(() => expect(result.current.messages).toHaveLength(4));

      // Simulate reconnect — replay the exact same messages
      act(() => {
        activeSession!.fireEvent({ type: 'reconnect_start' });
        activeSession!.fireEvent({ type: 'chat_updated', chat: mockChat });
        for (const msg of msgs) {
          activeSession!.fireEvent({ type: 'message_created', message: msg });
        }
        activeSession!.fireEvent({ type: 'snapshot_complete' });
      });

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(4);
        expect(result.current.messages.map(m => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
      });
    });

    it('removes messages deleted on server during disconnect', async () => {
      const msgs = [
        makeMsg('m1'),
        makeMsg('m2', 'assistant'),
        makeMsg('m3'),
        makeMsg('m4', 'assistant'),
      ];
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );
      await waitFor(() => expect(result.current.chat).toBeTruthy());

      act(() => emitInitialSnapshot(msgs));
      await waitFor(() => expect(result.current.messages).toHaveLength(4));

      // Reconnect with m3 + m4 deleted on server
      act(() => {
        activeSession!.fireEvent({ type: 'reconnect_start' });
        activeSession!.fireEvent({ type: 'chat_updated', chat: mockChat });
        activeSession!.fireEvent({ type: 'message_created', message: msgs[0] });
        activeSession!.fireEvent({ type: 'message_created', message: msgs[1] });
        activeSession!.fireEvent({ type: 'snapshot_complete' });
      });

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(2);
        expect(result.current.messages.map(m => m.id)).toEqual(['m1', 'm2']);
      });
    });

    it('appends new messages added on server during disconnect', async () => {
      const msgs = [makeMsg('m1'), makeMsg('m2', 'assistant')];
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );
      await waitFor(() => expect(result.current.chat).toBeTruthy());

      act(() => emitInitialSnapshot(msgs));
      await waitFor(() => expect(result.current.messages).toHaveLength(2));

      // Reconnect with new messages added after the existing ones
      const newMsg = makeMsg('m3');
      const newAssistant = makeMsg('m4', 'assistant');
      act(() => {
        activeSession!.fireEvent({ type: 'reconnect_start' });
        activeSession!.fireEvent({ type: 'chat_updated', chat: mockChat });
        for (const msg of [...msgs, newMsg, newAssistant]) {
          activeSession!.fireEvent({ type: 'message_created', message: msg });
        }
        activeSession!.fireEvent({ type: 'snapshot_complete' });
      });

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(4);
        expect(result.current.messages.map(m => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
      });
    });

    it('truncates and rebuilds when a middle message was deleted', async () => {
      const msgs = [
        makeMsg('m1'),
        makeMsg('m2', 'assistant'),
        makeMsg('m3'),
        makeMsg('m4', 'assistant'),
      ];
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );
      await waitFor(() => expect(result.current.chat).toBeTruthy());

      act(() => emitInitialSnapshot(msgs));
      await waitFor(() => expect(result.current.messages).toHaveLength(4));

      // Reconnect: m2 was deleted on server, so positions shift at index 1
      act(() => {
        activeSession!.fireEvent({ type: 'reconnect_start' });
        activeSession!.fireEvent({ type: 'chat_updated', chat: mockChat });
        activeSession!.fireEvent({ type: 'message_created', message: msgs[0] }); // m1 matches pos 0
        activeSession!.fireEvent({ type: 'message_created', message: msgs[2] }); // m3 at pos 1 — mismatch
        activeSession!.fireEvent({ type: 'message_created', message: msgs[3] }); // m4 appended
        activeSession!.fireEvent({ type: 'snapshot_complete' });
      });

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(3);
        expect(result.current.messages.map(m => m.id)).toEqual(['m1', 'm3', 'm4']);
      });
    });

    it('handles complete replacement when first message differs', async () => {
      const msgs = [makeMsg('m1'), makeMsg('m2', 'assistant')];
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );
      await waitFor(() => expect(result.current.chat).toBeTruthy());

      act(() => emitInitialSnapshot(msgs));
      await waitFor(() => expect(result.current.messages).toHaveLength(2));

      // Reconnect with entirely different messages
      const newMsgs = [makeMsg('x1'), makeMsg('x2', 'assistant'), makeMsg('x3')];
      act(() => {
        activeSession!.fireEvent({ type: 'reconnect_start' });
        activeSession!.fireEvent({ type: 'chat_updated', chat: mockChat });
        for (const msg of newMsgs) {
          activeSession!.fireEvent({ type: 'message_created', message: msg });
        }
        activeSession!.fireEvent({ type: 'snapshot_complete' });
      });

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(3);
        expect(result.current.messages.map(m => m.id)).toEqual(['x1', 'x2', 'x3']);
      });
    });

    it('strips unstable pending_tool_result messages and replaces with finalized version', async () => {
      const msgs = [makeMsg('m1'), makeMsg('m2', 'assistant')];
      const pendingToolMsg: Message<unknown> = {
        id: 'msg_pending_tool',
        role: 'user',
        content: {
          type: 'text',
          content: '',
          renderingContent: [
            {
              category: 'backstage',
              blocks: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu_1',
                  content: '',
                  name: 'minion',
                  status: 'running',
                },
              ],
            },
          ],
        },
        timestamp: new Date('2024-01-01'),
      };
      const finalizedToolMsg: Message<unknown> = {
        ...pendingToolMsg,
        content: {
          type: 'text',
          content: 'final result',
          renderingContent: [
            {
              category: 'backstage',
              blocks: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu_1',
                  content: 'final result',
                  name: 'minion',
                  status: 'complete',
                },
              ],
            },
          ],
        },
      };

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );
      await waitFor(() => expect(result.current.chat).toBeTruthy());

      // Initial snapshot + pending tool result
      act(() => {
        emitInitialSnapshot(msgs);
        activeSession!.fireEvent({ type: 'pending_tool_result', message: pendingToolMsg });
      });
      await waitFor(() => expect(result.current.messages).toHaveLength(3));
      expect(result.current.messages[2].id).toBe('msg_pending_tool');

      // Reconnect — server has finalized the tool result
      act(() => {
        activeSession!.fireEvent({ type: 'reconnect_start' });
        activeSession!.fireEvent({ type: 'chat_updated', chat: mockChat });
        activeSession!.fireEvent({ type: 'message_created', message: msgs[0] });
        activeSession!.fireEvent({ type: 'message_created', message: msgs[1] });
        activeSession!.fireEvent({ type: 'message_created', message: finalizedToolMsg });
        activeSession!.fireEvent({ type: 'snapshot_complete' });
      });

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(3);
        const toolMsg = result.current.messages[2];
        expect(toolMsg.id).toBe('msg_pending_tool');
        expect(toolMsg.content.content).toBe('final result');
      });
    });

    it('resets loopPhase to idle on reconnect_start', async () => {
      const msgs = [makeMsg('m1')];
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );
      await waitFor(() => expect(result.current.chat).toBeTruthy());

      act(() => emitInitialSnapshot(msgs));
      await waitFor(() => expect(result.current.snapshotLoading).toBe(false));

      // Start a loop to set loopPhase to pending
      act(() => {
        activeSession!.fireEvent({ type: 'loop_started', loopId: 'loop_1' });
      });
      expect(result.current.loopPhase).toBe('pending');

      // Reconnect resets loopPhase
      act(() => {
        activeSession!.fireEvent({ type: 'reconnect_start' });
      });
      expect(result.current.loopPhase).toBe('idle');
    });

    it('preserves in-flight pending_tool_result placeholder past snapshot_complete trim', async () => {
      // Repro for the streaming-vanishes-on-reconnect bug. Before the fix,
      // reconPosRef was never advanced when pending_tool_result added an
      // in-flight placeholder past the matched-prefix tail, so
      // snapshot_complete's slice(0, reconPosRef) trimmed the placeholder
      // away. The follow-up tool_block_update then had no target message to
      // attach renderingGroups to, and the minion's streaming progress was
      // invisible until the loop finished (or the user re-attached fresh).
      const msgs = [makeMsg('m1'), makeMsg('m2', 'assistant')];
      const pendingToolMsg: Message<unknown> = {
        id: 'msg_pending_tool',
        role: 'user',
        content: {
          type: 'text',
          content: '',
          renderingContent: [
            {
              category: 'backstage',
              blocks: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu_minion',
                  content: '',
                  name: 'minion',
                  status: 'running',
                },
              ],
            },
          ],
        },
        timestamp: new Date('2024-01-01'),
      };

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );
      await waitFor(() => expect(result.current.chat).toBeTruthy());

      act(() => emitInitialSnapshot(msgs));
      await waitFor(() => expect(result.current.messages).toHaveLength(2));

      // Disconnect mid-minion: reconnect snapshot replays the persisted
      // messages, the synthetic loop_started, then the pending placeholder
      // and its merged tool_block_update — same order GremlinServer.attachChat
      // emits in.
      act(() => {
        activeSession!.fireEvent({ type: 'reconnect_start' });
        activeSession!.fireEvent({ type: 'chat_updated', chat: mockChat });
        activeSession!.fireEvent({ type: 'message_created', message: msgs[0] });
        activeSession!.fireEvent({ type: 'message_created', message: msgs[1] });
        activeSession!.fireEvent({ type: 'loop_started', loopId: 'loop_1' });
        activeSession!.fireEvent({ type: 'pending_tool_result', message: pendingToolMsg });
        activeSession!.fireEvent({
          type: 'tool_block_update',
          toolUseId: 'tu_minion',
          block: {
            renderingGroups: [
              { category: 'text', blocks: [{ type: 'text', text: 'minion progress so far' }] },
            ],
            status: 'running',
          },
        });
        activeSession!.fireEvent({ type: 'snapshot_complete' });
      });

      // Placeholder must survive snapshot_complete's trim so the throttled
      // tool_block_update flush has a message to land on. Wait past the
      // 200ms streaming throttle for renderingGroups to populate.
      await waitFor(
        () => {
          expect(result.current.messages).toHaveLength(3);
          const placeholder = result.current.messages[2];
          expect(placeholder.id).toBe('msg_pending_tool');
          const block = (placeholder.content.renderingContent ?? [])[0]?.blocks[0];
          expect(block).toBeDefined();
          expect((block as { renderingGroups?: unknown[] }).renderingGroups).toBeDefined();
        },
        { timeout: 1000 }
      );
    });

    it('rehydrates minion streaming UI from tool_groups_snapshot on reconnect', async () => {
      // Wave 2 path: a reconnecting subscriber receives `tool_groups_snapshot`
      // from `GremlinServer.attachChat` carrying the assembled
      // `infoGroup` / `accumulatedGroups` / `streamingGroups` for each
      // in-flight minion. The frontend projects the snapshot into the
      // placeholder message's `renderingContent` and flips `loopPhase` to
      // `'streaming'` without waiting for the next live delta.
      const msgs = [makeMsg('m1'), makeMsg('m2', 'assistant')];
      const pendingToolMsg: Message<unknown> = {
        id: 'msg_pending_tool_2',
        role: 'user',
        content: {
          type: 'text',
          content: '',
          renderingContent: [
            {
              category: 'backstage',
              blocks: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu_minion_2',
                  content: '',
                  name: 'minion',
                  status: 'running',
                },
              ],
            },
          ],
        },
        timestamp: new Date('2024-01-01'),
      };

      const infoGroup = {
        category: 'backstage' as const,
        blocks: [{ type: 'tool_info' as const, input: 'go' }],
      };
      const streamingGroup = {
        category: 'text' as const,
        blocks: [{ type: 'text' as const, text: 'minion is thinking...' }],
      };

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );
      await waitFor(() => expect(result.current.chat).toBeTruthy());

      act(() => emitInitialSnapshot(msgs));
      await waitFor(() => expect(result.current.messages).toHaveLength(2));

      act(() => {
        activeSession!.fireEvent({ type: 'reconnect_start' });
        activeSession!.fireEvent({ type: 'chat_updated', chat: mockChat });
        activeSession!.fireEvent({ type: 'message_created', message: msgs[0] });
        activeSession!.fireEvent({ type: 'message_created', message: msgs[1] });
        activeSession!.fireEvent({ type: 'loop_started', loopId: 'loop_1' });
        activeSession!.fireEvent({ type: 'pending_tool_result', message: pendingToolMsg });
        // No live `tool_block_update.renderingGroups` this time — the
        // tool_groups_snapshot is the only carrier of in-flight content.
        activeSession!.fireEvent({
          type: 'tool_groups_snapshot',
          toolUseId: 'tu_minion_2',
          infoGroup,
          accumulatedGroups: [],
          streamingGroups: [streamingGroup],
        });
        activeSession!.fireEvent({ type: 'snapshot_complete' });
      });

      await waitFor(
        () => {
          expect(result.current.messages).toHaveLength(3);
          const placeholder = result.current.messages[2];
          expect(placeholder.id).toBe('msg_pending_tool_2');
          const block = (placeholder.content.renderingContent ?? [])[0]?.blocks[0] as {
            renderingGroups?: unknown[];
          };
          expect(block.renderingGroups).toBeDefined();
          expect(block.renderingGroups).toHaveLength(2); // info + streaming
          expect(result.current.loopPhase).toBe('streaming');
          expect(result.current.isLoading).toBe(true);
        },
        { timeout: 1000 }
      );
    });

    it('rehydrates the in-flight assistant bubble from streaming_snapshot on reconnect', async () => {
      // Parallel to the tool_groups_snapshot path: a reconnecting subscriber
      // receives `streaming_snapshot` from `GremlinServer.attachChat` carrying
      // the partially-streamed assistant groups. The frontend applies them
      // directly so the bubble repaints immediately instead of going blank
      // until the next live `streaming_chunk` (worst on claude-agent, whose
      // turns have long no-token gaps).
      const msgs = [makeMsg('m1'), makeMsg('m2', 'assistant')];
      const streamingGroup = {
        category: 'text' as const,
        blocks: [{ type: 'text' as const, text: 'partial answer so far' }],
      };

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );
      await waitFor(() => expect(result.current.chat).toBeTruthy());

      act(() => emitInitialSnapshot(msgs));
      await waitFor(() => expect(result.current.messages).toHaveLength(2));

      // reconnect_start clears any prior streaming groups; the snapshot refills
      // them via streaming_snapshot, which lands after the (assistant)
      // message_created that would otherwise clear the bubble.
      act(() => {
        activeSession!.fireEvent({ type: 'reconnect_start' });
        activeSession!.fireEvent({ type: 'chat_updated', chat: mockChat });
        activeSession!.fireEvent({ type: 'message_created', message: msgs[0] });
        activeSession!.fireEvent({ type: 'message_created', message: msgs[1] });
        activeSession!.fireEvent({ type: 'loop_started', loopId: 'loop_1' });
        activeSession!.fireEvent({ type: 'streaming_snapshot', groups: [streamingGroup] });
        activeSession!.fireEvent({ type: 'snapshot_complete' });
      });

      await waitFor(
        () => {
          expect(result.current.streamingGroups).toEqual([streamingGroup]);
          expect(result.current.isLoading).toBe(true);
        },
        { timeout: 1000 }
      );
    });

    it('applies tool_groups_delta append events to placeholder rendering', async () => {
      // Wave 2 steady-state path: minion emits `tool_groups_delta` per
      // upstream SSE chunk instead of full snapshots. Init seeds the
      // accumulator, subsequent `append` deltas extend the last text
      // block. The frontend projects the assembled state into the
      // placeholder via the same `applyToolBlockBatch` machinery.
      const pendingToolMsg: Message<unknown> = {
        id: 'msg_pending_tool_3',
        role: 'user',
        content: {
          type: 'text',
          content: '',
          renderingContent: [
            {
              category: 'backstage',
              blocks: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu_minion_3',
                  content: '',
                  name: 'minion',
                  status: 'running',
                },
              ],
            },
          ],
        },
        timestamp: new Date('2024-01-01'),
      };

      const infoGroup = {
        category: 'backstage' as const,
        blocks: [{ type: 'tool_info' as const, input: 'go' }],
      };
      const initialStreaming = {
        category: 'text' as const,
        blocks: [{ type: 'text' as const, text: 'Hi' }],
      };

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );
      await waitFor(() => expect(result.current.chat).toBeTruthy());

      act(() => {
        emitInitialSnapshot([]);
      });

      act(() => {
        activeSession!.fireEvent({ type: 'loop_started', loopId: 'loop_1' });
        activeSession!.fireEvent({ type: 'pending_tool_result', message: pendingToolMsg });
        activeSession!.fireEvent({
          type: 'tool_groups_delta',
          toolUseId: 'tu_minion_3',
          delta: {
            kind: 'init',
            infoGroup,
            accumulatedGroups: [],
            streamingGroups: [initialStreaming],
          },
        });
        activeSession!.fireEvent({
          type: 'tool_groups_delta',
          toolUseId: 'tu_minion_3',
          delta: { kind: 'append', target: 'last_text', text: ', world' },
        });
        activeSession!.fireEvent({
          type: 'tool_groups_delta',
          toolUseId: 'tu_minion_3',
          delta: { kind: 'append', target: 'last_text', text: '!' },
        });
      });

      await waitFor(
        () => {
          const placeholder = result.current.messages.find(m => m.id === 'msg_pending_tool_3');
          expect(placeholder).toBeDefined();
          const block = (placeholder!.content.renderingContent ?? [])[0]?.blocks[0] as {
            renderingGroups?: { blocks: { type: string; text?: string }[] }[];
          };
          expect(block.renderingGroups).toBeDefined();
          // Assembled = [info, streaming]; streaming text is 'Hi, world!'
          expect(block.renderingGroups).toHaveLength(2);
          expect(block.renderingGroups![1].blocks[0]).toMatchObject({
            type: 'text',
            text: 'Hi, world!',
          });
          expect(result.current.loopPhase).toBe('streaming');
        },
        { timeout: 1000 }
      );
    });
  });

  // ==========================================================================
  // Snapshot loading phase
  // ==========================================================================

  describe('Snapshot loading phase', () => {
    it('starts with snapshotLoading true', () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );
      expect(result.current.snapshotLoading).toBe(true);
    });

    it('clears snapshotLoading after snapshot_complete', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );
      await waitFor(() => expect(result.current.chat).toBeTruthy());

      expect(result.current.snapshotLoading).toBe(true);

      act(() => {
        emitInitialSnapshot();
      });

      await waitFor(() => {
        expect(result.current.snapshotLoading).toBe(false);
      });
    });

    it('re-enters snapshotLoading on reconnect_start and clears on snapshot_complete', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );
      await waitFor(() => expect(result.current.chat).toBeTruthy());

      act(() => emitInitialSnapshot());
      await waitFor(() => expect(result.current.snapshotLoading).toBe(false));

      act(() => {
        activeSession!.fireEvent({ type: 'reconnect_start' });
      });
      expect(result.current.snapshotLoading).toBe(true);

      act(() => {
        activeSession!.fireEvent({ type: 'chat_updated', chat: mockChat });
        activeSession!.fireEvent({ type: 'message_created', message: mockUserMessage });
        activeSession!.fireEvent({ type: 'snapshot_complete' });
      });

      await waitFor(() => expect(result.current.snapshotLoading).toBe(false));
    });

    it('suppresses showContinueBanner during snapshot loading', async () => {
      // A tool_result message at the tail would normally trigger the banner
      const toolResultMsg: Message<unknown> = {
        id: 'msg_toolresult',
        role: 'user',
        content: {
          type: 'text',
          content: '',
          fullContent: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'done' }],
          renderingContent: [
            {
              category: 'backstage',
              blocks: [
                { type: 'tool_result', tool_use_id: 'tool_1', content: 'done', name: 'test' },
              ],
            },
          ],
        },
        timestamp: new Date('2024-01-01'),
      };

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );
      await waitFor(() => expect(result.current.chat).toBeTruthy());

      // Feed messages without snapshot_complete — still loading
      act(() => {
        activeSession!.fireEvent({ type: 'chat_updated', chat: mockChat });
        activeSession!.fireEvent({ type: 'message_created', message: mockUserMessage });
        activeSession!.fireEvent({ type: 'message_created', message: mockAssistantMessage });
        activeSession!.fireEvent({ type: 'message_created', message: toolResultMsg });
      });

      // Banner should be suppressed while snapshot is loading
      expect(result.current.snapshotLoading).toBe(true);
      expect(result.current.showContinueBanner).toBe(false);

      // Complete the snapshot
      act(() => {
        activeSession!.fireEvent({ type: 'snapshot_complete' });
      });

      await waitFor(() => {
        expect(result.current.snapshotLoading).toBe(false);
        expect(result.current.showContinueBanner).toBe(true);
      });
    });

    it('shows showContinueBanner for plain user message at tail', async () => {
      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );

      await waitFor(() => expect(result.current.chat).toBeTruthy());

      // Emit snapshot ending with a plain user message (no tool results)
      act(() => {
        activeSession!.fireEvent({ type: 'chat_updated', chat: mockChat });
        activeSession!.fireEvent({ type: 'message_created', message: mockUserMessage });
        activeSession!.fireEvent({ type: 'snapshot_complete' });
      });

      await waitFor(() => {
        expect(result.current.snapshotLoading).toBe(false);
        expect(result.current.showContinueBanner).toBe(true);
      });
    });

    it('suppresses unresolvedToolCalls during snapshot loading', async () => {
      const assistantWithToolUse: Message<unknown> = {
        id: 'msg_assistant_tooluse',
        role: 'assistant',
        content: {
          type: 'text',
          content: '',
          modelFamily: 'anthropic',
          fullContent: [{ type: 'tool_use', id: 'tool_1', name: 'ping', input: {} }],
          toolUseBlocks: [{ type: 'tool_use', id: 'tool_1', name: 'ping', input: {} }],
          renderingContent: [
            {
              category: 'backstage',
              blocks: [{ type: 'tool_use', id: 'tool_1', name: 'ping', input: {} }],
            },
          ],
        },
        timestamp: new Date('2024-01-01'),
      };

      const { result } = renderHook(() =>
        useChat({ chatId: 'chat_123', callbacks: mockCallbacks })
      );
      await waitFor(() => expect(result.current.chat).toBeTruthy());

      // Feed messages without snapshot_complete
      act(() => {
        activeSession!.fireEvent({ type: 'chat_updated', chat: mockChat });
        activeSession!.fireEvent({ type: 'message_created', message: mockUserMessage });
        activeSession!.fireEvent({ type: 'message_created', message: assistantWithToolUse });
      });

      expect(result.current.snapshotLoading).toBe(true);
      expect(result.current.unresolvedToolCalls).toBeNull();

      // Complete the snapshot
      act(() => {
        activeSession!.fireEvent({ type: 'snapshot_complete' });
      });

      await waitFor(() => {
        expect(result.current.snapshotLoading).toBe(false);
        expect(result.current.unresolvedToolCalls).not.toBeNull();
        expect(result.current.unresolvedToolCalls).toHaveLength(1);
      });
    });

    it('resets snapshotLoading to true when chatId changes', async () => {
      const { result, rerender } = renderHook(
        ({ chatId }) => useChat({ chatId, callbacks: mockCallbacks }),
        { initialProps: { chatId: 'chat_123' } }
      );
      await waitFor(() => expect(result.current.chat).toBeTruthy());

      act(() => emitInitialSnapshot());
      await waitFor(() => expect(result.current.snapshotLoading).toBe(false));

      const newChat = { ...mockChat, id: 'chat_456', name: 'New Chat' };
      vi.mocked(gremlinClient.getChat).mockResolvedValue(newChat);

      rerender({ chatId: 'chat_456' });

      expect(result.current.snapshotLoading).toBe(true);
    });
  });
});
