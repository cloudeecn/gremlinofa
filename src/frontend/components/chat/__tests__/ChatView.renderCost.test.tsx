import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Message } from '../../../../shared/protocol/types';

/**
 * ChatView with the real message list. Regression guard for plans/08 §1:
 * typing in the chat input must not re-render (and re-parse the markdown of)
 * messages that didn't change. Also covers sending from deep in history, and
 * the composer / ⋯ menu behavior from §6 (edit on resend, remembered view
 * options, Escape, dropped images).
 */

const markdownCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../../lib/markdownRenderer', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../lib/markdownRenderer')>();
  return {
    ...actual,
    renderMarkdownSafe: (content: string, options?: { disableMath?: boolean }) => {
      markdownCalls.count++;
      return actual.renderMarkdownSafe(content, options);
    },
  };
});

vi.mock('../../../client', () => ({
  gremlinClient: {
    getAttachments: vi.fn().mockResolvedValue([]),
  },
  activeLoopsStore: { getSnapshot: () => [] },
}));

vi.mock('../../../lib/imageProcessor', () => ({
  processImages: vi.fn(async () => ({ attachments: [], errors: [] })),
}));

vi.mock('../../../hooks/useApp', () => {
  const apiDefinitions: never[] = [];
  const models = new Map();
  return { useApiDefinitions: () => apiDefinitions, useModels: () => models };
});

const chatState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../../../hooks/useChat', () => ({
  useChat: () => chatState.current,
}));

import ChatView from '../ChatView';
import { processImages } from '../../../lib/imageProcessor';

const markdown = [
  '## Heading',
  'Some **bold** text with `code` and a [link](https://example.com).',
  '```ts\nconst x: number = 1;\n```',
  '- one\n- two',
].join('\n\n');

function buildMessages(pairs: number): Message<unknown>[] {
  const messages: Message<unknown>[] = [];
  for (let i = 0; i < pairs; i++) {
    messages.push({
      id: `u${i}`,
      role: 'user',
      timestamp: new Date(2026, 0, 1),
      content: {
        type: 'text',
        content: `question ${i}`,
        renderingContent: [{ category: 'text', blocks: [{ type: 'text', text: `question ${i}` }] }],
      },
    } as Message<unknown>);
    messages.push({
      id: `a${i}`,
      role: 'assistant',
      timestamp: new Date(2026, 0, 1),
      content: {
        type: 'text',
        content: `${markdown}\n\n${i}`,
        renderingContent: [
          { category: 'text', blocks: [{ type: 'text', text: `${markdown}\n\n${i}` }] },
        ],
      },
    } as Message<unknown>);
  }
  return messages;
}

function useChatReturn(messages: Message<unknown>[]) {
  const noop = async () => {};
  const handedOff = async () => true;
  return {
    chat: { id: 'chat_1', projectId: 'proj_1', name: 'Chat', apiDefinitionId: null, modelId: null },
    project: null,
    messages,
    isLoading: false,
    loopPhase: 'idle',
    showContinueBanner: false,
    tokenUsage: { input: 0, output: 0, cost: 0 },
    minionTokenUsage: { input: 0, output: 0, cost: 0 },
    streamingGroups: [],
    currentApiDefId: 'api_1',
    currentModelId: 'model_1',
    parentApiDefId: 'api_1',
    parentModelId: 'model_1',
    unresolvedToolCalls: null,
    softStopRequested: false,
    dummyHookStatus: null,
    isLockedByIncompleteTail: false,
    snapshotLoading: false,
    sendMessage: handedOff,
    sendEditedMessage: async () => 'sent' as const,
    editMessage: noop,
    forkChat: async () => null,
    overrideModel: noop,
    updateAgentConfig: noop,
    updateChatName: noop,
    resolvePendingToolCalls: handedOff,
    rollbackToMessage: noop,
    requestSoftStop: () => {},
    continueAfterToolStop: noop,
  };
}

class FakeIntersectionObserver {
  private callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    setTimeout(
      () =>
        this.callback(
          [{ target, isIntersecting: true } as unknown as IntersectionObserverEntry],
          this as unknown as IntersectionObserver
        ),
      0
    );
  }
  unobserve() {}
  disconnect() {}
}

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const originalRect = HTMLElement.prototype.getBoundingClientRect;
const originalIO = globalThis.IntersectionObserver;
const originalRO = globalThis.ResizeObserver;
const originalMatchMedia = window.matchMedia;

