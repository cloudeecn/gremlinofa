import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import AssistantMessageBubble from '../AssistantMessageBubble';
import { showAlert } from '../../../lib/alerts';
import type { Message, MessageMetadata } from '../../../../shared/protocol/types';
import type { AssistantMessageBubbleProps } from '../types';

/** The info bar hides its action buttons and token detail until the trigger row is clicked. */
async function expandInfoBar() {
  await userEvent.click(screen.getByRole('button', { name: 'Message details' }));
}

vi.mock('../../../lib/messageFormatters', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../lib/messageFormatters')>()),
  stripMetadata: (content: string) => content.replace(/<metadata>.*?<\/metadata>/gs, ''),
  formatTimestamp: (date: Date) => date.toISOString().split('T')[0],
  formatTokens: (label: string, count?: number) => (count ? `${label}${count}` : ''),
  formatTokenCount: (count: number) => `${(count / 1000).toFixed(1)}k`,
  formatTokenGroup: (
    arrow: string,
    main?: number,
    extras?: { prefix: string; value?: number }[]
  ) => {
    if (!main) return '';
    const active = (extras || []).filter((e: { value?: number }) => e.value && e.value > 0);
    if (active.length === 0) return `${arrow}${main}`;
    const parts = [
      String(main),
      ...active.map((e: { prefix: string; value?: number }) => `${e.prefix}${e.value}`),
    ];
    return `${arrow}(${parts.join(', ')})`;
  },
}));

