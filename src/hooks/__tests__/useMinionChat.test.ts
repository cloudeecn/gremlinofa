import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useMinionChat } from '../useMinionChat';
import type { MinionChat, Message } from '../../types';

vi.mock('../../services/storage', () => ({
  storage: {
    getMinionChat: vi.fn(),
    getMinionMessages: vi.fn(),
  },
}));

import { storage } from '../../services/storage';

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
    vi.mocked(storage.getMinionChat).mockResolvedValue(mockMinionChat);
    vi.mocked(storage.getMinionMessages).mockResolvedValue(mockMessages);

    const { result } = renderHook(() => useMinionChat('mc_1'));

    // Initially loading
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.minionChat).toEqual(mockMinionChat);
    expect(result.current.messages).toEqual(mockMessages);
    expect(storage.getMinionChat).toHaveBeenCalledWith('mc_1');
    expect(storage.getMinionMessages).toHaveBeenCalledWith('mc_1');
  });

  it('computes tokenUsage from minionChat totals', async () => {
    vi.mocked(storage.getMinionChat).mockResolvedValue(mockMinionChat);
    vi.mocked(storage.getMinionMessages).mockResolvedValue([]);

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
    vi.mocked(storage.getMinionChat).mockResolvedValue({
      ...mockMinionChat,
      totalReasoningTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
    });
    vi.mocked(storage.getMinionMessages).mockResolvedValue([]);

    const { result } = renderHook(() => useMinionChat('mc_1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tokenUsage.reasoning).toBeUndefined();
    expect(result.current.tokenUsage.cacheCreation).toBeUndefined();
    expect(result.current.tokenUsage.cacheRead).toBeUndefined();
  });

  it('handles missing chat gracefully', async () => {
    vi.mocked(storage.getMinionChat).mockResolvedValue(null);
    vi.mocked(storage.getMinionMessages).mockResolvedValue([]);

    const { result } = renderHook(() => useMinionChat('nonexistent'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.minionChat).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(result.current.tokenUsage).toEqual({ input: 0, output: 0, cost: 0 });
  });
});
