import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MinionChatView from '../MinionChatView';
import type { MinionChat, Message, TokenUsage } from '../../../../shared/protocol/types';

// Mock useIsMobile
vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

// Track what useMinionChat returns
const mockUseMinionChat = vi.fn();
vi.mock('../../../hooks/useMinionChat', () => ({
  useMinionChat: (...args: unknown[]) => mockUseMinionChat(...args),
}));

// Mock MessageList — capture onDeleteMessage
let capturedOnDeleteMessage: ((messageId: string) => void) | undefined;
vi.mock('../MessageList', () => ({
  default: ({
    messages,
    onAction,
    actions,
    onDeleteMessage,
    isClaudeAgentChat,
    disableMath,
  }: {
    messages: Message<unknown>[];
    onAction?: unknown;
    actions?: ReadonlySet<string>;
    onDeleteMessage?: (messageId: string) => void;
    isClaudeAgentChat?: boolean;
    disableMath?: boolean;
  }) => {
    capturedOnDeleteMessage = onDeleteMessage;
    return (
      <div data-testid="message-list">
        <span data-testid="message-count">{messages.length}</span>
        <span data-testid="has-on-action">{onAction ? 'true' : 'false'}</span>
        <span data-testid="actions">{actions ? [...actions].join(',') : 'all'}</span>
        <span data-testid="has-on-delete">{onDeleteMessage ? 'true' : 'false'}</span>
        <span data-testid="is-claude-agent">{isClaudeAgentChat ? 'true' : 'false'}</span>
        <span data-testid="disable-math">{disableMath ? 'true' : 'false'}</span>
      </div>
    );
  },
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

const mockDeleteMessage = vi.fn();
const mockRollbackToMessage = vi.fn();
const mockCloneToChat = vi.fn();

function renderView(
  minionChatId = 'mc_test',
  onMenuPress?: () => void,
  onClose?: () => void,
  live?: boolean
) {
  return render(
    <MemoryRouter>
      <MinionChatView
        minionChatId={minionChatId}
        onMenuPress={onMenuPress}
        onClose={onClose}
        live={live}
      />
    </MemoryRouter>
  );
}

describe('MinionChatView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnDeleteMessage = undefined;
    mockDeleteMessage.mockResolvedValue(undefined);
    mockRollbackToMessage.mockResolvedValue(undefined);
    mockCloneToChat.mockResolvedValue({ newChatId: 'chat_new', notes: [] });
    mockUseMinionChat.mockReturnValue({
      minionChat: mockMinionChat,
      messages: mockMessages,
      isLoading: false,
      tokenUsage: mockTokenUsage,
      deleteMessage: mockDeleteMessage,
      rollbackToMessage: mockRollbackToMessage,
      cloneToChat: mockCloneToChat,
      isCloning: false,
    });
  });

  it('titles an unnamed minion "Minion chat", with the id as a tooltip', () => {
    renderView();
    const title = screen.getByRole('heading', { name: 'Minion chat' });
    expect(title).toHaveAttribute('title', 'mc_test');
    expect(screen.queryByText('mc_test')).not.toBeInTheDocument();
  });

  it('titles a named minion by its display name, with the persona below', () => {
    mockUseMinionChat.mockReturnValue({
      ...mockUseMinionChat(),
      minionChat: { ...mockMinionChat, displayName: 'Researcher', persona: 'scout' },
    });
    renderView();
    expect(screen.getByRole('heading', { name: 'Researcher' })).toBeInTheDocument();
    expect(screen.getByText('Minion chat · scout')).toBeInTheDocument();
  });

  it('offers only rollback to the message list (Edit and Fork have no minion flow)', () => {
    renderView();
    expect(screen.getByTestId('actions').textContent).toBe('rollback');
  });

  it("passes the parent chat's Disable Math option to the message list", () => {
    render(
      <MemoryRouter>
        <MinionChatView minionChatId="mc_test" disableMath />
      </MemoryRouter>
    );
    expect(screen.getByTestId('disable-math').textContent).toBe('true');
  });

  it('closes on Escape when shown as an overlay', () => {
    const onClose = vi.fn();
    renderView('mc_test', undefined, onClose);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('renders token usage info bar', () => {
    renderView();
    expect(screen.getByText(/↑5000/)).toBeInTheDocument();
    expect(screen.getByText(/↓2000/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.050/)).toBeInTheDocument();
  });

  it('renders MessageList with onAction and onDeleteMessage', () => {
    renderView();
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
    expect(screen.getByTestId('message-count').textContent).toBe('2');
    expect(screen.getByTestId('has-on-action').textContent).toBe('true');
    expect(screen.getByTestId('has-on-delete').textContent).toBe('true');
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
    renderView('mc_custom', undefined, undefined, true);
    expect(mockUseMinionChat).toHaveBeenCalledWith('mc_custom', { live: true });
  });

  it('shows unreliable cost indicator when set', () => {
    mockUseMinionChat.mockReturnValue({
      minionChat: { ...mockMinionChat, costUnreliable: true },
      messages: [],
      isLoading: false,
      tokenUsage: mockTokenUsage,
      deleteMessage: mockDeleteMessage,
      rollbackToMessage: mockRollbackToMessage,
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

  it('passes onDeleteMessage to MessageList', () => {
    renderView();
    expect(capturedOnDeleteMessage).toBeTypeOf('function');
  });

  it('marks the chat as non-claude-agent and keeps delete for ordinary minions', () => {
    renderView();
    expect(screen.getByTestId('is-claude-agent').textContent).toBe('false');
    expect(screen.getByTestId('has-on-delete').textContent).toBe('true');
  });

  it('hides single-message delete and flags claude-agent when the minion has an SDK session', () => {
    mockUseMinionChat.mockReturnValue({
      minionChat: { ...mockMinionChat, claudeAgentSessionId: 'sess-1' },
      messages: mockMessages,
      isLoading: false,
      tokenUsage: mockTokenUsage,
      deleteMessage: mockDeleteMessage,
      rollbackToMessage: mockRollbackToMessage,
    });
    renderView();
    expect(screen.getByTestId('is-claude-agent').textContent).toBe('true');
    expect(screen.getByTestId('has-on-delete').textContent).toBe('false');
    expect(capturedOnDeleteMessage).toBeUndefined();
  });
});

describe('MinionChatView remote (human) minion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnDeleteMessage = undefined;
    mockUseMinionChat.mockReturnValue({
      minionChat: { ...mockMinionChat, remote: true, remoteSessionId: 'tg_1' },
      messages: mockMessages,
      isLoading: false,
      tokenUsage: mockTokenUsage,
      isRemote: true,
      deleteMessage: mockDeleteMessage,
      rollbackToMessage: mockRollbackToMessage,
      cloneToChat: mockCloneToChat,
      isCloning: false,
    });
  });

  it('hides rollback and delete so the local copy keeps matching the backend', () => {
    renderView();
    expect(screen.getByTestId('has-on-action').textContent).toBe('false');
    expect(screen.getByTestId('has-on-delete').textContent).toBe('false');
    expect(capturedOnDeleteMessage).toBeUndefined();
  });

  it('labels the transcript read-only and explains why on hover', () => {
    renderView();
    const badge = screen.getByText(/Human minion · read-only/);
    expect(badge.getAttribute('title')).toMatch(/Touch Grass/);
  });

  it('shows no read-only label for an ordinary minion', () => {
    mockUseMinionChat.mockReturnValue({
      minionChat: mockMinionChat,
      messages: mockMessages,
      isLoading: false,
      tokenUsage: mockTokenUsage,
      isRemote: false,
      deleteMessage: mockDeleteMessage,
      rollbackToMessage: mockRollbackToMessage,
      cloneToChat: mockCloneToChat,
      isCloning: false,
    });
    renderView();
    expect(screen.queryByText(/read-only/)).toBeNull();
    expect(screen.getByTestId('has-on-action').textContent).toBe('true');
  });
});
