import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MinionChatView from '../MinionChatView';
import type { MinionChat, Message, TokenUsage } from '../../../types';

// Mock useIsMobile
vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

// Track what useMinionChat returns
const mockUseMinionChat = vi.fn();
vi.mock('../../../hooks/useMinionChat', () => ({
  useMinionChat: (...args: unknown[]) => mockUseMinionChat(...args),
}));

// Mock MessageList
vi.mock('../MessageList', () => ({
  default: ({ messages, onAction }: { messages: Message<unknown>[]; onAction?: unknown }) => (
    <div data-testid="message-list">
      <span data-testid="message-count">{messages.length}</span>
      <span data-testid="has-on-action">{onAction ? 'true' : 'false'}</span>
    </div>
  ),
}));

const mockMinionChat: MinionChat = {
  id: 'mc_test',
  parentChatId: 'chat_parent',
  projectId: 'proj_1',
  createdAt: new Date('2025-01-01'),
  lastModifiedAt: new Date('2025-01-01'),
  totalInputTokens: 5000,
  totalOutputTokens: 2000,
  totalCost: 0.05,
};

const mockMessages: Message<unknown>[] = [
  {
    id: 'msg_1',
    role: 'user',
    content: { type: 'text', content: 'Do the thing' },
    timestamp: new Date(),
  },
  {
    id: 'msg_2',
    role: 'assistant',
    content: { type: 'text', content: 'Done' },
    timestamp: new Date(),
  },
];

const mockTokenUsage: TokenUsage = {
  input: 5000,
  output: 2000,
  cost: 0.05,
};

function renderView(minionChatId = 'mc_test', onMenuPress?: () => void, onClose?: () => void) {
  return render(
    <MemoryRouter>
      <MinionChatView minionChatId={minionChatId} onMenuPress={onMenuPress} onClose={onClose} />
    </MemoryRouter>
  );
}

describe('MinionChatView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMinionChat.mockReturnValue({
      minionChat: mockMinionChat,
      messages: mockMessages,
      isLoading: false,
      tokenUsage: mockTokenUsage,
    });
  });

  it('renders header with title and chat ID', () => {
    renderView();
    expect(screen.getByText('Minion Chat')).toBeInTheDocument();
    expect(screen.getByText('mc_test')).toBeInTheDocument();
  });

  it('renders token usage info bar', () => {
    renderView();
    expect(screen.getByText(/↑5000/)).toBeInTheDocument();
    expect(screen.getByText(/↓2000/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.050/)).toBeInTheDocument();
  });

  it('renders MessageList without onAction (read-only)', () => {
    renderView();
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
    expect(screen.getByTestId('message-count').textContent).toBe('2');
    expect(screen.getByTestId('has-on-action').textContent).toBe('false');
  });

  it('does not render ChatInput', () => {
    renderView();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('renders back button', () => {
    renderView();
    expect(screen.getByTitle('Back to parent chat')).toBeInTheDocument();
  });

  it('renders close button', () => {
    renderView();
    expect(screen.getByText('✕')).toBeInTheDocument();
  });

  it('passes minionChatId to useMinionChat hook', () => {
    renderView('mc_custom');
    expect(mockUseMinionChat).toHaveBeenCalledWith('mc_custom');
  });

  it('shows unreliable cost indicator when set', () => {
    mockUseMinionChat.mockReturnValue({
      minionChat: { ...mockMinionChat, costUnreliable: true },
      messages: [],
      isLoading: false,
      tokenUsage: mockTokenUsage,
    });
    renderView();
    expect(screen.getByText('(unreliable)')).toBeInTheDocument();
  });

  it('calls onClose when back button is clicked and onClose is provided', () => {
    const onClose = vi.fn();
    renderView('mc_test', undefined, onClose);
    fireEvent.click(screen.getByTitle('Back to parent chat'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when close button is clicked and onClose is provided', () => {
    const onClose = vi.fn();
    renderView('mc_test', undefined, onClose);
    fireEvent.click(screen.getByText('✕'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
