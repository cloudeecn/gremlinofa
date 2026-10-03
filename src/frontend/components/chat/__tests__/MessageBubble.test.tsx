import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MessageBubble from '../MessageBubble';
import type { Message } from '../../../../shared/protocol/types';
import type { MessageBubbleProps } from '../types';
import { gremlinClient } from '../../../client';

// Mock hooks - use vi.hoisted() to handle hoisting properly
const mockUseIsMobile = vi.hoisted(() => vi.fn());

vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: mockUseIsMobile,
}));

// Mock utilities
vi.mock('../../../lib/markdownRenderer', () => ({
  renderMarkdownSafe: (text: string) => `<div>${text}</div>`,
}));

vi.mock('../../../lib/messageFormatters', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../lib/messageFormatters')>()),
  stripMetadata: (content: string) => content.replace(/<metadata>.*?<\/metadata>/gs, ''),
  formatTimestamp: (date: Date) => date.toISOString().split('T')[0],
  formatTokens: (label: string, count?: number) => (count ? `${label}${count}` : ''),
  formatTokenCount: (count: number) => `${(count / 1000).toFixed(1)}k`,
}));

vi.mock('../../../lib/alerts', () => ({
  showAlert: vi.fn(),
}));

vi.mock('../../../client', () => ({
  gremlinClient: {
    getAttachments: vi.fn().mockResolvedValue([]),
  },
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
    role: 'user',
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
    isHidden: false,
    onRegister: vi.fn(),
    onMeasureHeight: vi.fn(),
    getHeight: () => undefined,
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
        message: createMessage({ role: 'user' }),
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
          role: 'assistant',
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

    it('passes onAction to UserMessageBubble', async () => {
      const onAction = vi.fn();
      const props = createProps({
        message: createMessage({ role: 'user' }),
        onAction,
      });
      render(<MessageBubble {...props} />);

      // Edit and Fork buttons live on the info bar's expanded row
      await userEvent.click(screen.getByRole('button', { name: 'Message details' }));
      expect(screen.getByTitle('Edit message')).toBeInTheDocument();
      expect(screen.getByTitle('Fork chat from here')).toBeInTheDocument();
    });
  });

  describe('Virtual Scrolling', () => {
    it('renders placeholder div when hidden and a height was measured', () => {
      const props = createProps({
        isHidden: true,
        getHeight: () => 150,
      });
      const { container } = render(<MessageBubble {...props} />);

      const placeholder = container.querySelector('[aria-hidden="true"]');
      expect(placeholder).toBeInTheDocument();
      expect(placeholder).toHaveStyle({ height: '150px' });
    });

    it('placeholder takes its height from getHeight', () => {
      const props = createProps({
        isHidden: true,
        getHeight: () => 250,
      });
      const { container } = render(<MessageBubble {...props} />);

      const placeholder = container.querySelector('[aria-hidden="true"]');
      expect(placeholder).toHaveStyle({ height: '250px' });
    });

    it('placeholder has aria-hidden attribute', () => {
      const props = createProps({
        isHidden: true,
        getHeight: () => 150,
      });
      const { container } = render(<MessageBubble {...props} />);

      const placeholder = container.querySelector('[aria-hidden="true"]');
      expect(placeholder).toHaveAttribute('aria-hidden', 'true');
    });

    it('placeholder maintains proper spacing', () => {
      const props = createProps({
        isHidden: true,
        getHeight: () => 150,
      });
      const { container } = render(<MessageBubble {...props} />);

      const placeholder = container.querySelector('[aria-hidden="true"]');
      expect(placeholder).toHaveClass('mb-4', 'px-4');
    });

    it('renders full content when not hidden', () => {
      const props = createProps({
        isHidden: false,
        getHeight: () => 150,
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

    it('renders full content when hidden but never measured', () => {
      const props = createProps({
        isHidden: true,
        getHeight: () => undefined,
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

    it('ResizeObserver created when not hidden', () => {
      const props = createProps({ isHidden: false });

      render(<MessageBubble {...props} />);

      expect(mockResizeObserverInstance).not.toBeNull();
      expect(mockResizeObserverInstance!.observe).toHaveBeenCalled();
    });

    it('ResizeObserver calls onMeasureHeight on height changes', () => {
      const onMeasureHeight = vi.fn();
      const props = createProps({
        isHidden: false,
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
      const props = createProps({ isHidden: false });

      const { unmount } = render(<MessageBubble {...props} />);

      const observerInstance = mockResizeObserverInstance;
      expect(observerInstance).not.toBeNull();

      unmount();

      expect(observerInstance!.disconnect).toHaveBeenCalled();
    });

    it('ResizeObserver disconnects when it becomes hidden', () => {
      const props = createProps({ isHidden: false });

      const { rerender } = render(<MessageBubble {...props} />);

      const observerInstance = mockResizeObserverInstance;
      expect(observerInstance).not.toBeNull();

      rerender(<MessageBubble {...props} isHidden getHeight={() => 150} />);

      expect(observerInstance!.disconnect).toHaveBeenCalled();
    });
  });

  describe('Injected File Routing', () => {
    it('routes user message with injected_file blocks to UserMessageBubble (blue bubble)', () => {
      const props = createProps({
        message: createMessage({
          role: 'user',
          content: {
            type: 'text',
            content: 'Analyze this file',
            renderingContent: [
              {
                category: 'text',
                blocks: [{ type: 'text', text: 'Analyze this file' }],
              },
              {
                category: 'backstage',
                blocks: [
                  {
                    type: 'injected_file',
                    path: 'src/foo.ts',
                    content: 'const foo = 1;',
                  },
                ],
              },
            ],
          },
        }),
      });
      const { container } = render(<MessageBubble {...props} />);

      // Should render as blue user bubble, not ToolResultBubble
      expect(container.querySelector('.bg-blue-600')).toBeInTheDocument();
      expect(container.querySelector('.items-end')).toBeInTheDocument();
      // Message text should be visible
      expect(screen.getByText('Analyze this file')).toBeInTheDocument();
    });

    it('does NOT treat injected_file blocks as tool_result (no ToolResultBubble)', () => {
      const props = createProps({
        message: createMessage({
          role: 'user',
          content: {
            type: 'text',
            content: 'Check these',
            renderingContent: [
              {
                category: 'text',
                blocks: [{ type: 'text', text: 'Check these' }],
              },
              {
                category: 'backstage',
                blocks: [
                  { type: 'injected_file', path: 'a.ts', content: 'a' },
                  { type: 'injected_file', path: 'b.ts', content: 'b' },
                ],
              },
            ],
          },
        }),
      });
      const { container } = render(<MessageBubble {...props} />);

      // Blue bubble present = UserMessageBubble
      expect(container.querySelector('.bg-blue-600')).toBeInTheDocument();
      // Text visible
      expect(screen.getByText('Check these')).toBeInTheDocument();
    });
  });

  describe('Attachments', () => {
    it('fetches attachments once across hide/show cycles', async () => {
      const attachment = { id: 'att_1', type: 'image', mimeType: 'image/png', data: 'AAAA' };
      vi.mocked(gremlinClient.getAttachments).mockResolvedValue([attachment] as never);
      const props = createProps({
        message: createMessage({
          content: { type: 'text', content: 'with image', attachmentIds: ['att_1'] },
        }),
      });

      const { rerender } = render(<MessageBubble {...props} />);
      await waitFor(() => expect(screen.getByAltText('Attachment')).toBeInTheDocument());

      rerender(<MessageBubble {...props} isHidden getHeight={() => 150} />);
      rerender(<MessageBubble {...props} isHidden={false} getHeight={() => 150} />);
      rerender(<MessageBubble {...props} isHidden getHeight={() => 150} />);
      rerender(<MessageBubble {...props} isHidden={false} getHeight={() => 150} />);

      expect(screen.getByAltText('Attachment')).toBeInTheDocument();
      expect(gremlinClient.getAttachments).toHaveBeenCalledTimes(1);
    });
  });
});
