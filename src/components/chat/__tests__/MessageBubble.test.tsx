import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import MessageBubble from '../MessageBubble';
import { MessageRole } from '../../../types';
import type { Message } from '../../../types';
import type { MessageBubbleProps } from '../types';

// Mock hooks - use vi.hoisted() to handle hoisting properly
const mockUseIsMobile = vi.hoisted(() => vi.fn());

vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: mockUseIsMobile,
}));

// Mock utilities
vi.mock('../../../utils/markdownRenderer', () => ({
  renderMarkdownSafe: (text: string) => `<div>${text}</div>`,
}));

vi.mock('../../../utils/messageFormatters', () => ({
  stripMetadata: (content: string) => content.replace(/<metadata>.*?<\/metadata>/gs, ''),
  formatTimestamp: (date: Date) => date.toISOString().split('T')[0],
  formatTokens: (label: string, count?: number) => (count ? `${label}${count}` : ''),
  formatTokenCount: (count: number) => `${(count / 1000).toFixed(1)}k`,
}));

vi.mock('../../../utils/alerts', () => ({
  showAlert: vi.fn(),
}));

// Mock ResizeObserver - track instances for testing
let mockResizeObserverInstance: {
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} | null = null;

class MockResizeObserver {
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;

  constructor(_callback: ResizeObserverCallback) {
    this.observe = vi.fn();
    this.unobserve = vi.fn();
    this.disconnect = vi.fn();
    mockResizeObserverInstance = this;
  }
}
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// Helper function to create test messages
function createMessage(overrides: Partial<Message<unknown>> = {}): Message<unknown> {
  return {
    id: 'msg_test_123',
    role: MessageRole.USER,
    content: {
      type: 'text',
      content: 'Test message content',
    },
    timestamp: new Date('2024-01-01T12:00:00Z'),
    ...overrides,
  };
}

// Helper function to create test props
function createProps(overrides: Partial<MessageBubbleProps> = {}): MessageBubbleProps {
  return {
    message: createMessage(),
    onAction: vi.fn(),
    isVisible: true,
    onRegister: vi.fn(),
    onMeasureHeight: vi.fn(),
    cachedHeight: undefined,
    ...overrides,
  };
}

