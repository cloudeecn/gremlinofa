import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import UserMessageBubble from '../UserMessageBubble';
import type { Message, MessageAttachment } from '../../../types';
import type { UserMessageBubbleProps } from '../types';

// Mock hooks - use vi.hoisted() to handle hoisting properly
const mockUseIsMobile = vi.hoisted(() => vi.fn());

vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: mockUseIsMobile,
}));

vi.mock('../../../utils/messageFormatters', () => ({
  stripMetadata: (content: string) => content.replace(/<metadata>.*?<\/metadata>/gs, ''),
  formatTimestamp: (date: Date) => date.toISOString().split('T')[0],
}));

vi.mock('../../../utils/alerts', () => ({
  showAlert: vi.fn(),
}));

// Mock navigator.clipboard
const mockClipboard = {
  writeText: vi.fn(),
};
Object.assign(navigator, { clipboard: mockClipboard });

// Helper function to create test messages
function createMessage(overrides: Partial<Message<unknown>> = {}): Message<unknown> {
  return {
    id: 'msg_user_123',
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
function createProps(overrides: Partial<UserMessageBubbleProps> = {}): UserMessageBubbleProps {
  return {
    message: createMessage(),
    attachments: [],
    onAction: vi.fn(),
    ...overrides,
  };
}

describe('UserMessageBubble', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseIsMobile.mockReturnValue(false);
  });

  describe('Basic Rendering', () => {
    it('renders with blue bubble styling', () => {
      const { container } = render(<UserMessageBubble {...createProps()} />);

      const bubble = container.querySelector('.bg-blue-600');
      expect(bubble).toBeInTheDocument();
      expect(bubble).toHaveClass('text-white', 'rounded-2xl');
    });

    it('renders right-aligned (flex-col items-end)', () => {
      const { container } = render(<UserMessageBubble {...createProps()} />);

      const wrapper = container.querySelector('.flex-col.items-end');
      expect(wrapper).toBeInTheDocument();
    });

    it('displays message content', () => {
      const props = createProps({
        message: createMessage({
          content: { type: 'text', content: 'Hello, world!' },
        }),
      });
      render(<UserMessageBubble {...props} />);

      expect(screen.getByText('Hello, world!')).toBeInTheDocument();
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
      render(<UserMessageBubble {...props} />);

      expect(screen.getByText('Hello!')).toBeInTheDocument();
      expect(screen.queryByText('<metadata>')).not.toBeInTheDocument();
    });

    it('shows timestamp in metadata line', () => {
      const props = createProps({
        message: createMessage({
          timestamp: new Date('2024-01-01T12:00:00Z'),
        }),
      });
      render(<UserMessageBubble {...props} />);

      expect(screen.getByText('2024-01-01')).toBeInTheDocument();
    });
  });

  describe('Attachments', () => {
    it('renders attachment thumbnails when present', () => {
      const attachments: MessageAttachment[] = [
        { id: 'att_1', type: 'image', mimeType: 'image/jpeg', data: 'base64data1' },
        { id: 'att_2', type: 'image', mimeType: 'image/png', data: 'base64data2' },
      ];

      const props = createProps({ attachments });
      const { container } = render(<UserMessageBubble {...props} />);

      const images = container.querySelectorAll('img');
      expect(images).toHaveLength(2);
      expect(images[0]).toHaveAttribute('src', 'data:image/jpeg;base64,base64data1');
      expect(images[1]).toHaveAttribute('src', 'data:image/png;base64,base64data2');
    });

    it('renders no thumbnails when attachments is empty', () => {
      const props = createProps({ attachments: [] });
      const { container } = render(<UserMessageBubble {...props} />);

      const images = container.querySelectorAll('img');
      expect(images).toHaveLength(0);
    });
  });

  describe('Action Buttons', () => {
    it('shows Edit button', () => {
      render(<UserMessageBubble {...createProps()} />);
      expect(screen.getByTitle('Edit message')).toBeInTheDocument();
    });

    it('shows Fork button', () => {
      render(<UserMessageBubble {...createProps()} />);
      expect(screen.getByTitle('Fork chat from here')).toBeInTheDocument();
    });

    it('shows Copy button', () => {
      render(<UserMessageBubble {...createProps()} />);
      expect(screen.getByTitle('Copy message')).toBeInTheDocument();
    });

    it('Edit button triggers onAction with edit action', async () => {
      const onAction = vi.fn();
      const props = createProps({
        message: createMessage({ id: 'msg_user_456' }),
        onAction,
      });
      render(<UserMessageBubble {...props} />);

      await userEvent.click(screen.getByTitle('Edit message'));

      expect(onAction).toHaveBeenCalledWith('edit', 'msg_user_456');
    });

    it('Fork button triggers onAction with fork action', async () => {
      const onAction = vi.fn();
      const props = createProps({
        message: createMessage({ id: 'msg_user_789' }),
        onAction,
      });
      render(<UserMessageBubble {...props} />);

      await userEvent.click(screen.getByTitle('Fork chat from here'));

      expect(onAction).toHaveBeenCalledWith('fork', 'msg_user_789');
    });

    it('Copy button copies message text to clipboard', async () => {
      mockClipboard.writeText.mockResolvedValue(undefined);
      const props = createProps({
        message: createMessage({
          content: { type: 'text', content: 'Copy this text' },
        }),
      });
      render(<UserMessageBubble {...props} />);

      await userEvent.click(screen.getByTitle('Copy message'));

      expect(mockClipboard.writeText).toHaveBeenCalledWith('Copy this text');
    });
  });

  describe('Responsive Behavior', () => {
    it('desktop: max 85% width', () => {
      mockUseIsMobile.mockReturnValue(false);

      const { container } = render(<UserMessageBubble {...createProps()} />);

      const bubble = container.querySelector('.max-w-\\[85\\%\\]');
      expect(bubble).toBeInTheDocument();
    });

    it('mobile: max 90% width', () => {
      mockUseIsMobile.mockReturnValue(true);

      const { container } = render(<UserMessageBubble {...createProps()} />);

      const bubble = container.querySelector('.max-w-\\[90\\%\\]');
      expect(bubble).toBeInTheDocument();
    });

    it('calls useIsMobile hook', () => {
      render(<UserMessageBubble {...createProps()} />);
      expect(mockUseIsMobile).toHaveBeenCalled();
    });
  });
});
