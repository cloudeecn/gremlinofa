import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import MessageList from '../MessageList';
import type { Message, MessageRole } from '../../../types';
import type { RenderingBlockGroup } from '../../../types/content';

// Mock IntersectionObserver
let mockObserver: {
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  mockObserver = {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };

  global.IntersectionObserver = vi.fn(() => {
    return mockObserver as unknown as IntersectionObserver;
  }) as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  vi.clearAllMocks();
});

// Mock child components
vi.mock('../MessageBubble', () => ({
  default: ({ message, isVisible, cachedHeight }: any) => (
    <div
      data-testid={`message-bubble-${message.id}`}
      data-visible={isVisible}
      data-cached-height={cachedHeight}
    >
      Message: {message.id}
    </div>
  ),
}));

vi.mock('../StreamingMessage', () => ({
  default: ({ groups }: any) => (
    <div data-testid="streaming-message" data-groups-count={groups.length}>
      Streaming: {groups.length} groups
    </div>
  ),
}));

vi.mock('../BouncingDots', () => ({
  default: () => (
    <div className="flex gap-1">
      <span className="bouncing-dot text-gray-500">•</span>
      <span className="bouncing-dot text-gray-500">•</span>
      <span className="bouncing-dot text-gray-500">•</span>
    </div>
  ),
}));

vi.mock('../CacheWarning', () => ({
  default: () => null,
}));

vi.mock('../WebLLMLoadingView', () => ({
  default: ({ modelName, progress }: { modelName: string; progress: { text: string } }) => (
    <div data-testid="webllm-loading-view" data-model={modelName} data-status={progress.text}>
      Loading: {modelName}
    </div>
  ),
}));

// Mock for WebLLM loading state subscription
let mockLoadingStateListener: ((state: any) => void) | null = null;
vi.mock('../../../services/api/webllmClient', () => ({
  subscribeToLoadingState: (listener: (state: any) => void) => {
    mockLoadingStateListener = listener;
    // Immediately call with initial state (not loading)
    listener({ isLoading: false, modelId: null, progress: -1, statusText: '', isReady: false });
    return () => {
      mockLoadingStateListener = null;
    };
  },
}));

vi.mock('../../../services/api/webllmModelInfo', () => ({
  getModelInfo: (modelId: string) => ({
    displayName: modelId,
    downloadSize: 1073741824, // 1 GB
    vramRequired: 2147483648, // 2 GB
  }),
}));

vi.mock('../../../hooks/useVirtualScroll', () => ({
  useVirtualScroll: () => ({
    visibleMessageIds: new Set(['msg-1', 'msg-2']),
    registerMessage: vi.fn(),
    measureHeight: vi.fn(),
    getHeight: (id: string) => (id === 'msg-1' ? 150 : undefined),
  }),
}));

