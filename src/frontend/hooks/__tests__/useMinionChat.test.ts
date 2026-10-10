import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { LIVE_REFRESH_MS, useMinionChat } from '../useMinionChat';
import type { MinionChat, Message } from '../../../shared/protocol/types';

// Mock `../client` so the hook calls a stub `gremlinClient` we control
// directly. The previous incarnation of these tests mocked the
// `services/storage` singleton and relied on the in-process GremlinServer
// to dispatch through it; with the singletons gone we test the React hook
// against the GremlinClient surface, which is the actual frontend boundary.
vi.mock('../../client', () => ({
  gremlinClient: {
    getMinionChat: vi.fn(),
    getMinionMessages: vi.fn(),
    deleteSingleMessage: vi.fn(),
    deleteMessageAndAfter: vi.fn(),
  },
}));

import { gremlinClient } from '../../client';

const mockMinionChat: MinionChat = {
  id: 'mc_1',
  parentChatId: 'chat_1',
  projectId: 'proj_1',
  createdAt: new Date('2025-01-01'),
  lastModifiedAt: new Date('2025-01-01'),
  totalInputTokens: 5000,
  totalOutputTokens: 2000,
  totalReasoningTokens: 1000,
  totalCacheCreationTokens: 500,
  totalCacheReadTokens: 3000,
  totalCost: 0.05,
};

const mockMessages: Message<unknown>[] = [
  {
    id: 'msg_1',
    role: 'user',
    content: { type: 'text', content: 'Hello' },
    timestamp: new Date('2025-01-01T10:00:00Z'),
  },
  {
    id: 'msg_2',
    role: 'assistant',
    content: { type: 'text', content: 'Hi there' },
    timestamp: new Date('2025-01-01T10:00:01Z'),
  },
];

