import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import AssistantMessageBubble from '../AssistantMessageBubble';
import { MessageRole } from '../../../types';
import type { Message, MessageMetadata } from '../../../types';
import type { AssistantMessageBubbleProps } from '../types';

// Mock hooks
const mockUseIsMobile = vi.hoisted(() => vi.fn());

vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: mockUseIsMobile,
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

// Mock sub-components
vi.mock('../BackstageView', () => ({
  default: ({ blocks }: { blocks: unknown[] }) => (
    <div data-testid="backstage-view">BackstageView: {blocks.length} blocks</div>
  ),
}));

vi.mock('../ErrorBlockView', () => ({
  default: ({ blocks }: { blocks: unknown[] }) => (
    <div data-testid="error-block-view">ErrorBlockView: {blocks.length} blocks</div>
  ),
}));

vi.mock('../TextGroupView', () => ({
  default: ({ blocks, isVisible }: { blocks: unknown[]; isVisible: boolean }) => (
    <div data-testid="text-group-view">
      TextGroupView: {blocks.length} blocks, visible: {isVisible ? 'yes' : 'no'}
    </div>
  ),
}));

vi.mock('../StopReasonBadge', () => ({
  default: ({ stopReason }: { stopReason: string }) => (
    <span data-testid="stop-reason-badge">{stopReason}</span>
  ),
}));

// Mock navigator.clipboard
const mockClipboard = {
  writeText: vi.fn(),
};
Object.assign(navigator, { clipboard: mockClipboard });

// Helper function to create test messages
function createMessage(overrides: Partial<Message<unknown>> = {}): Message<unknown> {
  return {
    id: 'msg_assistant_123',
    role: MessageRole.ASSISTANT,
    content: {
      type: 'text',
      content: 'Test assistant response',
      renderingContent: [
        {
          category: 'text',
          blocks: [{ type: 'text', text: 'Hello world' }],
        },
      ],
    },
    timestamp: new Date('2024-01-01T12:00:00Z'),
    ...overrides,
  };
}

// Helper function to create test props
function createProps(
  overrides: Partial<AssistantMessageBubbleProps> = {}
): AssistantMessageBubbleProps {
  return {
    message: createMessage(),
    isVisible: true,
    ...overrides,
  };
}

