import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Chat, Project } from '../../../../shared/protocol/types';
import type { ActiveLoop } from '../../../../shared/protocol/protocol';

/**
 * ProjectView with the real useProject hook. Regression guards for plans/08
 * §7: typing in the new-chat box must not re-render the memoized chat rows,
 * and opening Project Settings navigates from the click, not from render.
 */

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mockNavigate,
}));

/** Stand-in for activeLoopsStore: running loops plus relayed chat rows */
const liveLoops = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const chatListeners = new Set<(chat: Chat) => void>();
  const state = {
    loops: [] as ActiveLoop[],
    listeners,
    chatListeners,
    setLoops(loops: ActiveLoop[]) {
      state.loops = loops;
      listeners.forEach(listener => listener());
    },
    emitChat: (chat: Chat) => chatListeners.forEach(listener => listener(chat)),
  };
  return state;
});

vi.mock('../../../client', () => ({
  gremlinClient: {
    getProject: vi.fn(),
    getChats: vi.fn(),
    getVfsAdapter: vi.fn(() => ({})),
    deleteChat: vi.fn(),
    saveChat: vi.fn(),
    startLoop: vi.fn(),
  },
  activeLoopsStore: {
    subscribe: (listener: () => void) => {
      liveLoops.listeners.add(listener);
      return () => liveLoops.listeners.delete(listener);
    },
    getSnapshot: () => liveLoops.loops,
    onChatUpdated: (listener: (chat: Chat) => void) => {
      liveLoops.chatListeners.add(listener);
      return () => liveLoops.chatListeners.delete(listener);
    },
  },
}));

vi.mock('../../../hooks/useApp', () => {
  const actions = {
    // Echoes the backend's merged row, which updateProject adopts
    patchProject: vi.fn(async (_id: string, fields: Partial<Project>) => ({
      ...project,
      ...fields,
    })),
    deleteProject: vi.fn(),
  };
  const apiDefinitions: never[] = [];
  return { useAppActions: () => actions, useApiDefinitions: () => apiDefinitions };
});

vi.mock('../../../hooks/useAlert', () => {
  const alerts = { showAlert: vi.fn(), showDestructiveConfirm: vi.fn() };
  return { useAlert: () => alerts };
});

vi.mock('../../../lib/alerts', () => ({ showAlert: vi.fn() }));

vi.mock('../../../hooks/useIsTouchDevice', () => ({ useIsTouchDevice: () => false }));
vi.mock('../ModelSelector', () => ({ default: () => null }));
const modalSaves = vi.hoisted(() => ({
  systemPrompt: null as ((value: string) => Promise<boolean>) | null,
  nameIcon: null as ((updated: Project) => Promise<void>) | null,
}));
vi.mock('../SystemPromptModal', () => ({
  default: (props: { onSave: (value: string) => Promise<boolean> }) => {
    modalSaves.systemPrompt = props.onSave;
    return null;
  },
}));
vi.mock('../ProjectNameIconModal', () => ({
  default: (props: { onSave: (updated: Project) => Promise<void> }) => {
    modalSaves.nameIcon = props.onSave;
    return null;
  },
}));
vi.mock('../CompactModal', () => ({ default: () => null }));
vi.mock('../ExportProjectModal', () => ({ default: () => null }));

import ProjectView from '../ProjectView';
import { gremlinClient } from '../../../client';
import { useAppActions } from '../../../hooks/useApp';
import { useAlert } from '../../../hooks/useAlert';
import { showAlert as showModuleAlert } from '../../../lib/alerts';
import { ProtocolError } from '../../../../shared/protocol/protocolError';

const project: Project = {
  id: 'p1',
  name: 'Project',
  icon: '📁',
  createdAt: new Date(2026, 0, 1),
  lastUsedAt: new Date(2026, 0, 1),
  apiDefinitionId: 'api_1',
  modelId: 'model_1',
  systemPrompt: '',
  preFillResponse: '',
  webSearchEnabled: false,
  temperature: 1,
  maxOutputTokens: 1024,
  enableReasoning: false,
  reasoningBudgetTokens: 0,
};

const rowRenders = { count: 0 };

/** Each ChatListItem render reads `chat.name` once, so a getter counts them. */
function buildChats(count: number): Chat[] {
  return Array.from({ length: count }, (_, i) => {
    const name = `Chat ${i}`;
    return {
      id: `chat_${i}`,
      projectId: 'p1',
      get name() {
        rowRenders.count++;
        return name;
      },
      createdAt: new Date(2026, 0, 1),
      lastModifiedAt: new Date(2026, 0, 1),
      apiDefinitionId: null,
      modelId: null,
    } as Chat;
  });
}

