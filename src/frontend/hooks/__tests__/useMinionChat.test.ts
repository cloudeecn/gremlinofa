import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useMinionChat } from '../useMinionChat';
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
});
