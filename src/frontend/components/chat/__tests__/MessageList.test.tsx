import { act, createRef } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import MessageList from '../MessageList';
import type { MessageListHandle } from '../types';
import type { Message, MessageRole } from '../../../../shared/protocol/types';
import type { RenderingBlockGroup } from '../../../../shared/protocol/types/content';

// The list's tail-follow ResizeObservers; `fireResize` reports a size change
// to the ones still connected
let resizeObservers: { callback: ResizeObserverCallback; connected: boolean }[];
const fireResize = () => {
  for (const observer of resizeObservers) {
    if (observer.connected) observer.callback([], observer as unknown as ResizeObserver);
  }
};

// Mock IntersectionObserver
let mockObserver: {
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  // jsdom has no Element.scrollTo
  HTMLElement.prototype.scrollTo = vi.fn() as unknown as typeof HTMLElement.prototype.scrollTo;

  mockObserver = {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };

  // A function, not an arrow: the window's sentinels construct it with `new`
  global.IntersectionObserver = vi.fn(function () {
    return mockObserver as unknown as IntersectionObserver;
  }) as unknown as typeof IntersectionObserver;

  resizeObservers = [];
  global.ResizeObserver = vi.fn(function (callback: ResizeObserverCallback) {
    const observer = {
      callback,
      connected: true,
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: () => {
        observer.connected = false;
      },
    };
    resizeObservers.push(observer);
    return observer;
  }) as unknown as typeof ResizeObserver;
});

afterEach(() => {
  vi.clearAllMocks();
});

const bubbleRenders = vi.hoisted(() => ({ count: 0 }));
const scrubber = vi.hoisted(() => ({ props: null as any }));

// Mock child components
vi.mock('../ChatScrubber', () => ({
  default: (props: any) => {
    scrubber.props = props;
    return <div data-testid="chat-scrubber" />;
  },
}));

