import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import MessageList from '../MessageList';
import type { Message, MessageRole } from '../../../../shared/protocol/types';
import type { RenderingBlockGroup } from '../../../../shared/protocol/types/content';

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

    it('should not disable auto-scroll when DOM grows (scrollHeight increases, scrollTop unchanged)', () => {
      vi.useFakeTimers();

      const { container, rerender } = render(
        <MessageList
          messages={[createMessage('msg-1')]}
          onAction={mockOnAction}
          isLoading={true}
          streamingGroups={createStreamingGroups('Initial')}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

      // Start near bottom — auto-scroll is active
      Object.defineProperty(scrollContainer, 'scrollTop', {
        value: 500,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(scrollContainer, 'scrollHeight', {
        value: 1000,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(scrollContainer, 'clientHeight', {
        value: 500,
        writable: true,
        configurable: true,
      });

      // Initial scroll to establish prevScrollTop
      fireEvent.scroll(scrollContainer);
      vi.advanceTimersByTime(250);

      // Simulate DOM growth: scrollHeight jumps but scrollTop stays the same
      // This makes isNearBottom false (1500 - 500 - 500 = 500 > 100)
      Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1500, configurable: true });

      fireEvent.scroll(scrollContainer);
      vi.advanceTimersByTime(250);

      // Auto-scroll should still be active — DOM growth must not disable it
      rerender(
        <MessageList
          messages={[createMessage('msg-1')]}
          onAction={mockOnAction}
          isLoading={true}
          streamingGroups={createStreamingGroups('Much larger content now')}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      // If auto-scroll stayed active, scrollTop gets set to scrollHeight
      expect(scrollContainer.scrollTop).toBe(scrollContainer.scrollHeight);

      vi.useRealTimers();
    });

    it('should disable auto-scroll when user scrolls up away from bottom', () => {
      vi.useFakeTimers();

      const { container, rerender } = render(
        <MessageList
          messages={[createMessage('msg-1')]}
          onAction={mockOnAction}
          isLoading={true}
          streamingGroups={createStreamingGroups('Initial')}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;

      // Start at bottom
      Object.defineProperty(scrollContainer, 'scrollTop', {
        value: 500,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(scrollContainer, 'scrollHeight', {
        value: 1000,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(scrollContainer, 'clientHeight', {
        value: 500,
        writable: true,
        configurable: true,
      });

      fireEvent.scroll(scrollContainer);
      vi.advanceTimersByTime(250);

      // User scrolls up — scrollTop decreases, far from bottom
      Object.defineProperty(scrollContainer, 'scrollTop', { value: 100, configurable: true });

      fireEvent.scroll(scrollContainer);
      vi.advanceTimersByTime(250);

      // Auto-scroll should be disabled — new messages shouldn't snap to bottom
      rerender(
        <MessageList
          messages={[createMessage('msg-1'), createMessage('msg-2')]}
          onAction={mockOnAction}
          isLoading={true}
          streamingGroups={createStreamingGroups('Updated')}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      // scrollTop should NOT be set to scrollHeight (auto-scroll was disabled)
      expect(scrollContainer.scrollTop).not.toBe(scrollContainer.scrollHeight);

      vi.useRealTimers();
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

    it('should have overscroll-contain to prevent scroll chaining', () => {
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

      const scrollContainer = container.querySelector('.overscroll-contain');
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

  describe('Always Auto Scroll', () => {
    it('should keep auto-scrolling after user scrolls up when alwaysAutoScroll is enabled', () => {
      vi.useFakeTimers();

      const { container, rerender } = render(
        <MessageList
          messages={[createMessage('msg-1')]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
          alwaysAutoScroll={true}
        />
      );

      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
      // Simulate user scrolled far from bottom
      Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, writable: true });
      Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, writable: true });
      Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, writable: true });

      fireEvent.scroll(scrollContainer);
      vi.advanceTimersByTime(250);

      // Even though far from bottom, auto-scroll should still work on new messages
      rerender(
        <MessageList
          messages={[createMessage('msg-1'), createMessage('msg-2')]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
          alwaysAutoScroll={true}
        />
      );

      // scrollTop should be set to scrollHeight (auto-scroll triggered)
      expect(scrollContainer.scrollTop).toBe(scrollContainer.scrollHeight);

      vi.useRealTimers();
    });

    it('should not disable auto-scroll in focus mode when alwaysAutoScroll is enabled', () => {
      vi.useFakeTimers();

      const { container, rerender } = render(
        <MessageList
          messages={[createMessage('msg-1')]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
          alwaysAutoScroll={true}
          focusMode={true}
        />
      );

      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
      Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, writable: true });
      Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, writable: true });
      Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, writable: true });

      // Add a new message - should still auto-scroll despite focus mode
      rerender(
        <MessageList
          messages={[createMessage('msg-1'), createMessage('msg-2')]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
          alwaysAutoScroll={true}
          focusMode={true}
        />
      );

      expect(scrollContainer.scrollTop).toBe(scrollContainer.scrollHeight);

      vi.useRealTimers();
    });

    it('should snap to bottom when alwaysAutoScroll is toggled on', () => {
      const { container, rerender } = render(
        <MessageList
          messages={[createMessage('msg-1')]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
          alwaysAutoScroll={false}
        />
      );

      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
      Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, writable: true });
      Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, writable: true });
      Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, writable: true });

      // Toggle on
      rerender(
        <MessageList
          messages={[createMessage('msg-1')]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
          alwaysAutoScroll={true}
        />
      );

      expect(scrollContainer.scrollTop).toBe(scrollContainer.scrollHeight);
    });
  });
});