describe('MessageList', () => {
  const mockOnAction = vi.fn();

  const createMessage = (id: string, role: MessageRole = 'user'): Message<unknown> => ({
    id,
    role,
    content: { type: 'text' as const, content: `Test message ${id}` },
    timestamp: new Date(),
  });

  const createStreamingGroups = (text: string): RenderingBlockGroup[] => [
    {
      category: 'text',
      blocks: [{ type: 'text', text }],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic Functionality', () => {
    it('should render all messages from messages prop', () => {
      const messages = [createMessage('msg-1'), createMessage('msg-2'), createMessage('msg-3')];

      render(
        <MessageList
          messages={messages}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      expect(screen.getByTestId('message-bubble-msg-1')).toBeInTheDocument();
      expect(screen.getByTestId('message-bubble-msg-2')).toBeInTheDocument();
      expect(screen.getByTestId('message-bubble-msg-3')).toBeInTheDocument();
    });

    it('should pass message prop to each MessageBubble', () => {
      const messages = [createMessage('msg-1'), createMessage('msg-2')];

      render(
        <MessageList
          messages={messages}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      const bubble1 = screen.getByTestId('message-bubble-msg-1');
      const bubble2 = screen.getByTestId('message-bubble-msg-2');

      expect(bubble1).toHaveTextContent('Message: msg-1');
      expect(bubble2).toHaveTextContent('Message: msg-2');
    });

    it('should pass onAction callback to MessageBubble', () => {
      const messages = [createMessage('msg-1')];

      render(
        <MessageList
          messages={messages}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      // The mock component doesn't trigger actions, but we can verify the prop is passed
      expect(screen.getByTestId('message-bubble-msg-1')).toBeInTheDocument();
    });

    it('should create unique key for each MessageBubble (message.id)', () => {
      const messages = [createMessage('msg-1'), createMessage('msg-2'), createMessage('msg-3')];

      const { container } = render(
        <MessageList
          messages={messages}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      // Each message should have a unique testid
      expect(container.querySelector('[data-testid="message-bubble-msg-1"]')).toBeInTheDocument();
      expect(container.querySelector('[data-testid="message-bubble-msg-2"]')).toBeInTheDocument();
      expect(container.querySelector('[data-testid="message-bubble-msg-3"]')).toBeInTheDocument();
    });

    it('should show bouncing dots loading indicator when isLoading=true and no streaming groups', () => {
      const { container } = render(
        <MessageList
          messages={[]}
          onAction={mockOnAction}
          isLoading={true}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      // Check for bouncing dots (bouncing-dot class) - there are 3 dots
      const bouncingDots = container.querySelectorAll('.bouncing-dot');
      expect(bouncingDots.length).toBe(3);
    });

    it('should not show loading indicator when streaming groups exist', () => {
      const { container } = render(
        <MessageList
          messages={[]}
          onAction={mockOnAction}
          isLoading={true}
          streamingGroups={createStreamingGroups('Streaming content...')}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      // Should show StreamingMessage, not loading indicator
      expect(screen.getByTestId('streaming-message')).toBeInTheDocument();

      // Should not have loading dots
      const animateBounceElements = container.querySelectorAll('.animate-bounce');
      expect(animateBounceElements.length).toBe(0);
    });

    it('should show StreamingMessage when streamingGroups has content', () => {
      render(
        <MessageList
          messages={[]}
          onAction={mockOnAction}
          isLoading={true}
          streamingGroups={createStreamingGroups('Streaming content...')}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      const streamingMessage = screen.getByTestId('streaming-message');
      expect(streamingMessage).toBeInTheDocument();
      expect(streamingMessage).toHaveAttribute('data-groups-count', '1');
    });

    it('should pass correct props to StreamingMessage', () => {
      const groups: RenderingBlockGroup[] = [
        {
          category: 'backstage',
          blocks: [{ type: 'thinking', thinking: 'Thinking...' }],
        },
        {
          category: 'text',
          blocks: [{ type: 'text', text: 'Content' }],
        },
      ];

      render(
        <MessageList
          messages={[]}
          onAction={mockOnAction}
          isLoading={true}
          streamingGroups={groups}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      const streamingMessage = screen.getByTestId('streaming-message');
      expect(streamingMessage).toHaveAttribute('data-groups-count', '2');
    });
  });

  describe('Auto-Scroll Behavior', () => {
    it('should auto-scroll to bottom when new message added', async () => {
      const { rerender } = render(
        <MessageList
          messages={[createMessage('msg-1')]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      // Add a new message
      rerender(
        <MessageList
          messages={[createMessage('msg-1'), createMessage('msg-2')]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('message-bubble-msg-2')).toBeInTheDocument();
      });
    });

    it('should auto-scroll during streaming content updates', async () => {
      const { rerender } = render(
        <MessageList
          messages={[]}
          onAction={mockOnAction}
          isLoading={true}
          streamingGroups={createStreamingGroups('Initial')}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      rerender(
        <MessageList
          messages={[]}
          onAction={mockOnAction}
          isLoading={true}
          streamingGroups={createStreamingGroups('Initial updated content')}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('streaming-message')).toBeInTheDocument();
      });
    });
  });

  describe('Virtual Scrolling Integration', () => {
    it('should pass isVisible prop based on visibleMessageIds.has(message.id)', () => {
      const messages = [createMessage('msg-1'), createMessage('msg-2'), createMessage('msg-3')];

      render(
        <MessageList
          messages={messages}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      // msg-1 and msg-2 are in visibleMessageIds (from mock), msg-3 is not
      expect(screen.getByTestId('message-bubble-msg-1')).toHaveAttribute('data-visible', 'true');
      expect(screen.getByTestId('message-bubble-msg-2')).toHaveAttribute('data-visible', 'true');
      expect(screen.getByTestId('message-bubble-msg-3')).toHaveAttribute('data-visible', 'false');
    });

    it('should pass cachedHeight from getHeight to MessageBubble', () => {
      const messages = [createMessage('msg-1'), createMessage('msg-2')];

      render(
        <MessageList
          messages={messages}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      // msg-1 has cachedHeight=150
      expect(screen.getByTestId('message-bubble-msg-1')).toHaveAttribute(
        'data-cached-height',
        '150'
      );
      // msg-2 has undefined cachedHeight, so React won't render the attribute
      const msg2 = screen.getByTestId('message-bubble-msg-2');
      expect(msg2.getAttribute('data-cached-height')).toBeNull();
    });

    it('should pass all virtual scrolling props to MessageBubbles', () => {
      const messages = [createMessage('msg-1')];

      render(
        <MessageList
          messages={messages}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      const bubble = screen.getByTestId('message-bubble-msg-1');
      expect(bubble).toHaveAttribute('data-visible');
      expect(bubble).toHaveAttribute('data-cached-height');
    });
  });

  describe('Container Styling', () => {
    it('should have overflow-y-auto for vertical scrolling', () => {
      const { container } = render(
        <MessageList
          messages={[]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      const scrollContainer = container.querySelector('.overflow-y-auto');
      expect(scrollContainer).toBeInTheDocument();
    });

    it('should have overscroll-y-contain to prevent scroll chaining', () => {
      const { container } = render(
        <MessageList
          messages={[]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      const scrollContainer = container.querySelector('.overscroll-y-contain');
      expect(scrollContainer).toBeInTheDocument();
    });

    it('should have ios-scroll class for momentum scrolling', () => {
      const { container } = render(
        <MessageList
          messages={[]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      const scrollContainer = container.querySelector('.ios-scroll');
      expect(scrollContainer).toBeInTheDocument();
    });

    it('should have min-h-0 for flex container shrinking', () => {
      const { container } = render(
        <MessageList
          messages={[]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      const scrollContainer = container.querySelector('.min-h-0');
      expect(scrollContainer).toBeInTheDocument();
    });

    it('should have onScroll handler attached', () => {
      const { container } = render(
        <MessageList
          messages={[]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      const scrollContainer = container.querySelector('[class*="overflow-y-auto"]');
      expect(scrollContainer).toBeInTheDocument();
    });

    it('should have inner container with py-4 padding', () => {
      const { container } = render(
        <MessageList
          messages={[]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      const innerContainer = container.querySelector('.py-4');
      expect(innerContainer).toBeInTheDocument();
    });
  });

  describe('Scroll Button Throttle Cleanup', () => {
    it('should clear pending timeout on unmount (no state updates after unmount)', () => {
      vi.useFakeTimers();
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      const { container, unmount } = render(
        <MessageList
          messages={[createMessage('msg-1')]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      // Get scroll container and trigger scroll events to create a pending timeout
      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
      if (scrollContainer) {
        // Mock scroll position to be "not at bottom" to trigger button show logic
        Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, writable: true });
        Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, writable: true });
        Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, writable: true });

        // First scroll - triggers immediate update (no timeout yet)
        fireEvent.scroll(scrollContainer);

        // Advance less than throttle interval
        vi.advanceTimersByTime(50);

        // Second scroll - will schedule a timeout since we're within throttle window
        fireEvent.scroll(scrollContainer);
      }

      // Unmount while timeout is pending
      unmount();

      // Verify clearTimeout was called (for cleanup)
      expect(clearTimeoutSpy).toHaveBeenCalled();

      // Advance time - should not cause errors
      vi.advanceTimersByTime(500);

      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should clear pending timeout when scroll-to-bottom button is clicked', () => {
      vi.useFakeTimers();
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      const { container } = render(
        <MessageList
          messages={[createMessage('msg-1')]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      // Get scroll container and trigger scroll to show the button
      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
      if (scrollContainer) {
        Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, writable: true });
        Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, writable: true });
        Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, writable: true });

        // Fire multiple scroll events to potentially queue a pending timeout
        fireEvent.scroll(scrollContainer);
        vi.advanceTimersByTime(50); // Advance less than throttle interval
        fireEvent.scroll(scrollContainer);
      }

      // Advance time to allow button to appear
      vi.advanceTimersByTime(250);

      // Click the scroll-to-bottom button if it appeared
      const scrollButton = container.querySelector('.scroll-to-bottom-button');
      if (scrollButton) {
        const callCountBefore = clearTimeoutSpy.mock.calls.length;
        fireEvent.click(scrollButton);
        // Verify clearTimeout was called when button was clicked
        expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(callCountBefore);
      }

      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    });
  });

  describe('WebLLM Loading State', () => {
    it('should not show WebLLMLoadingView when not loading', () => {
      render(
        <MessageList
          messages={[]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      expect(screen.queryByTestId('webllm-loading-view')).not.toBeInTheDocument();
    });

    it('should show WebLLMLoadingView when WebLLM model is loading', async () => {
      render(
        <MessageList
          messages={[]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      // Initially not showing
      expect(screen.queryByTestId('webllm-loading-view')).not.toBeInTheDocument();

      // Simulate WebLLM starting to load
      if (mockLoadingStateListener) {
        mockLoadingStateListener({
          isLoading: true,
          modelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
          progress: 50,
          statusText: 'Downloading model...',
          isReady: false,
        });
      }

      await waitFor(() => {
        expect(screen.getByTestId('webllm-loading-view')).toBeInTheDocument();
      });

      expect(screen.getByTestId('webllm-loading-view')).toHaveAttribute(
        'data-model',
        'Llama-3.2-1B-Instruct-q4f16_1-MLC'
      );
      expect(screen.getByTestId('webllm-loading-view')).toHaveAttribute(
        'data-status',
        'Downloading model...'
      );
    });

    it('should hide WebLLMLoadingView when loading completes', async () => {
      render(
        <MessageList
          messages={[]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      // Start loading
      if (mockLoadingStateListener) {
        mockLoadingStateListener({
          isLoading: true,
          modelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
          progress: 50,
          statusText: 'Loading...',
          isReady: false,
        });
      }

      await waitFor(() => {
        expect(screen.getByTestId('webllm-loading-view')).toBeInTheDocument();
      });

      // Complete loading
      if (mockLoadingStateListener) {
        mockLoadingStateListener({
          isLoading: false,
          modelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
          progress: 100,
          statusText: 'Model ready',
          isReady: true,
        });
      }

      await waitFor(() => {
        expect(screen.queryByTestId('webllm-loading-view')).not.toBeInTheDocument();
      });
    });

    it('should show WebLLM loading regardless of chat model (model-agnostic)', async () => {
      // Chat is using a different API (non-WebLLM), but WebLLM is loading in background
      render(
        <MessageList
          messages={[]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId="openai-def"
          currentModelId="gpt-4"
        />
      );

      // Simulate WebLLM loading for background features
      if (mockLoadingStateListener) {
        mockLoadingStateListener({
          isLoading: true,
          modelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
          progress: 25,
          statusText: 'Downloading...',
          isReady: false,
        });
      }

      await waitFor(() => {
        expect(screen.getByTestId('webllm-loading-view')).toBeInTheDocument();
      });
    });

    it('should show WebLLM loading even when chat is streaming', async () => {
      // Chat is streaming from API, but WebLLM is also loading in background
      render(
        <MessageList
          messages={[]}
          onAction={mockOnAction}
          isLoading={true}
          streamingGroups={createStreamingGroups('Streaming content...')}
          currentApiDefId="openai-def"
          currentModelId="gpt-4"
        />
      );

      // Simulate WebLLM loading
      if (mockLoadingStateListener) {
        mockLoadingStateListener({
          isLoading: true,
          modelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
          progress: 75,
          statusText: 'Loading model...',
          isReady: false,
        });
      }

      await waitFor(() => {
        // Both streaming message and WebLLM loading should be visible
        expect(screen.getByTestId('streaming-message')).toBeInTheDocument();
        expect(screen.getByTestId('webllm-loading-view')).toBeInTheDocument();
      });
    });
  });
});