describe('ProjectView', () => {
  beforeEach(() => {
    vi.mocked(gremlinClient.getProject).mockResolvedValue(project);
    vi.mocked(gremlinClient.getChats).mockResolvedValue(buildChats(50));
    vi.mocked(gremlinClient.saveChat).mockReset().mockResolvedValue(undefined);
    vi.mocked(gremlinClient.startLoop).mockReset().mockResolvedValue({ loopId: 'loop_1' });
    vi.mocked(useAlert().showAlert).mockClear();
    vi.mocked(showModuleAlert).mockClear();
    mockNavigate.mockClear();
    rowRenders.count = 0;
    liveLoops.loops = [];
  });

  const composer = () => screen.getByPlaceholderText('Type your message here...');

  async function typeAndSend(text: string) {
    await act(async () => fireEvent.change(composer(), { target: { value: text } }));
    await act(async () => fireEvent.keyDown(composer(), { key: 'Enter' }));
  }

  it('starts the chat, then clears the composer and opens the chat', async () => {
    render(<ProjectView projectId="p1" />);
    await screen.findByText('Chat 0');

    await typeAndSend('hello');

    const chat = vi.mocked(gremlinClient.saveChat).mock.calls[0][0];
    expect(gremlinClient.startLoop).toHaveBeenCalledWith({
      chatId: chat.id,
      mode: 'send',
      content: 'hello',
      attachments: undefined,
    });
    expect(mockNavigate).toHaveBeenCalledWith(`/chat/${chat.id}`);
    expect(composer()).toHaveValue('');
  });

  it('keeps the text, alerts and stays when the loop does not start', async () => {
    vi.mocked(gremlinClient.startLoop).mockRejectedValueOnce(
      new ProtocolError('CHAT_BUSY', 'busy')
    );
    render(<ProjectView projectId="p1" />);
    await screen.findByText('Chat 0');

    await typeAndSend('hello');

    expect(composer()).toHaveValue('hello');
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(useAlert().showAlert).toHaveBeenCalledWith(
      'Chat not started',
      expect.stringContaining('already has a reply running')
    );
  });

  it('retries on the chat it already created instead of making another', async () => {
    vi.mocked(gremlinClient.startLoop).mockRejectedValueOnce(new Error('socket closed'));
    render(<ProjectView projectId="p1" />);
    await screen.findByText('Chat 0');

    await typeAndSend('hello');
    await act(async () => fireEvent.keyDown(composer(), { key: 'Enter' }));

    expect(gremlinClient.saveChat).toHaveBeenCalledTimes(1);
    const chatId = vi.mocked(gremlinClient.saveChat).mock.calls[0][0].id;
    expect(gremlinClient.startLoop).toHaveBeenCalledTimes(2);
    expect(vi.mocked(gremlinClient.startLoop).mock.calls[1][0].chatId).toBe(chatId);
    expect(mockNavigate).toHaveBeenCalledWith(`/chat/${chatId}`);
  });

  it('creates a new chat on retry when the text changed', async () => {
    vi.mocked(gremlinClient.startLoop).mockRejectedValueOnce(new Error('socket closed'));
    render(<ProjectView projectId="p1" />);
    await screen.findByText('Chat 0');

    await typeAndSend('hello');
    await typeAndSend('hello again');

    expect(gremlinClient.saveChat).toHaveBeenCalledTimes(2);
  });

  it('ignores a second Enter while the chat is starting', async () => {
    let finishStart: () => void = () => {};
    vi.mocked(gremlinClient.startLoop).mockReturnValueOnce(
      new Promise(resolve => {
        finishStart = () => resolve({ loopId: 'loop_1' });
      })
    );
    render(<ProjectView projectId="p1" />);
    await screen.findByText('Chat 0');

    await typeAndSend('hello');
    expect(composer()).toHaveAttribute('readonly');
    await act(async () => fireEvent.keyDown(composer(), { key: 'Enter' }));
    await act(async () => finishStart());

    expect(gremlinClient.saveChat).toHaveBeenCalledTimes(1);
    expect(gremlinClient.startLoop).toHaveBeenCalledTimes(1);
  });

  it('does not send on the Enter that confirms an IME candidate', async () => {
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
      frames.push(cb);
      return frames.length;
    });
    render(<ProjectView projectId="p1" />);
    await screen.findByText('Chat 0');

    await act(async () => fireEvent.change(composer(), { target: { value: 'こんにちは' } }));
    fireEvent.compositionEnd(composer());
    await act(async () => fireEvent.keyDown(composer(), { key: 'Enter' }));

    expect(gremlinClient.saveChat).not.toHaveBeenCalled();
    raf.mockRestore();
  });

  it('typing in the new-chat box re-renders no chat rows', async () => {
    render(<ProjectView projectId="p1" />);
    await screen.findByText('Chat 49');

    rowRenders.count = 0;
    const textarea = screen.getByPlaceholderText('Type your message here...');
    for (const text of ['h', 'he', 'hel', 'hell', 'hello']) {
      fireEvent.change(textarea, { target: { value: text } });
    }

    expect(textarea).toHaveValue('hello');
    expect(rowRenders.count).toBe(0);
  });

  it('navigates to settings once, from the menu click, under StrictMode', async () => {
    render(
      <StrictMode>
        <ProjectView projectId="p1" />
      </StrictMode>
    );
    await screen.findByText('Chat 0');

    fireEvent.click(screen.getByText('🔧'));
    await act(async () => {
      fireEvent.click(screen.getByText('Project Settings'));
    });

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/project/p1/settings');
    expect(screen.queryByText('Project Settings')).not.toBeInTheDocument();
  });

  it('goes home from the bottom of the 🔧 menu', async () => {
    render(<ProjectView projectId="p1" />);
    await screen.findByText('Chat 0');

    fireEvent.click(screen.getByText('🔧'));
    fireEvent.click(screen.getByText('Home'));

    expect(mockNavigate).toHaveBeenCalledWith('/');
    expect(screen.queryByText('Home')).not.toBeInTheDocument();
  });

  describe('running chats', () => {
    const loopOn = (chatId: string): ActiveLoop => ({
      loopId: `loop_${chatId}`,
      chatId,
      startedAt: 0,
      status: 'running',
      apiDefinitionId: 'api_1',
      modelId: 'model_1',
    });
    const rowOf = (name: string) =>
      screen.getByRole('heading', { name }).parentElement!.parentElement!;

    it('breathes green on a chat with a running loop until the loop ends', async () => {
      vi.mocked(gremlinClient.getChats).mockResolvedValue(buildChats(3));
      liveLoops.loops = [loopOn('chat_1')];
      render(<ProjectView projectId="p1" />);
      await screen.findByText('Chat 2');

      expect(rowOf('Chat 1')).toHaveClass('animate-running-border');
      expect(rowOf('Chat 0')).not.toHaveClass('animate-running-border');
      expect(rowOf('Chat 0')).toHaveClass('border-gray-200');
      expect(screen.getAllByText('Agent loop running.')).toHaveLength(1);

      act(() => liveLoops.setLoops([]));

      expect(rowOf('Chat 1')).not.toHaveClass('animate-running-border');
      expect(screen.queryByText('Agent loop running.')).not.toBeInTheDocument();
    });

    it("shows a running chat's live stats, re-rendering only its row", async () => {
      const chats = buildChats(3);
      vi.mocked(gremlinClient.getChats).mockResolvedValue(chats);
      liveLoops.loops = [loopOn('chat_1')];
      render(<ProjectView projectId="p1" />);
      await screen.findByText('Chat 2');

      const lastModifiedAt = new Date(2026, 9, 10);
      const live: Chat = {
        ...chats[1],
        name: 'Chat 1',
        lastModifiedAt,
        messageCount: 12,
        contextWindowUsage: 3456,
        totalCost: 0.25,
      };
      rowRenders.count = 0;
      act(() => liveLoops.emitChat(live));

      expect(rowOf('Chat 1')).toHaveTextContent(
        `${lastModifiedAt.toLocaleDateString()} • 12 msgs • ctx: 3456 • $0.2500`
      );
      // The other rows' getter-backed names weren't read again
      expect(rowRenders.count).toBe(0);
    });
  });

  // jsdom has no layout, so this pins the classes that keep an unbreakable title from
  // setting the row's min-content width (iPhone horizontal scrollbar).
  it('truncates a chat title with an unbreakable token instead of widening the row', async () => {
    const longName = '/minion minion_v53raviwxlqzz24rbwpwoi435eqoll2ivb';
    vi.mocked(gremlinClient.getChats).mockResolvedValue([
      { ...buildChats(1)[0], name: longName } as Chat,
    ]);
    render(<ProjectView projectId="p1" />);

    const title = await screen.findByRole('heading', { name: longName });
    expect(title).toHaveClass('truncate');
    expect(title.parentElement).toHaveClass('min-w-0', 'flex-1');
  });

  it('keeps the system prompt modal open when the save fails', async () => {
    const { patchProject } = useAppActions();
    vi.mocked(patchProject).mockRejectedValueOnce(new Error('offline'));
    render(<ProjectView projectId="p1" />);
    await screen.findByText('Chat 0');

    let saved: boolean | undefined;
    await act(async () => {
      saved = await modalSaves.systemPrompt!('Be terse.');
    });

    expect(saved).toBe(false);
    expect(showModuleAlert).toHaveBeenCalledWith('Project not saved', 'offline');
  });

  it('the system prompt and name/icon modals patch only the fields they edit', async () => {
    const { patchProject } = useAppActions();
    render(<ProjectView projectId="p1" />);
    await screen.findByText('Chat 0');

    await act(async () => {
      await modalSaves.systemPrompt!('Be terse.');
    });
    expect(patchProject).toHaveBeenLastCalledWith(
      'p1',
      { systemPrompt: 'Be terse.' },
      { touch: true }
    );

    await act(async () => {
      await modalSaves.nameIcon!({ ...project, name: 'Renamed', icon: '🦊', systemPrompt: '' });
    });
    expect(patchProject).toHaveBeenLastCalledWith(
      'p1',
      { name: 'Renamed', icon: '🦊' },
      { touch: true }
    );
  });
});
