import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import LegacyAssistantBubble from '../LegacyAssistantBubble';
import { MessageRole } from '../../../types';
import type { Message, MessageMetadata } from '../../../types';
import type { LegacyAssistantBubbleProps } from '../types';

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

vi.mock('../../../utils/markdownRenderer', () => ({
  renderMarkdownSafe: (text: string) => `<div>${text}</div>`,
}));

vi.mock('../../../utils/alerts', () => ({
  showAlert: vi.fn(),
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
    id: 'msg_assistant_legacy_123',
    role: MessageRole.ASSISTANT,
    content: {
      type: 'text',
      content: 'Test legacy assistant response',
      // No renderingContent - this is the key difference
    },
    timestamp: new Date('2024-01-01T12:00:00Z'),
    ...overrides,
  };
}

// Helper function to create test props
function createProps(
  overrides: Partial<LegacyAssistantBubbleProps> = {}
): LegacyAssistantBubbleProps {
  return {
    message: createMessage(),
    ...overrides,
  };
}

describe('LegacyAssistantBubble', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseIsMobile.mockReturnValue(false);
  });

  describe('Basic Rendering', () => {
    it('renders content using markdown', () => {
      const props = createProps({
        message: createMessage({
          content: { type: 'text', content: 'Hello **world**' },
        }),
      });
      render(<LegacyAssistantBubble {...props} />);

      // Our mock renderMarkdownSafe wraps content in <div>
      expect(screen.getByText('Hello **world**')).toBeInTheDocument();
    });

    it('strips metadata from displayed content', () => {
      const props = createProps({
        message: createMessage({
          content: {
            type: 'text',
            content: '<metadata><timestamp>2024-01-01</timestamp></metadata>Hello!',
          },
        }),
      });
      render(<LegacyAssistantBubble {...props} />);

      expect(screen.getByText('Hello!')).toBeInTheDocument();
    });

    it('shows timestamp in metadata line', () => {
      const props = createProps({
        message: createMessage({
          timestamp: new Date('2024-01-01T12:00:00Z'),
        }),
      });
      render(<LegacyAssistantBubble {...props} />);

      expect(screen.getByText('2024-01-01')).toBeInTheDocument();
    });

    it('renders with prose styling', () => {
      const { container } = render(<LegacyAssistantBubble {...createProps()} />);

      const proseElement = container.querySelector('.prose');
      expect(proseElement).toBeInTheDocument();
    });
  });

  describe('Action Buttons', () => {
    it('shows Copy button', () => {
      render(<LegacyAssistantBubble {...createProps()} />);
      expect(screen.getByTitle('Copy message')).toBeInTheDocument();
    });

    it('shows Dump button', () => {
      render(<LegacyAssistantBubble {...createProps()} />);
      expect(screen.getByTitle('Copy message JSON')).toBeInTheDocument();
    });

    it('Copy button copies message text to clipboard', async () => {
      mockClipboard.writeText.mockResolvedValue(undefined);
      const props = createProps({
        message: createMessage({
          content: { type: 'text', content: 'Copy this legacy text' },
        }),
      });
      render(<LegacyAssistantBubble {...props} />);

      await userEvent.click(screen.getByTitle('Copy message'));

      expect(mockClipboard.writeText).toHaveBeenCalledWith('Copy this legacy text');
    });

    it('Dump button copies JSON to clipboard', async () => {
      mockClipboard.writeText.mockResolvedValue(undefined);
      const message = createMessage();
      const props = createProps({ message });
      render(<LegacyAssistantBubble {...props} />);

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
      render(<LegacyAssistantBubble {...props} />);

      expect(screen.getByText(/↑100/)).toBeInTheDocument();
    });

    it('displays output tokens', () => {
      const metadata: MessageMetadata = { outputTokens: 200 };
      const props = createProps({
        message: createMessage({ metadata }),
      });
      render(<LegacyAssistantBubble {...props} />);

      expect(screen.getByText(/↓200/)).toBeInTheDocument();
    });

    it('displays reasoning tokens', () => {
      const metadata: MessageMetadata = { reasoningTokens: 50 };
      const props = createProps({
        message: createMessage({ metadata }),
      });
      const { container } = render(<LegacyAssistantBubble {...props} />);

      const metadataLine = container.querySelector('.text-\\[10px\\]');
      expect(metadataLine?.textContent).toContain('R:50');
    });

    it('displays context window usage', () => {
      const metadata: MessageMetadata = { contextWindowUsage: 5000 };
      const props = createProps({
        message: createMessage({ metadata }),
      });
      render(<LegacyAssistantBubble {...props} />);

      expect(screen.getByText(/5\.0k/)).toBeInTheDocument();
    });

    it('displays message cost', () => {
      const metadata: MessageMetadata = { messageCost: 0.123456 };
      const props = createProps({
        message: createMessage({ metadata }),
      });
      render(<LegacyAssistantBubble {...props} />);

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
          },
        }),
      });
      render(<LegacyAssistantBubble {...props} />);

      expect(screen.getByTestId('stop-reason-badge')).toHaveTextContent('max_tokens');
    });

    it('does not show StopReasonBadge for end_turn', () => {
      const props = createProps({
        message: createMessage({
          content: {
            type: 'text',
            content: '',
            stopReason: 'end_turn',
          },
        }),
      });
      render(<LegacyAssistantBubble {...props} />);

      expect(screen.queryByTestId('stop-reason-badge')).not.toBeInTheDocument();
    });
  });

  describe('Responsive Behavior', () => {
    it('desktop: max 85% width with gray bubble', () => {
      mockUseIsMobile.mockReturnValue(false);

      const { container } = render(<LegacyAssistantBubble {...createProps()} />);

      const bubble = container.querySelector('.max-w-\\[85\\%\\].bg-gray-100');
      expect(bubble).toBeInTheDocument();
      expect(bubble).toHaveClass('rounded-2xl');
    });

    it('mobile: full width with transparent background', () => {
      mockUseIsMobile.mockReturnValue(true);

      const { container } = render(<LegacyAssistantBubble {...createProps()} />);

      const bubble = container.querySelector('.w-full.bg-transparent');
      expect(bubble).toBeInTheDocument();
    });

    it('calls useIsMobile hook', () => {
      render(<LegacyAssistantBubble {...createProps()} />);
      expect(mockUseIsMobile).toHaveBeenCalled();
    });
  });
});