describe('ChatView with the real message list', () => {
  beforeAll(() => {
    globalThis.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { height: 120, width: 600, top: 0, left: 0, bottom: 120, right: 600 } as DOMRect;
    };
  });

  afterAll(() => {
    globalThis.IntersectionObserver = originalIO;
    globalThis.ResizeObserver = originalRO;
    window.matchMedia = originalMatchMedia;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    chatState.current = useChatReturn(buildMessages(10));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('typing in the input does not re-render message markdown', async () => {
    const { container } = render(
      <MemoryRouter>
        <ChatView chatId="chat_1" />
      </MemoryRouter>
    );
    // Let the observers report and the visibility flush land.
    await act(async () => {
      vi.advanceTimersByTime(0);
      vi.advanceTimersByTime(250);
    });
    expect(container.querySelectorAll('.text-group-view').length).toBe(10);

    markdownCalls.count = 0;
    const textarea = container.querySelector('textarea')!;
    for (let i = 1; i <= 10; i++) {
      await act(async () => {
        fireEvent.change(textarea, { target: { value: 'x'.repeat(i) } });
      });
    }

    expect(textarea.value).toBe('x'.repeat(10));
    expect(markdownCalls.count).toBe(0);
  });

  it('sending from deep in history jumps back to the latest messages', async () => {
    const sendMessage = vi.fn(async () => true);
    chatState.current = { ...useChatReturn(buildMessages(50)), sendMessage };
    const { container } = render(
      <MemoryRouter>
        <ChatView chatId="chat_1" />
      </MemoryRouter>
    );
    const mountedIds = () =>
      Array.from(container.querySelectorAll('[data-message-id]')).map(element =>
        element.getAttribute('data-message-id')
      );

    await act(async () => fireEvent.keyDown(screen.getByRole('scrollbar'), { key: 'Home' }));
    expect(mountedIds()).toContain('u0');
    expect(mountedIds()).not.toContain('a49');

    const textarea = container.querySelector('textarea')!;
    await act(async () => fireEvent.change(textarea, { target: { value: 'hello' } }));
    await act(async () => fireEvent.keyDown(textarea, { key: 'Enter' }));

    expect(sendMessage).toHaveBeenCalledWith('chat_1', 'hello', undefined, undefined);
    expect(mountedIds()).toContain('a49');
    expect(mountedIds()).not.toContain('u0');
  });

  function renderChat() {
    return render(
      <MemoryRouter>
        <ChatView chatId="chat_1" />
      </MemoryRouter>
    );
  }

  const composer = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  const editButtons = () => screen.getAllByRole('button', { name: 'Edit message' });

  describe('editing a message', () => {
    it('fills the composer without deleting anything, and Cancel leaves edit mode', async () => {
      const editMessage = vi.fn(async () => {});
      chatState.current = { ...useChatReturn(buildMessages(3)), editMessage };
      renderChat();

      await act(async () => fireEvent.click(editButtons()[1]));

      expect(composer().value).toBe('question 1');
      expect(screen.getByText('Sending replaces it and everything after it.')).toBeInTheDocument();
      expect(editMessage).not.toHaveBeenCalled();

      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })));

      expect(composer().value).toBe('');
      expect(screen.queryByText(/Sending replaces it/)).not.toBeInTheDocument();
      expect(editMessage).not.toHaveBeenCalled();
    });

    it('sends the edit through sendEditedMessage', async () => {
      const sendMessage = vi.fn(async () => true);
      const sendEditedMessage = vi.fn(async () => 'sent' as const);
      chatState.current = { ...useChatReturn(buildMessages(3)), sendMessage, sendEditedMessage };
      renderChat();

      await act(async () => fireEvent.click(editButtons()[1]));
      await act(async () => fireEvent.change(composer(), { target: { value: 'better question' } }));
      await act(async () => fireEvent.keyDown(composer(), { key: 'Enter' }));

      expect(sendEditedMessage).toHaveBeenCalledWith(
        'chat_1',
        'u1',
        'better question',
        undefined,
        undefined
      );
      expect(sendMessage).not.toHaveBeenCalled();
      expect(screen.queryByText(/Sending replaces it/)).not.toBeInTheDocument();
    });

    it('stays in edit mode with the text when the edit could not be applied', async () => {
      const sendEditedMessage = vi.fn(async () => 'untouched' as const);
      chatState.current = { ...useChatReturn(buildMessages(3)), sendEditedMessage };
      renderChat();

      await act(async () => fireEvent.click(editButtons()[1]));
      await act(async () => fireEvent.change(composer(), { target: { value: 'better question' } }));
      await act(async () => fireEvent.keyDown(composer(), { key: 'Enter' }));

      expect(composer().value).toBe('better question');
      expect(screen.getByText('Sending replaces it and everything after it.')).toBeInTheDocument();
    });

    it('keeps the text but leaves edit mode when the old message was already deleted', async () => {
      const sendEditedMessage = vi.fn(async () => 'truncated' as const);
      chatState.current = { ...useChatReturn(buildMessages(3)), sendEditedMessage };
      renderChat();

      await act(async () => fireEvent.click(editButtons()[1]));
      await act(async () => fireEvent.change(composer(), { target: { value: 'better question' } }));
      await act(async () => fireEvent.keyDown(composer(), { key: 'Enter' }));

      expect(composer().value).toBe('better question');
      expect(screen.queryByText(/Sending replaces it/)).not.toBeInTheDocument();
    });

    it('lets an edit through on a chat locked by an incomplete tail', async () => {
      chatState.current = { ...useChatReturn(buildMessages(3)), isLockedByIncompleteTail: true };
      renderChat();
      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();

      await act(async () => fireEvent.click(editButtons()[0]));

      expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
    });

    describe('with injected files', () => {
      const fileA = { path: '/a.md', content: 'alpha' };
      const fileB = { path: '/b.md', content: 'beta' };
      /** u1 as a cloned minion message: separate-block files around its text. */
      function messagesWithFiles(text = 'question 1') {
        const messages = buildMessages(3);
        messages[2] = {
          ...messages[2],
          content: {
            type: 'text',
            content: text,
            renderingContent: [
              {
                category: 'backstage',
                blocks: [{ type: 'injected_file', path: fileA.path, content: 'A bar' }],
              },
              { category: 'text', blocks: text ? [{ type: 'text', text }] : [] },
              {
                category: 'backstage',
                blocks: [{ type: 'injected_file', path: fileB.path, content: 'B bar' }],
              },
            ],
            injectedFiles: [fileA],
            injectedFilesAfter: [fileB],
            injectionMode: 'separate-block',
          },
        } as Message<unknown>;
        return messages;
      }
      const carried = {
        mode: 'separate-block',
        before: [{ path: fileA.path, display: 'A bar', entry: fileA }],
        after: [{ path: fileB.path, display: 'B bar', entry: fileB }],
        endMarker: false,
      };

      it('carries them into the edit, minus the ones removed', async () => {
        const sendEditedMessage = vi.fn(async () => 'sent' as const);
        chatState.current = { ...useChatReturn(messagesWithFiles()), sendEditedMessage };
        renderChat();

        await act(async () => fireEvent.click(editButtons()[1]));
        expect(screen.getByText('📄 /a.md')).toBeInTheDocument();
        expect(screen.getByText('📄 /b.md')).toBeInTheDocument();

        await act(async () =>
          fireEvent.click(screen.getByRole('button', { name: 'Remove /b.md' }))
        );
        await act(async () => fireEvent.keyDown(composer(), { key: 'Enter' }));

        expect(sendEditedMessage).toHaveBeenCalledWith('chat_1', 'u1', 'question 1', undefined, {
          ...carried,
          after: [],
        });
        expect(screen.queryByText('📄 /a.md')).not.toBeInTheDocument();
      });

      it('sends a files-only edit with an empty composer', async () => {
        const sendEditedMessage = vi.fn(async () => 'sent' as const);
        chatState.current = { ...useChatReturn(messagesWithFiles('')), sendEditedMessage };
        renderChat();

        await act(async () => fireEvent.click(editButtons()[1]));
        expect(composer().value).toBe('');
        expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
        await act(async () =>
          fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
        );

        expect(sendEditedMessage).toHaveBeenCalledWith('chat_1', 'u1', '', undefined, carried);
      });

      it('drops them on Cancel', async () => {
        chatState.current = useChatReturn(messagesWithFiles());
        renderChat();

        await act(async () => fireEvent.click(editButtons()[1]));
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })));

        expect(screen.queryByText('📄 /a.md')).not.toBeInTheDocument();
      });

      it('keeps them for the next send when the old message was already deleted', async () => {
        const sendEditedMessage = vi.fn(async () => 'truncated' as const);
        const sendMessage = vi.fn(async () => true);
        chatState.current = {
          ...useChatReturn(messagesWithFiles()),
          sendEditedMessage,
          sendMessage,
        };
        renderChat();

        await act(async () => fireEvent.click(editButtons()[1]));
        await act(async () => fireEvent.keyDown(composer(), { key: 'Enter' }));
        expect(screen.getByText('📄 /a.md')).toBeInTheDocument();

        await act(async () => fireEvent.keyDown(composer(), { key: 'Enter' }));
        expect(sendMessage).toHaveBeenCalledWith('chat_1', 'question 1', undefined, carried);
      });
    });

    it('asks before replacing an unsent draft', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      chatState.current = useChatReturn(buildMessages(3));
      renderChat();
      await act(async () => fireEvent.change(composer(), { target: { value: 'my draft' } }));

      await act(async () => fireEvent.click(editButtons()[0]));

      expect(confirm).toHaveBeenCalled();
      expect(composer().value).toBe('my draft');
      confirm.mockRestore();
    });
  });

  describe('the ⋯ menu', () => {
    it('closes on Escape and hands focus back to its button', async () => {
      chatState.current = useChatReturn(buildMessages(1));
      renderChat();
      const menuButton = screen.getByRole('button', { name: 'Chat menu' });

      await act(async () => fireEvent.click(menuButton));
      expect(menuButton).toHaveAttribute('aria-expanded', 'true');
      await act(async () => fireEvent.keyDown(document, { key: 'Escape' }));

      expect(screen.queryByText('Focus Mode')).not.toBeInTheDocument();
      expect(menuButton).toHaveFocus();
    });

    it('remembers the view options for the next chat', async () => {
      chatState.current = useChatReturn(buildMessages(1));
      const first = renderChat();
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Chat menu' })));
      await act(async () => fireEvent.click(screen.getByText('Disable Math')));
      first.unmount();

      renderChat();
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Chat menu' })));

      expect(screen.getByText('Disable Math').closest('button')).toHaveTextContent('✓');
      expect(screen.getByText('Focus Mode').closest('button')).not.toHaveTextContent('✓');
    });
  });

  it('keeps the rename dialog open against backdrop and Escape while the save runs', async () => {
    let finishRename: () => void = () => {};
    const updateChatName = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishRename = resolve;
        })
    );
    chatState.current = { ...useChatReturn(buildMessages(1)), updateChatName };
    renderChat();

    await act(async () => fireEvent.click(screen.getByRole('heading', { name: 'Chat' })));
    const nameField = screen.getByRole('textbox', { name: 'Chat name' });
    await act(async () => fireEvent.change(nameField, { target: { value: 'Renamed' } }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(updateChatName).toHaveBeenCalledWith('chat_1', 'Renamed');

    await act(async () => fireEvent.click(document.querySelector<HTMLElement>('.bg-black\\/50')!));
    await act(async () => fireEvent.keyDown(document, { key: 'Escape' }));
    await act(async () => fireEvent.keyDown(nameField, { key: 'Enter' }));
    expect(screen.getByRole('dialog', { name: 'Rename chat' })).toBeInTheDocument();
    expect(updateChatName).toHaveBeenCalledTimes(1);

    await act(async () => finishRename());
    expect(screen.queryByRole('dialog', { name: 'Rename chat' })).not.toBeInTheDocument();
  });

  it('puts the text and attachments back when a send is not handed off', async () => {
    const attachment = {
      id: 'att_1',
      type: 'image' as const,
      mimeType: 'image/png' as const,
      data: 'AAAA',
    };
    vi.mocked(processImages).mockResolvedValueOnce({ attachments: [attachment], errors: [] });
    const sendMessage = vi.fn(async () => false);
    chatState.current = { ...useChatReturn(buildMessages(1)), sendMessage };
    renderChat();
    const image = new File(['png'], 'shot.png', { type: 'image/png' });
    await act(async () =>
      fireEvent.drop(screen.getAllByText('question 0')[0], {
        dataTransfer: { types: ['Files'], files: [image] },
      })
    );
    expect(screen.getByAltText('Attachment preview')).toBeInTheDocument();

    await act(async () => fireEvent.change(composer(), { target: { value: 'hello' } }));
    await act(async () => fireEvent.keyDown(composer(), { key: 'Enter' }));

    expect(sendMessage).toHaveBeenCalledWith('chat_1', 'hello', [attachment], undefined);
    expect(composer().value).toBe('hello');
    expect(screen.getByAltText('Attachment preview')).toBeInTheDocument();
  });

  it('keeps the rename dialog open and alerts when the rename fails', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const updateChatName = vi.fn(async () => {
      throw new Error('offline');
    });
    chatState.current = { ...useChatReturn(buildMessages(1)), updateChatName };
    renderChat();

    await act(async () => fireEvent.click(screen.getByRole('heading', { name: 'Chat' })));
    const nameField = screen.getByRole('textbox', { name: 'Chat name' });
    await act(async () => fireEvent.change(nameField, { target: { value: 'Renamed' } }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));

    expect(alert).toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Rename chat' })).toBeInTheDocument();
  });

  it('attaches images dropped anywhere on the chat', async () => {
    chatState.current = useChatReturn(buildMessages(1));
    renderChat();
    const image = new File(['png'], 'shot.png', { type: 'image/png' });
    const target = screen.getAllByText('question 0')[0];

    await act(async () =>
      fireEvent.dragEnter(target, { dataTransfer: { types: ['Files'], files: [image] } })
    );
    expect(screen.getByText('Drop images to attach')).toBeInTheDocument();

    await act(async () =>
      fireEvent.drop(target, { dataTransfer: { types: ['Files'], files: [image] } })
    );

    expect(screen.queryByText('Drop images to attach')).not.toBeInTheDocument();
    expect(processImages).toHaveBeenCalledWith([image], 10);
  });
});