describe('AssistantMessageBubble', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseIsMobile.mockReturnValue(false);
  });

  describe('Basic Rendering', () => {
    it('renders TextGroupView for text category', () => {
      render(<AssistantMessageBubble {...createProps()} />);
      expect(screen.getByTestId('text-group-view')).toBeInTheDocument();
    });

    it('renders BackstageView for backstage category', () => {
      const props = createProps({
        message: createMessage({
          content: {
            type: 'text',
            content: '',
            renderingContent: [
              {
                category: 'backstage',
                blocks: [{ type: 'thinking', thinking: 'Thinking...' }],
              },
            ],
          },
        }),
      });
      render(<AssistantMessageBubble {...props} />);
      expect(screen.getByTestId('backstage-view')).toBeInTheDocument();
    });

    it('renders ErrorBlockView for error category', () => {
      const props = createProps({
        message: createMessage({
          content: {
            type: 'text',
            content: '',
            renderingContent: [
              {
                category: 'error',
                blocks: [{ type: 'error', message: 'API Error' }],
              },
            ],
          },
        }),
      });
      render(<AssistantMessageBubble {...props} />);
      expect(screen.getByTestId('error-block-view')).toBeInTheDocument();
    });

    it('renders multiple groups correctly', () => {
      const props = createProps({
        message: createMessage({
          content: {
            type: 'text',
            content: '',
            renderingContent: [
              {
                category: 'backstage',
                blocks: [{ type: 'thinking', thinking: 'Thinking...' }],
              },
              {
                category: 'text',
                blocks: [{ type: 'text', text: 'Response' }],
              },
            ],
          },
        }),
      });
      render(<AssistantMessageBubble {...props} />);

      expect(screen.getByTestId('backstage-view')).toBeInTheDocument();
      expect(screen.getByTestId('text-group-view')).toBeInTheDocument();
    });

    it('passes isVisible to TextGroupView', () => {
      const props = createProps({ isVisible: true });
      render(<AssistantMessageBubble {...props} />);

      expect(screen.getByTestId('text-group-view')).toHaveTextContent('visible: yes');
    });

    it('shows timestamp in metadata line', () => {
      const props = createProps({
        message: createMessage({
          timestamp: new Date('2024-01-01T12:00:00Z'),
        }),
      });
      render(<AssistantMessageBubble {...props} />);

      expect(screen.getByText('2024-01-01')).toBeInTheDocument();
    });
  });

  describe('Action Buttons', () => {
    it('shows Copy button', () => {
      render(<AssistantMessageBubble {...createProps()} />);
      expect(screen.getByTitle('Copy message')).toBeInTheDocument();
    });

    it('shows Dump button', () => {
      render(<AssistantMessageBubble {...createProps()} />);
      expect(screen.getByTitle('Copy message JSON')).toBeInTheDocument();
    });

    it('Copy button copies message text to clipboard', async () => {
      mockClipboard.writeText.mockResolvedValue(undefined);
      const props = createProps({
        message: createMessage({
          content: {
            type: 'text',
            content: 'Copy this response',
            renderingContent: [{ category: 'text', blocks: [] }],
          },
        }),
      });
      render(<AssistantMessageBubble {...props} />);

      await userEvent.click(screen.getByTitle('Copy message'));

      expect(mockClipboard.writeText).toHaveBeenCalledWith('Copy this response');
    });

    it('Dump button copies JSON to clipboard', async () => {
      mockClipboard.writeText.mockResolvedValue(undefined);
      const message = createMessage();
      const props = createProps({ message });
      render(<AssistantMessageBubble {...props} />);

      await userEvent.click(screen.getByTitle('Copy message JSON'));

      expect(mockClipboard.writeText).toHaveBeenCalled();
      const clipboardContent = mockClipboard.writeText.mock.calls[0][0];
      const parsed = JSON.parse(clipboardContent);
      expect(parsed.id).toBe(message.id);
    });
  });

  describe('Metadata Display', () => {
    it('displays input tokens', () => {
      const metadata: MessageMetadata = { inputTokens: 100 };
      const props = createProps({
        message: createMessage({ metadata }),
      });
      render(<AssistantMessageBubble {...props} />);

      expect(screen.getByText(/↑100/)).toBeInTheDocument();
    });

    it('displays output tokens', () => {
      const metadata: MessageMetadata = { outputTokens: 200 };
      const props = createProps({
        message: createMessage({ metadata }),
      });
      render(<AssistantMessageBubble {...props} />);

      expect(screen.getByText(/↓200/)).toBeInTheDocument();
    });

    it('displays reasoning tokens', () => {
      const metadata: MessageMetadata = { reasoningTokens: 50 };
      const props = createProps({
        message: createMessage({ metadata }),
      });
      const { container } = render(<AssistantMessageBubble {...props} />);

      const metadataLine = container.querySelector('.text-\\[10px\\]');
      expect(metadataLine?.textContent).toContain('R:50');
    });

    it('displays cache creation tokens', () => {
      const metadata: MessageMetadata = { cacheCreationTokens: 30 };
      const props = createProps({
        message: createMessage({ metadata }),
      });
      const { container } = render(<AssistantMessageBubble {...props} />);

      const metadataLine = container.querySelector('.text-\\[10px\\]');
      expect(metadataLine?.textContent).toContain('C↑30');
    });

    it('displays cache read tokens', () => {
      const metadata: MessageMetadata = { cacheReadTokens: 40 };
      const props = createProps({
        message: createMessage({ metadata }),
      });
      const { container } = render(<AssistantMessageBubble {...props} />);

      const metadataLine = container.querySelector('.text-\\[10px\\]');
      expect(metadataLine?.textContent).toContain('C↓40');
    });

    it('displays context window usage', () => {
      const metadata: MessageMetadata = { contextWindowUsage: 5000 };
      const props = createProps({
        message: createMessage({ metadata }),
      });
      render(<AssistantMessageBubble {...props} />);

      expect(screen.getByText(/5\.0k/)).toBeInTheDocument();
    });

    it('displays message cost', () => {
      const metadata: MessageMetadata = { messageCost: 0.123456 };
      const props = createProps({
        message: createMessage({ metadata }),
      });
      render(<AssistantMessageBubble {...props} />);

      expect(screen.getByText(/\$0\.123/)).toBeInTheDocument();
    });
  });

  describe('Stop Reason Badge', () => {
    it('shows StopReasonBadge for non-normal endings', () => {
      const props = createProps({
        message: createMessage({
          content: {
            type: 'text',
            content: '',
            stopReason: 'max_tokens',
            renderingContent: [{ category: 'text', blocks: [] }],
          },
        }),
      });
      render(<AssistantMessageBubble {...props} />);

      expect(screen.getByTestId('stop-reason-badge')).toHaveTextContent('max_tokens');
    });

    it('does not show StopReasonBadge for end_turn', () => {
      const props = createProps({
        message: createMessage({
          content: {
            type: 'text',
            content: '',
            stopReason: 'end_turn',
            renderingContent: [{ category: 'text', blocks: [] }],
          },
        }),
      });
      render(<AssistantMessageBubble {...props} />);

      expect(screen.queryByTestId('stop-reason-badge')).not.toBeInTheDocument();
    });
  });

  describe('Responsive Behavior', () => {
    it('desktop: max 85% width', () => {
      mockUseIsMobile.mockReturnValue(false);

      const { container } = render(<AssistantMessageBubble {...createProps()} />);

      const contentWrapper = container.querySelector('.max-w-\\[85\\%\\]');
      expect(contentWrapper).toBeInTheDocument();
    });

    it('mobile: full width', () => {
      mockUseIsMobile.mockReturnValue(true);

      const { container } = render(<AssistantMessageBubble {...createProps()} />);

      const contentWrapper = container.querySelector('.w-full');
      expect(contentWrapper).toBeInTheDocument();
    });

    it('desktop: text content has gray bubble styling', () => {
      mockUseIsMobile.mockReturnValue(false);

      const { container } = render(<AssistantMessageBubble {...createProps()} />);

      const bubble = container.querySelector('.bg-gray-100');
      expect(bubble).toBeInTheDocument();
      expect(bubble).toHaveClass('rounded-2xl');
    });

    it('mobile: text content has transparent background', () => {
      mockUseIsMobile.mockReturnValue(true);

      const { container } = render(<AssistantMessageBubble {...createProps()} />);

      const bubble = container.querySelector('.bg-transparent');
      expect(bubble).toBeInTheDocument();
    });

    it('calls useIsMobile hook', () => {
      render(<AssistantMessageBubble {...createProps()} />);
      expect(mockUseIsMobile).toHaveBeenCalled();
    });
  });
});