vi.mock('../../../lib/alerts', () => ({
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
  default: ({ blocks, disableMath }: { blocks: unknown[]; disableMath?: boolean }) => (
    <div data-testid="text-group-view">
      TextGroupView: {blocks.length} blocks, math: {disableMath ? 'off' : 'on'}
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
    role: 'assistant',
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
    ...overrides,
  };
}

describe('AssistantMessageBubble', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    it('passes disableMath to TextGroupView', () => {
      const props = createProps({ disableMath: true });
      render(<AssistantMessageBubble {...props} />);

      expect(screen.getByTestId('text-group-view')).toHaveTextContent('math: off');
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

    it('renders without crashing when renderingContent is missing (legacy message)', async () => {
      const props = createProps({
        message: createMessage({
          content: {
            type: 'text',
            content: 'Legacy message text',
          },
        }),
      });
      render(<AssistantMessageBubble {...props} />);

      // No content groups, but the info bar still renders
      expect(screen.queryByTestId('text-group-view')).not.toBeInTheDocument();
      await expandInfoBar();
      expect(screen.getByTitle('Copy message')).toBeInTheDocument();
    });
  });

  describe('Action Buttons', () => {
    it('keeps Copy on the trigger row and the rest behind it', async () => {
      render(<AssistantMessageBubble {...createProps()} />);
      expect(screen.getByTitle('Copy message')).toBeInTheDocument();
      expect(screen.queryByTitle('Copy message JSON')).not.toBeInTheDocument();
      await expandInfoBar();
      expect(screen.getByTitle('Copy message JSON')).toBeInTheDocument();
    });

    it('shows Dump button', async () => {
      render(<AssistantMessageBubble {...createProps()} />);
      await expandInfoBar();
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
      // Inline ✓, no dialog
      expect(await screen.findByTitle('Copied')).toHaveTextContent('✓');
      expect(showAlert).not.toHaveBeenCalled();
    });

    it('Dump button copies JSON to clipboard', async () => {
      mockClipboard.writeText.mockResolvedValue(undefined);
      const message = createMessage();
      const props = createProps({ message });
      render(<AssistantMessageBubble {...props} />);
      await expandInfoBar();

      await userEvent.click(screen.getByTitle('Copy message JSON'));

      expect(mockClipboard.writeText).toHaveBeenCalled();
      const clipboardContent = mockClipboard.writeText.mock.calls[0][0];
      const parsed = JSON.parse(clipboardContent);
      expect(parsed.id).toBe(message.id);
    });
  });

  describe('Metadata Display', () => {
    it('keeps token detail off the trigger row until expanded', async () => {
      const metadata: MessageMetadata = { inputTokens: 100, outputTokens: 200 };
      const props = createProps({
        message: createMessage({ metadata }),
      });
      render(<AssistantMessageBubble {...props} />);

      expect(screen.queryByText(/↑100/)).not.toBeInTheDocument();
      await expandInfoBar();
      expect(screen.getByText(/↑100/)).toBeInTheDocument();
    });

    it('displays input tokens', async () => {
      const metadata: MessageMetadata = { inputTokens: 100 };
      const props = createProps({
        message: createMessage({ metadata }),
      });
      render(<AssistantMessageBubble {...props} />);
      await expandInfoBar();

      expect(screen.getByText(/↑100/)).toBeInTheDocument();
    });

    it('displays output tokens', async () => {
      const metadata: MessageMetadata = { outputTokens: 200 };
      const props = createProps({
        message: createMessage({ metadata }),
      });
      render(<AssistantMessageBubble {...props} />);
      await expandInfoBar();

      expect(screen.getByText(/↓200/)).toBeInTheDocument();
    });

    it('displays reasoning tokens grouped with output', async () => {
      const metadata: MessageMetadata = { outputTokens: 200, reasoningTokens: 50 };
      const props = createProps({
        message: createMessage({ metadata }),
      });
      const { container } = render(<AssistantMessageBubble {...props} />);
      await expandInfoBar();

      expect(container).toHaveTextContent('↓(200, R:50)');
    });

    it('displays cache creation tokens grouped with input', async () => {
      const metadata: MessageMetadata = { inputTokens: 100, cacheCreationTokens: 30 };
      const props = createProps({
        message: createMessage({ metadata }),
      });
      const { container } = render(<AssistantMessageBubble {...props} />);
      await expandInfoBar();

      expect(container).toHaveTextContent('↑(100, C↑30)');
    });

    it('displays cache read tokens grouped with input', async () => {
      const metadata: MessageMetadata = { inputTokens: 100, cacheReadTokens: 40 };
      const props = createProps({
        message: createMessage({ metadata }),
      });
      const { container } = render(<AssistantMessageBubble {...props} />);
      await expandInfoBar();

      expect(container).toHaveTextContent('↑(100, C↓40)');
    });

    it('displays context window usage on the trigger row', () => {
      const metadata: MessageMetadata = { contextWindowUsage: 12500, contextWindow: 200000 };
      const props = createProps({
        message: createMessage({ metadata }),
      });
      render(<AssistantMessageBubble {...props} />);

      expect(screen.getByRole('button', { name: 'Message details' })).toHaveTextContent(
        '12.5k/200.0k'
      );
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

  describe('Model Display', () => {
    it('shows the served model on the trigger row, red when it differs from the requested one', () => {
      const metadata: MessageMetadata = { model: 'gpt-5', servedModel: 'gpt-5-2026-08-01' };
      render(<AssistantMessageBubble {...createProps({ message: createMessage({ metadata }) })} />);

      const modelEl = screen.getByTestId('info-bar-model');
      expect(modelEl).toHaveTextContent('gpt-5-2026-08-01');
      expect(modelEl).toHaveClass('text-red-600');
      expect(modelEl).toHaveAttribute('title', 'gpt-5 → gpt-5-2026-08-01');
    });

    it('shows "-" (never the requested id) when no served model was recorded', () => {
      const metadata: MessageMetadata = { model: 'gpt-5' };
      render(<AssistantMessageBubble {...createProps({ message: createMessage({ metadata }) })} />);

      const modelEl = screen.getByTestId('info-bar-model');
      expect(modelEl).toHaveTextContent('-');
      expect(modelEl).not.toHaveTextContent('gpt-5');
      expect(modelEl).not.toHaveClass('text-red-600');
    });

    it('shows "-" for legacy messages with no model metadata at all', () => {
      render(
        <AssistantMessageBubble {...createProps({ message: createMessage({ metadata: {} }) })} />
      );

      expect(screen.getByTestId('info-bar-model')).toHaveTextContent('-');
    });

    it('stays gray when served and requested match', () => {
      const metadata: MessageMetadata = { model: 'claude-opus-5', servedModel: 'claude-opus-5' };
      render(<AssistantMessageBubble {...createProps({ message: createMessage({ metadata }) })} />);

      expect(screen.getByTestId('info-bar-model')).not.toHaveClass('text-red-600');
    });

    it('truncates long model ids to 16 characters and keeps the full id in the title', () => {
      const metadata: MessageMetadata = {
        model: 'claude-fable-5-1-20260901',
        servedModel: 'claude-fable-5-1-20260901',
      };
      render(<AssistantMessageBubble {...createProps({ message: createMessage({ metadata }) })} />);

      const modelEl = screen.getByTestId('info-bar-model');
      expect(modelEl).toHaveTextContent('claude-fable-5-…');
      expect(modelEl).toHaveAttribute('title', 'claude-fable-5-1-20260901');
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

  describe('Styling', () => {
    it('content wrapper has full width', () => {
      const { container } = render(<AssistantMessageBubble {...createProps()} />);

      const contentWrapper = container.querySelector('.w-full');
      expect(contentWrapper).toBeInTheDocument();
    });

    it('text content has transparent background (no bubble)', () => {
      const { container } = render(<AssistantMessageBubble {...createProps()} />);

      const textContainer = container.querySelector('.bg-transparent');
      expect(textContainer).toBeInTheDocument();
    });
  });
});