describe('MessageBubble', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseIsMobile.mockReturnValue(false);
    mockResizeObserverInstance = null;
  });

  describe('Component Delegation', () => {
    it('renders UserMessageBubble for user messages', () => {
      const props = createProps({
        message: createMessage({ role: MessageRole.USER }),
      });
      const { container } = render(<MessageBubble {...props} />);

      // User messages have blue bubble and right alignment
      const bubble = container.querySelector('.bg-blue-600');
      expect(bubble).toBeInTheDocument();
      const wrapper = container.querySelector('.items-end');
      expect(wrapper).toBeInTheDocument();
    });

    it('renders AssistantMessageBubble for assistant messages with renderingContent', () => {
      const props = createProps({
        message: createMessage({
          role: MessageRole.ASSISTANT,
          content: {
            type: 'text',
            content: 'Test response',
            renderingContent: [
              { category: 'text', blocks: [{ type: 'text', text: 'Test response' }] },
            ],
          },
        }),
      });
      const { container } = render(<MessageBubble {...props} />);

      // Assistant with renderingContent should not have items-end
      const wrapper = container.querySelector('.items-end');
      expect(wrapper).not.toBeInTheDocument();
    });

    it('renders LegacyAssistantBubble for assistant messages without renderingContent', () => {
      const props = createProps({
        message: createMessage({
          role: MessageRole.ASSISTANT,
          content: {
            type: 'text',
            content: 'Legacy response',
          },
        }),
      });
      const { container } = render(<MessageBubble {...props} />);

      // Legacy assistant should have prose class for markdown
      const prose = container.querySelector('.prose');
      expect(prose).toBeInTheDocument();
    });

    it('passes onAction to UserMessageBubble', () => {
      const onAction = vi.fn();
      const props = createProps({
        message: createMessage({ role: MessageRole.USER }),
        onAction,
      });
      render(<MessageBubble {...props} />);

      // Edit and Fork buttons should be present for user messages
      expect(screen.getByTitle('Edit message')).toBeInTheDocument();
      expect(screen.getByTitle('Fork chat from here')).toBeInTheDocument();
    });
  });

  describe('Virtual Scrolling', () => {
    it('renders placeholder div when not visible and cachedHeight exists', () => {
      const props = createProps({
        isVisible: false,
        cachedHeight: 150,
      });
      const { container } = render(<MessageBubble {...props} />);

      const placeholder = container.querySelector('[aria-hidden="true"]');
      expect(placeholder).toBeInTheDocument();
      expect(placeholder).toHaveStyle({ height: '150px' });
    });

    it('placeholder has correct height from cachedHeight prop', () => {
      const props = createProps({
        isVisible: false,
        cachedHeight: 250,
      });
      const { container } = render(<MessageBubble {...props} />);

      const placeholder = container.querySelector('[aria-hidden="true"]');
      expect(placeholder).toHaveStyle({ height: '250px' });
    });

    it('placeholder has aria-hidden attribute', () => {
      const props = createProps({
        isVisible: false,
        cachedHeight: 150,
      });
      const { container } = render(<MessageBubble {...props} />);

      const placeholder = container.querySelector('[aria-hidden="true"]');
      expect(placeholder).toHaveAttribute('aria-hidden', 'true');
    });

    it('placeholder maintains proper spacing', () => {
      const props = createProps({
        isVisible: false,
        cachedHeight: 150,
      });
      const { container } = render(<MessageBubble {...props} />);

      const placeholder = container.querySelector('[aria-hidden="true"]');
      expect(placeholder).toHaveClass('mb-4', 'px-4');
    });

    it('renders full content when visible', () => {
      const props = createProps({
        isVisible: true,
        cachedHeight: 150,
        message: createMessage({
          content: {
            type: 'text',
            content: 'Full content visible',
          },
        }),
      });
      render(<MessageBubble {...props} />);

      expect(screen.getByText('Full content visible')).toBeInTheDocument();
    });

    it('renders full content when no cachedHeight', () => {
      const props = createProps({
        isVisible: false,
        cachedHeight: undefined,
        message: createMessage({
          content: {
            type: 'text',
            content: 'Content without cached height',
          },
        }),
      });
      render(<MessageBubble {...props} />);

      expect(screen.getByText('Content without cached height')).toBeInTheDocument();
    });

    it('measureRef callback calls onRegister on mount', () => {
      const onRegister = vi.fn();
      const props = createProps({ onRegister });

      render(<MessageBubble {...props} />);

      expect(onRegister).toHaveBeenCalledWith('msg_test_123', expect.any(HTMLDivElement));
    });

    it('measureRef callback calls onMeasureHeight with measured height', () => {
      const onMeasureHeight = vi.fn();
      const props = createProps({ onMeasureHeight });

      const mockGetBoundingClientRect = vi.fn().mockReturnValue({
        height: 120,
        width: 800,
        top: 0,
        left: 0,
        bottom: 120,
        right: 800,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      HTMLDivElement.prototype.getBoundingClientRect = mockGetBoundingClientRect;

      render(<MessageBubble {...props} />);

      expect(onMeasureHeight).toHaveBeenCalledWith('msg_test_123', 120);
    });

    it('measureRef callback calls onRegister with null on unmount', () => {
      const onRegister = vi.fn();
      const props = createProps({ onRegister });

      const { unmount } = render(<MessageBubble {...props} />);

      onRegister.mockClear();
      unmount();

      expect(onRegister).toHaveBeenCalledWith('msg_test_123', null);
    });

    it('ResizeObserver created when visible', () => {
      const props = createProps({ isVisible: true });

      render(<MessageBubble {...props} />);

      expect(mockResizeObserverInstance).not.toBeNull();
      expect(mockResizeObserverInstance!.observe).toHaveBeenCalled();
    });

    it('ResizeObserver calls onMeasureHeight on height changes', () => {
      const onMeasureHeight = vi.fn();
      const props = createProps({
        isVisible: true,
        onMeasureHeight,
      });

      let resizeCallback: ResizeObserverCallback;
      class TestResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      }

      const originalObserver = global.ResizeObserver;
      global.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

      render(<MessageBubble {...props} />);

      const mockEntry = {
        target: {
          getBoundingClientRect: () => ({ height: 180 }),
        },
      } as unknown as ResizeObserverEntry;

      resizeCallback!([mockEntry], {} as ResizeObserver);

      expect(onMeasureHeight).toHaveBeenCalledWith('msg_test_123', 180);

      global.ResizeObserver = originalObserver;
    });

    it('ResizeObserver disconnects when component unmounts', () => {
      const props = createProps({ isVisible: true });

      const { unmount } = render(<MessageBubble {...props} />);

      const observerInstance = mockResizeObserverInstance;
      expect(observerInstance).not.toBeNull();

      unmount();

      expect(observerInstance!.disconnect).toHaveBeenCalled();
    });

    it('ResizeObserver disconnects when becomes not visible', () => {
      const props = createProps({ isVisible: true });

      const { rerender } = render(<MessageBubble {...props} />);

      const observerInstance = mockResizeObserverInstance;
      expect(observerInstance).not.toBeNull();

      rerender(<MessageBubble {...props} isVisible={false} cachedHeight={150} />);

      expect(observerInstance!.disconnect).toHaveBeenCalled();
    });
  });
});