describe('useMinionChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads chat and messages', async () => {
    vi.mocked(gremlinClient.getMinionChat).mockResolvedValue(mockMinionChat);
    vi.mocked(gremlinClient.getMinionMessages).mockResolvedValue(mockMessages);

    const { result } = renderHook(() => useMinionChat('mc_1'));

    // Initially loading
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.minionChat).toEqual(mockMinionChat);
    expect(result.current.messages).toEqual(mockMessages);
    expect(gremlinClient.getMinionChat).toHaveBeenCalledWith('mc_1');
    expect(gremlinClient.getMinionMessages).toHaveBeenCalledWith('mc_1');
  });

  it('computes tokenUsage from minionChat totals', async () => {
    vi.mocked(gremlinClient.getMinionChat).mockResolvedValue(mockMinionChat);
    vi.mocked(gremlinClient.getMinionMessages).mockResolvedValue([]);

    const { result } = renderHook(() => useMinionChat('mc_1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tokenUsage).toEqual({
      input: 5000,
      output: 2000,
      reasoning: 1000,
      cacheCreation: 500,
      cacheRead: 3000,
      cost: 0.05,
    });
  });

  it('omits zero reasoning/cache from tokenUsage', async () => {
    vi.mocked(gremlinClient.getMinionChat).mockResolvedValue({
      ...mockMinionChat,
      totalReasoningTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
    });
    vi.mocked(gremlinClient.getMinionMessages).mockResolvedValue([]);

    const { result } = renderHook(() => useMinionChat('mc_1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tokenUsage.reasoning).toBeUndefined();
    expect(result.current.tokenUsage.cacheCreation).toBeUndefined();
    expect(result.current.tokenUsage.cacheRead).toBeUndefined();
  });

  it('handles missing chat gracefully', async () => {
    vi.mocked(gremlinClient.getMinionChat).mockResolvedValue(null);
    vi.mocked(gremlinClient.getMinionMessages).mockResolvedValue([]);

    const { result } = renderHook(() => useMinionChat('nonexistent'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.minionChat).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(result.current.tokenUsage).toEqual({ input: 0, output: 0, cost: 0 });
  });

  it('deleteMessage removes a single message from state and storage', async () => {
    vi.mocked(gremlinClient.getMinionChat).mockResolvedValue(mockMinionChat);
    vi.mocked(gremlinClient.getMinionMessages).mockResolvedValue(mockMessages);
    vi.mocked(gremlinClient.deleteSingleMessage).mockResolvedValue(undefined);

    const { result } = renderHook(() => useMinionChat('mc_1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.messages).toHaveLength(2);

    await act(async () => {
      await result.current.deleteMessage('msg_1');
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].id).toBe('msg_2');
    expect(gremlinClient.deleteSingleMessage).toHaveBeenCalledWith('msg_1');
  });

  it('deleteMessage is a no-op for unknown messageId', async () => {
    vi.mocked(gremlinClient.getMinionChat).mockResolvedValue(mockMinionChat);
    vi.mocked(gremlinClient.getMinionMessages).mockResolvedValue(mockMessages);

    const { result } = renderHook(() => useMinionChat('mc_1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.deleteMessage('nonexistent');
    });

    // filter keeps all messages when none match
    expect(result.current.messages).toHaveLength(2);
  });

  it('rollbackToMessage keeps target and deletes everything after', async () => {
    vi.mocked(gremlinClient.getMinionChat).mockResolvedValue(mockMinionChat);
    vi.mocked(gremlinClient.getMinionMessages).mockResolvedValue(mockMessages);
    vi.mocked(gremlinClient.deleteMessageAndAfter).mockResolvedValue(undefined);

    const { result } = renderHook(() => useMinionChat('mc_1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.messages).toHaveLength(2);

    await act(async () => {
      await result.current.rollbackToMessage('msg_1');
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].id).toBe('msg_1');
    expect(gremlinClient.deleteMessageAndAfter).toHaveBeenCalledWith('mc_1', 'msg_2');
  });

  it('rollbackToMessage is a no-op on the last message', async () => {
    vi.mocked(gremlinClient.getMinionChat).mockResolvedValue(mockMinionChat);
    vi.mocked(gremlinClient.getMinionMessages).mockResolvedValue(mockMessages);

    const { result } = renderHook(() => useMinionChat('mc_1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.rollbackToMessage('msg_2');
    });

    expect(result.current.messages).toHaveLength(2);
    expect(gremlinClient.deleteMessageAndAfter).not.toHaveBeenCalled();
  });

  describe('live refresh', () => {
    const newMessage: Message<unknown> = {
      id: 'msg_3',
      role: 'assistant',
      content: { type: 'text', content: 'More work' },
      timestamp: new Date('2025-01-01T10:00:02Z'),
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      vi.mocked(gremlinClient.getMinionChat).mockResolvedValue(mockMinionChat);
      // Fresh objects per call, like the RPC's structured clone
      vi.mocked(gremlinClient.getMinionMessages).mockImplementation(async () =>
        mockMessages.map(m => ({ ...m }))
      );
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // waitFor polls with setInterval, which these tests fake: settle by hand
    async function settle() {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    async function tick() {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MS);
      });
    }

    it('does not poll while the parent loop is idle', async () => {
      const { result } = renderHook(() => useMinionChat('mc_1'));
      await settle();
      expect(result.current.isLoading).toBe(false);

      await tick();
      await tick();

      expect(gremlinClient.getMinionMessages).toHaveBeenCalledTimes(1);
    });

    it('appends new messages while live and keeps the existing objects', async () => {
      const { result } = renderHook(() => useMinionChat('mc_1', { live: true }));
      await settle();
      expect(result.current.isLoading).toBe(false);
      const [first, second] = result.current.messages;

      vi.mocked(gremlinClient.getMinionMessages).mockImplementation(async () =>
        [...mockMessages, newMessage].map(m => ({ ...m }))
      );
      await tick();

      await settle();
      expect(result.current.messages).toHaveLength(3);
      expect(result.current.messages[0]).toBe(first);
      expect(result.current.messages[1]).toBe(second);
    });

    it('keeps the same array when nothing changed', async () => {
      const { result } = renderHook(() => useMinionChat('mc_1', { live: true }));
      await settle();
      expect(result.current.isLoading).toBe(false);
      const before = result.current.messages;

      await tick();

      expect(gremlinClient.getMinionMessages).toHaveBeenCalledTimes(2);
      expect(result.current.messages).toBe(before);
    });

    it('refetches once more when the parent loop ends, then stops', async () => {
      const { result, rerender } = renderHook(({ live }) => useMinionChat('mc_1', { live }), {
        initialProps: { live: true },
      });
      await settle();
      expect(result.current.isLoading).toBe(false);

      vi.mocked(gremlinClient.getMinionMessages).mockImplementation(async () =>
        [...mockMessages, newMessage].map(m => ({ ...m }))
      );
      rerender({ live: false });

      await settle();
      expect(result.current.messages).toHaveLength(3);
      const calls = vi.mocked(gremlinClient.getMinionMessages).mock.calls.length;
      await tick();
      expect(gremlinClient.getMinionMessages).toHaveBeenCalledTimes(calls);
    });

    it('drops a refresh that raced a local delete', async () => {
      const { result } = renderHook(() => useMinionChat('mc_1', { live: true }));
      await settle();
      expect(result.current.isLoading).toBe(false);

      // The poll reads the old list while the delete is in flight
      let resolveDelete: () => void = () => {};
      vi.mocked(gremlinClient.deleteSingleMessage).mockImplementation(
        () => new Promise<void>(resolve => (resolveDelete = resolve))
      );
      let deleting: Promise<void> = Promise.resolve();
      act(() => {
        deleting = result.current.deleteMessage('msg_2');
      });
      await tick();
      await act(async () => {
        resolveDelete();
        await deleting;
      });

      expect(result.current.messages.map(m => m.id)).toEqual(['msg_1']);
    });
  });
});

describe('useMinionChat remote (human) minion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['the sticky remote flag', { remote: true }],
    ['only a session id (created before the flag)', { remoteSessionId: 'tg_1' }],
  ])('treats a chat with %s as remote', async (_label, fields) => {
    vi.mocked(gremlinClient.getMinionChat).mockResolvedValue({ ...mockMinionChat, ...fields });
    vi.mocked(gremlinClient.getMinionMessages).mockResolvedValue(mockMessages);

    const { result } = renderHook(() => useMinionChat('mc_1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isRemote).toBe(true);
  });

  it('is not remote for an ordinary minion', async () => {
    vi.mocked(gremlinClient.getMinionChat).mockResolvedValue(mockMinionChat);
    vi.mocked(gremlinClient.getMinionMessages).mockResolvedValue(mockMessages);

    const { result } = renderHook(() => useMinionChat('mc_1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isRemote).toBe(false);
  });

  it('refuses delete and rollback so the transcript stays in step with the backend', async () => {
    vi.mocked(gremlinClient.getMinionChat).mockResolvedValue({ ...mockMinionChat, remote: true });
    vi.mocked(gremlinClient.getMinionMessages).mockResolvedValue(mockMessages);

    const { result } = renderHook(() => useMinionChat('mc_1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.deleteMessage('msg_1');
      await result.current.rollbackToMessage('msg_1');
    });

    expect(result.current.messages).toEqual(mockMessages);
    expect(gremlinClient.deleteSingleMessage).not.toHaveBeenCalled();
    expect(gremlinClient.deleteMessageAndAfter).not.toHaveBeenCalled();
  });
});
