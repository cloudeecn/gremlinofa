import { useState, useEffect, useMemo, useCallback } from 'react';
import { gremlinClient } from '../client';
import type { MinionChat, Message, TokenUsage } from '../../shared/protocol/types';

export interface UseMinionChatResult {
  minionChat: MinionChat | null;
  messages: Message<unknown>[];
  isLoading: boolean;
  tokenUsage: TokenUsage;
  deleteMessage: (messageId: string) => Promise<void>;
  rollbackToMessage: (messageId: string) => Promise<void>;
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
          gremlinClient.getMinionChat(minionChatId),
          gremlinClient.getMinionMessages(minionChatId),
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

  const deleteMessage = useCallback(async (messageId: string) => {
    setMessages(prev => prev.filter(m => m.id !== messageId));
    await gremlinClient.deleteSingleMessage(messageId);
  }, []);

  const rollbackToMessage = useCallback(
    async (messageId: string) => {
      const messageIndex = messages.findIndex(m => m.id === messageId);
      if (messageIndex === -1 || messageIndex === messages.length - 1) return;
      const nextMessageId = messages[messageIndex + 1].id;
      setMessages(prev => prev.slice(0, messageIndex + 1));
      await gremlinClient.deleteMessageAndAfter(minionChatId, nextMessageId);
    },
    [messages, minionChatId]
  );

  return { minionChat, messages, isLoading, tokenUsage, deleteMessage, rollbackToMessage };
}
