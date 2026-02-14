import { useState, useEffect, useMemo } from 'react';
import { storage } from '../services/storage';
import type { MinionChat, Message, TokenUsage } from '../types';

export interface UseMinionChatResult {
  minionChat: MinionChat | null;
  messages: Message<unknown>[];
  isLoading: boolean;
  tokenUsage: TokenUsage;
}

export function useMinionChat(minionChatId: string): UseMinionChatResult {
  const [minionChat, setMinionChat] = useState<MinionChat | null>(null);
  const [messages, setMessages] = useState<Message<unknown>[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      try {
        const [chat, msgs] = await Promise.all([
          storage.getMinionChat(minionChatId),
          storage.getMinionMessages(minionChatId),
        ]);
        if (cancelled) return;
        setMinionChat(chat);
        setMessages(msgs);
      } catch (error) {
        console.debug('[useMinionChat] Failed to load:', error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [minionChatId]);

  const tokenUsage: TokenUsage = useMemo(() => {
    if (!minionChat) return { input: 0, output: 0, cost: 0 };
    return {
      input: minionChat.totalInputTokens || 0,
      output: minionChat.totalOutputTokens || 0,
      reasoning:
        (minionChat.totalReasoningTokens || 0) > 0 ? minionChat.totalReasoningTokens : undefined,
      cacheCreation:
        (minionChat.totalCacheCreationTokens || 0) > 0
          ? minionChat.totalCacheCreationTokens
          : undefined,
      cacheRead:
        (minionChat.totalCacheReadTokens || 0) > 0 ? minionChat.totalCacheReadTokens : undefined,
      cost: minionChat.totalCost || 0,
    };
  }, [minionChat]);

  return { minionChat, messages, isLoading, tokenUsage };
}
