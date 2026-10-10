import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { gremlinClient } from '../client';
import type { MinionChat, Message, TokenUsage } from '../../shared/protocol/types';
import { isRemoteMinionChat } from '../../shared/protocol/types';

/** How often an open minion chat refetches while the parent chat's loop runs. */
export const LIVE_REFRESH_MS = 2000;

/** Keeps the previous objects for known ids so memoized bubbles don't re-render. */
function reconcileMessages(prev: Message<unknown>[], next: Message<unknown>[]) {
  if (prev.length === next.length && prev.every((m, i) => m.id === next[i].id)) return prev;
  const byId = new Map(prev.map(m => [m.id, m]));
  return next.map(m => byId.get(m.id) ?? m);
}

export interface UseMinionChatResult {
  minionChat: MinionChat | null;
  messages: Message<unknown>[];
  isLoading: boolean;
  tokenUsage: TokenUsage;
  /**
   * Human-operated (Touch Grass) minion. Its transcript is read-only here:
   * the human's copy on the backend can't be edited, so a local delete or
   * rollback would split the two. `deleteMessage` / `rollbackToMessage`
   * refuse while this is true.
   */
  isRemote: boolean;
  deleteMessage: (messageId: string) => Promise<void>;
  rollbackToMessage: (messageId: string) => Promise<void>;
  /** Promote this transcript into a regular chat; resolves to the new chat id. */
  cloneToChat: (name?: string) => Promise<{ newChatId: string; notes: string[] }>;
  isCloning: boolean;
}

/**
 * Loads a minion chat. There is no event stream for minion chats (their loops
 * register under the parent chat), so with `live` set — the parent's loop is
 * running — it refetches every LIVE_REFRESH_MS, and once more when `live`
 * turns off to catch the final messages.
 */
export function useMinionChat(
  minionChatId: string,
  { live = false }: { live?: boolean } = {}
): UseMinionChatResult {
  const [minionChat, setMinionChat] = useState<MinionChat | null>(null);
  const [messages, setMessages] = useState<Message<unknown>[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCloning, setIsCloning] = useState(false);
  // A refresh whose snapshot may predate a local delete would bring the deleted
  // messages back, so it is dropped if a delete ran at any point during it:
  // one still in flight, or an epoch change (bumped as each delete starts and ends).
  const pendingDeletesRef = useRef(0);
  const deleteEpochRef = useRef(0);
  const trackDelete = useCallback(async (runDelete: () => Promise<void>) => {
    pendingDeletesRef.current++;
    deleteEpochRef.current++;
    try {
      await runDelete();
    } finally {
      pendingDeletesRef.current--;
      deleteEpochRef.current++;
    }
  }, []);

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

  const refresh = useCallback(async () => {
    const epoch = deleteEpochRef.current;
    try {
      const [chat, msgs] = await Promise.all([
        gremlinClient.getMinionChat(minionChatId),
        gremlinClient.getMinionMessages(minionChatId),
      ]);
      if (epoch !== deleteEpochRef.current || pendingDeletesRef.current > 0) return;
      setMinionChat(chat);
      setMessages(prev => reconcileMessages(prev, msgs));
    } catch (error) {
      console.debug('[useMinionChat] Refresh failed:', error);
    }
  }, [minionChatId]);

  const wasLiveRef = useRef(live);
  useEffect(() => {
    const wasLive = wasLiveRef.current;
    wasLiveRef.current = live;
    if (live) {
      const timer = setInterval(() => void refresh(), LIVE_REFRESH_MS);
      return () => clearInterval(timer);
    }
    if (wasLive) void refresh();
  }, [live, refresh]);

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

  const isRemote = minionChat !== null && isRemoteMinionChat(minionChat);

  const deleteMessage = useCallback(
    async (messageId: string) => {
      if (isRemote) {
        console.debug('[useMinionChat] Refusing delete on remote minion chat:', minionChatId);
        return;
      }
      await trackDelete(async () => {
        setMessages(prev => prev.filter(m => m.id !== messageId));
        await gremlinClient.deleteSingleMessage(messageId);
      });
    },
    [isRemote, minionChatId, trackDelete]
  );

  const rollbackToMessage = useCallback(
    async (messageId: string) => {
      if (isRemote) {
        console.debug('[useMinionChat] Refusing rollback on remote minion chat:', minionChatId);
        return;
      }
      const messageIndex = messages.findIndex(m => m.id === messageId);
      if (messageIndex === -1 || messageIndex === messages.length - 1) return;
      const nextMessageId = messages[messageIndex + 1].id;
      await trackDelete(async () => {
        setMessages(prev => prev.slice(0, messageIndex + 1));
        await gremlinClient.deleteMessageAndAfter(minionChatId, nextMessageId);
      });
    },
    [isRemote, messages, minionChatId, trackDelete]
  );

  const cloneToChat = useCallback(
    async (name?: string) => {
      setIsCloning(true);
      try {
        return await gremlinClient.cloneMinionChat(minionChatId, { name });
      } finally {
        setIsCloning(false);
      }
    },
    [minionChatId]
  );

  return {
    minionChat,
    messages,
    isLoading,
    tokenUsage,
    isRemote,
    deleteMessage,
    rollbackToMessage,
    cloneToChat,
    isCloning,
  };
}