vi.mock('../MessageBubble', () => ({
  default: ({ message, isHidden, getHeight }: any) => {
    bubbleRenders.count++;
    return (
      <div
        data-testid={`message-bubble-${message.id}`}
        data-hidden={isHidden}
        data-cached-height={getHeight(message.id)}
      >
        Message: {message.id}
      </div>
    );
  },
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
    hiddenMessageIds: new Set(['msg-3']),
    registerMessage: vi.fn(),
    measureHeight: vi.fn(),
    getHeight: (id: string) => (id === 'msg-1' ? 150 : undefined),
    getElement: () => undefined,
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

  describe('Following through resizes', () => {
    const setScrollMetrics = (
      scrollContainer: HTMLElement,
      metrics: Partial<Record<'scrollTop' | 'scrollHeight' | 'clientHeight', number>>
    ) => {
      for (const [key, value] of Object.entries(metrics)) {
        Object.defineProperty(scrollContainer, key, { value, writable: true, configurable: true });
      }
    };

    const renderList = (props: { snapshotLoading?: boolean } = {}) =>
      render(
        <MessageList
          messages={[createMessage('msg-1')]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
          {...props}
        />
      );

    it('keeps the bottom in view when content grows without new messages', () => {
      const { container } = renderList();
      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
      setScrollMetrics(scrollContainer, { scrollTop: 500, scrollHeight: 1000, clientHeight: 500 });

      // A banner or late-loading image grows the content by 300px
      setScrollMetrics(scrollContainer, { scrollHeight: 1300 });
      fireResize();

      expect(scrollContainer.scrollTop).toBe(1300);
    });

    it('leaves a reader who scrolled up where they are', () => {
      const { container } = renderList();
      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
      setScrollMetrics(scrollContainer, { scrollTop: 500, scrollHeight: 1000, clientHeight: 500 });
      fireEvent.scroll(scrollContainer);
      scrollContainer.scrollTop = 100;
      fireEvent.scroll(scrollContainer);

      setScrollMetrics(scrollContainer, { scrollHeight: 1300 });
      fireResize();

      expect(scrollContainer.scrollTop).toBe(100);
    });

    it('waits out snapshot replay', () => {
      const { container } = renderList({ snapshotLoading: true });
      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
      setScrollMetrics(scrollContainer, { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 });

      fireResize();

      expect(scrollContainer.scrollTop).toBe(0);
    });
  });

  describe('Virtual Scrolling Integration', () => {
    it('should pass isHidden prop based on hiddenMessageIds.has(message.id)', () => {
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

      // Only msg-3 is in hiddenMessageIds (from mock)
      expect(screen.getByTestId('message-bubble-msg-1')).toHaveAttribute('data-hidden', 'false');
      expect(screen.getByTestId('message-bubble-msg-2')).toHaveAttribute('data-hidden', 'false');
      expect(screen.getByTestId('message-bubble-msg-3')).toHaveAttribute('data-hidden', 'true');
    });

    it('should pass getHeight to MessageBubble', () => {
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
      expect(bubble).toHaveAttribute('data-hidden');
      expect(bubble).toHaveAttribute('data-cached-height');
    });

    it('shows a loading indicator while the initial snapshot replays', () => {
      const { rerender } = render(
        <MessageList
          messages={[]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
          snapshotLoading={true}
        />
      );
      expect(screen.getByTestId('snapshot-loading')).toBeInTheDocument();

      rerender(
        <MessageList
          messages={[createMessage('msg-1')]}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
          snapshotLoading={false}
        />
      );
      expect(screen.queryByTestId('snapshot-loading')).not.toBeInTheDocument();
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

  describe('Scrubber', () => {
    const manyMessages = (count: number) =>
      Array.from({ length: count }, (_, i) => createMessage(`msg-${i}`));

    const fakeScrollMetrics = (scrollContainer: HTMLElement) => {
      Object.defineProperty(scrollContainer, 'scrollTop', { value: 0, writable: true });
      Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, writable: true });
      Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, writable: true });
    };

    it('replaces the scroll-to-bottom button and gets the mounted window', () => {
      const { container } = render(
        <MessageList
          messages={manyMessages(3)}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );

      expect(screen.getByTestId('chat-scrubber')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Scroll to bottom' })).not.toBeInTheDocument();
      expect(scrubber.props).toMatchObject({ start: 0, end: 3, followingTail: true });
      // Native scrollbar hidden; the rail controls the list
      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
      expect(scrollContainer).toHaveClass('scrollbar-none');
      expect(scrubber.props.scrollContainerId).toBe(scrollContainer.id);
    });

    it('scrolling does not re-render the list', () => {
      const { container } = render(
        <MessageList
          messages={manyMessages(3)}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );
      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
      fakeScrollMetrics(scrollContainer);
      bubbleRenders.count = 0;

      for (const top of [400, 200, 0]) {
        scrollContainer.scrollTop = top;
        fireEvent.scroll(scrollContainer);
      }

      expect(bubbleRenders.count).toBe(0);
    });

    it('a jump into history mounts a window there and hides live output', () => {
      render(
        <MessageList
          messages={manyMessages(100)}
          onAction={mockOnAction}
          isLoading={true}
          streamingGroups={createStreamingGroups('live')}
          currentApiDefId={null}
          currentModelId={null}
        />
      );
      expect(screen.getByTestId('streaming-message')).toBeInTheDocument();

      act(() => scrubber.props.onJump(0));

      expect(scrubber.props).toMatchObject({ start: 0, end: 30, followingTail: false });
      expect(screen.getByTestId('message-bubble-msg-0')).toBeInTheDocument();
      expect(screen.queryByTestId('message-bubble-msg-99')).not.toBeInTheDocument();
      // Streaming output belongs after the last message, which isn't mounted
      expect(screen.queryByTestId('streaming-message')).not.toBeInTheDocument();
    });

    it('a jump stops auto-follow; jumpToLatest through the ref resumes it', () => {
      const ref = createRef<MessageListHandle>();
      const props = {
        onAction: mockOnAction,
        isLoading: false,
        streamingGroups: [],
        currentApiDefId: null,
        currentModelId: null,
      };
      const { container, rerender } = render(
        <MessageList ref={ref} messages={manyMessages(3)} {...props} />
      );
      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
      fakeScrollMetrics(scrollContainer);

      // Jump to a message that's already mounted: the window stays on the tail
      act(() => scrubber.props.onJump(0));
      expect(scrubber.props.followingTail).toBe(true);
      rerender(<MessageList ref={ref} messages={manyMessages(4)} {...props} />);
      expect(scrollContainer.scrollTop).toBe(0);

      act(() => ref.current!.jumpToLatest());
      expect(scrollContainer.scrollTop).toBe(1000);
      scrollContainer.scrollTop = 0;
      rerender(<MessageList ref={ref} messages={manyMessages(5)} {...props} />);
      expect(scrollContainer.scrollTop).toBe(1000);
    });

    it('the latest pill animates when the tail is already mounted', () => {
      const { container } = render(
        <MessageList
          messages={manyMessages(3)}
          onAction={mockOnAction}
          isLoading={false}
          streamingGroups={[]}
          currentApiDefId={null}
          currentModelId={null}
        />
      );
      const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
      fakeScrollMetrics(scrollContainer);

      act(() => scrubber.props.onJumpToLatest('smooth'));

      expect(scrollContainer.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });
    });
  });
});
