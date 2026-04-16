/**
 * React adapter around `GremlinSession`.
 *
 * Before the backend split, `useChat` owned 1500+ lines of orchestration:
 * it built `AgenticLoopOptions`, called `runAgenticLoop` directly, persisted
 * messages on every event, and updated React state from a thicket of
 * inline handlers. Now all of that lives behind the `runLoop` RPC — the
 * hook's only job is to bridge `GremlinSession`'s push-based event stream
 * into React state, with throttled rendering for streaming chunks.
 *
 * What stayed:
 *   - chatId verification (`verifyChatId`) so stale callbacks from a
 *     previous chat don't pollute the new one's state.
 *   - 200ms throttle on streaming chunks and tool block updates so React
 *     doesn't re-render on every word.
 *   - The `loopPhase` state machine (`idle | pending | streaming`) the
 *     chat view consumes.
 *   - Callback wiring to the host component (`UseChatCallbacks`).
 *
 * What's new:
 *   - `isLockedByIncompleteTail`: pushed by the backend via the
 *     `lock_state_changed` LoopEvent (snapshot value during attachChat,
 *     plus deltas after every relevant mutation). The chat view uses it to
 *     disable the input and render the resolution banner.
 *   - All storage / API access goes through `gremlinClient`. The hook does
 *     not import `services/*` for anything other than tool-call inspection
 *     helpers (which are pure functions, not React boundaries).
 *
 * What was deleted:
 *   - `consumeAgenticLoop` (now `ChatRunner.consumeLoop` on the backend)
 *   - `buildAgenticLoopOptions` (now `buildAgenticLoopOptionsForContext`)
 *   - `createAndSaveUserMessage` (now `ChatRunner.createAndSaveUserMessage`)
 *   - The `pendingState` auto-resume effect (TODO: move to backend before
 *     PR 13's worker hop — see "Pending state auto-resume" risk in the plan)
 */

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { gremlinClient, GremlinSession } from '../client';
import type {
  APIDefinition,
  Chat,
  Message,
  MessageAttachment,
  Project,
  RenderingBlockGroup,
  TokenUsage,
  ToolUseBlock,
} from '../../shared/protocol/types';
import type { ToolResultRenderBlock } from '../../shared/protocol/types/content';
import type { LoopEvent } from '../../shared/protocol/protocol';
import { showAlert } from '../lib/alerts';

/**
 * Throttle interval for streaming/tool-block UI updates (ms). Batches rapid
 * state updates from parallel minions into fewer React renders. Throttling
 * stays in the frontend (not the backend) because different clients may
 * eventually want different rates — and React renders are the cost we're
 * smoothing out, not network bandwidth.
 */
const STREAMING_THROTTLE_MS = 200;

// ============================================================================
// Pure helpers — no React, no I/O
// ============================================================================

/**
 * Detect tool_use blocks on a message that haven't been resolved yet.
 *
 * Phase 1.8 leak fix: the backend pre-extracts `toolUseBlocks` at every
 * point a message crosses the protocol boundary
 * (`prepareMessageForWire`). The frontend just reads the field, with
 * `toolCalls` as the fallback for dummy messages and any pre-1.8
 * persisted records that the snapshot didn't pre-extract for.
 */
function extractToolUseBlocksFromMessage(message: Message<unknown>): ToolUseBlock[] {
  return message.content.toolUseBlocks ?? message.content.toolCalls ?? [];
}

/** Pull the set of tool_result IDs already present on a message. */
function extractToolResultIdsFromMessage(message: Message<unknown>): Set<string> {
  const ids = new Set<string>();

  const renderingContent = message.content.renderingContent;
  if (renderingContent) {
    for (const group of renderingContent) {
      if (group.category === 'backstage') {
        for (const block of group.blocks) {
          if (block.type === 'tool_result') {
            ids.add((block as ToolResultRenderBlock).tool_use_id);
          }
        }
      }
    }
  }

  const fullContent = message.content.fullContent;
  if (Array.isArray(fullContent)) {
    for (const block of fullContent) {
      if ((block as Record<string, unknown>).type === 'tool_result') {
        ids.add((block as Record<string, unknown>).tool_use_id as string);
      }
    }
  }

  return ids;
}

/** True iff the last assistant message has tool calls without matching results. */
function getUnresolvedToolCalls(messages: Message<unknown>[]): ToolUseBlock[] | null {
  if (messages.length === 0) return null;

  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx === -1) return null;

  const lastAssistant = messages[lastAssistantIdx];
  const toolUseBlocks = extractToolUseBlocksFromMessage(lastAssistant);
  if (toolUseBlocks.length === 0) return null;

  const toolUseIds = new Set(toolUseBlocks.map(t => t.id));
  for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user') {
      const resultIds = extractToolResultIdsFromMessage(msg);
      for (const id of resultIds) {
        toolUseIds.delete(id);
      }
    }
  }
  if (toolUseIds.size === 0) return null;
  return toolUseBlocks.filter(t => toolUseIds.has(t.id));
}

/** True iff a message has a backstage tool_result block (last-tool-call detection). */
function isToolResultMessage(message: Message<unknown>): boolean {
  const renderingContent = message.content.renderingContent;
  if (!renderingContent) return false;
  return renderingContent.some(
    group => group.category === 'backstage' && group.blocks.some(b => b.type === 'tool_result')
  );
}

// ============================================================================
// Hook surface
// ============================================================================

export type DummyHookStatus =
  | { state: 'hooked'; hookName: string }
  | { state: 'intercepting'; hookName: string };

export interface UseChatCallbacks {
  onMessagesLoaded: (chatId: string, messages: Message<unknown>[]) => void;
  onMessageAppended: (chatId: string, message: Message<unknown>) => void;
  onMessagesRemovedOnAndAfter: (chatId: string, afterMessageId: string) => void;
  onStreamingStart: (chatId: string, loadingText: string) => void;
  onStreamingEnd: (chatId: string) => void;
  onChatMetadataChanged?: (chatId: string, chat: Chat) => void;
  onForkMessageLoaded?: (chatId: string, message: string) => void;
}

export interface UseChatProps {
  chatId: string;
  callbacks: UseChatCallbacks;
}

export interface UseChatReturn {
  chat: Chat | null;
  messages: Message<unknown>[];
  isLoading: boolean;
  loopPhase: 'idle' | 'pending' | 'streaming';
  /** True when loop paused after tools completed — derived from loopPhase + last message */
  showContinueBanner: boolean;
  tokenUsage: TokenUsage;
  minionTokenUsage: TokenUsage;
  /** Streaming content groups for rendering during streaming */
  streamingGroups: RenderingBlockGroup[];
  currentApiDefId: string | null;
  currentModelId: string | null;
  parentApiDefId: string | null;
  parentModelId: string | null;
  /** Unresolved tool_use blocks that need user action (stop/continue) */
  unresolvedToolCalls: ToolUseBlock[] | null;
  /** True while a soft stop has been requested but not yet effective */
  softStopRequested: boolean;
  /** DUMMY System hook status for status line display */
  dummyHookStatus: DummyHookStatus | null;
  /** True iff the chat's tail message is `incomplete: true` (hard-aborted). */
  isLockedByIncompleteTail: boolean;
  sendMessage: (
    chatId: string,
    content: string,
    attachments?: MessageAttachment[]
  ) => Promise<void>;
  editMessage: (chatId: string, messageId: string, content: string) => Promise<void>;
  copyMessage: (chatId: string, messageId: string) => Promise<void>;
  forkChat: (chatId: string, messageId: string) => Promise<{ id: string } | null>;
  overrideModel: (chatId: string, apiDefId: string | null, modelId: string | null) => Promise<void>;
  updateChatName: (chatId: string, name: string) => Promise<void>;
  /** Resolve pending tool calls with stop (error) or continue (execute) */
  resolvePendingToolCalls: (
    mode: 'stop' | 'continue',
    userMessage?: string,
    attachments?: MessageAttachment[]
  ) => Promise<void>;
  /** Resend from a message - delete messages after and re-run agentic loop */
  resendFromMessage: (messageId: string) => Promise<void>;
  /** Request the agentic loop to stop at the next tool boundary */
  requestSoftStop: () => void;
  /** Continue the loop after it was soft-stopped at the after_tools point */
  continueAfterToolStop: () => Promise<void>;
}

export function useChat({ chatId, callbacks }: UseChatProps): UseChatReturn {
  const [project, setProject] = useState<Project | null>(null);
  const [chat, setChat] = useState<Chat | null>(null);
  const [apiDefinition, setApiDefinition] = useState<APIDefinition | null>(null);
  const [messages, setMessages] = useState<Message<unknown>[]>([]);
  const [loopPhase, setLoopPhase] = useState<'idle' | 'pending' | 'streaming'>('idle');

  const [softStopRequested, setSoftStopRequested] = useState(false);
  const [streamingGroups, setStreamingGroups] = useState<RenderingBlockGroup[]>([]);
  const [dummyHookStatus, setDummyHookStatus] = useState<DummyHookStatus | null>(null);
  // Backend-pushed incomplete-tail lock. Phase 1.7 moved the predicate
  // computation off the frontend; we just store the latest value from the
  // `lock_state_changed` LoopEvent.
  const [isLockedByIncompleteTail, setIsLockedByIncompleteTail] = useState(false);

  // Throttle state for streaming UI updates. Refs (not state) so the
  // throttled callbacks can read the latest pending value without
  // re-creating their closure on every render.
  const pendingStreamingRef = useRef<RenderingBlockGroup[] | null>(null);
  const streamingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingToolUpdatesRef = useRef<Map<string, Partial<ToolResultRenderBlock>>>(new Map());
  const toolUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The session is recreated whenever chatId changes. We hold it in a ref
  // so the imperative methods (sendMessage, etc.) can reach it without
  // depending on a state value that would re-create them on every render.
  const sessionRef = useRef<GremlinSession | null>(null);

  // Keep callbacks in a ref so the loadChatData effect doesn't re-fire when
  // the parent passes a new closure on every render.
  const callbacksRef = useRef(callbacks);
  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  /** Verify a chatId matches the current hook instance — guards stale callbacks. */
  const verifyChatId = (incomingChatId: string, methodName: string): boolean => {
    if (incomingChatId !== chatId) {
      console.warn(
        `[useChat.${methodName}] chatId mismatch. Expected: ${chatId}, Got: ${incomingChatId}. Ignoring call.`
      );
      return false;
    }
    return true;
  };

  /** Apply a batch of accumulated tool block updates in a single setMessages call. */
  const applyToolBlockBatch = useCallback((batch: Map<string, Partial<ToolResultRenderBlock>>) => {
    setMessages(prev => {
      // Search backward in last 10 messages for the pending tool result message
      const searchStart = Math.max(0, prev.length - 10);
      let targetIdx = -1;
      for (let i = prev.length - 1; i >= searchStart; i--) {
        if (prev[i].role === 'user' && prev[i].content.renderingContent) {
          targetIdx = i;
          break;
        }
      }
      if (targetIdx < 0) return prev;

      const targetMsg = prev[targetIdx];
      const groups = targetMsg.content.renderingContent;
      if (!groups) return prev;

      let anyFound = false;
      const updatedGroups = groups.map(group => {
        if (group.category !== 'backstage') return group;
        const updatedBlocks = group.blocks.map(block => {
          if (block.type !== 'tool_result') return block;
          const update = batch.get((block as ToolResultRenderBlock).tool_use_id);
          if (update) {
            anyFound = true;
            return { ...block, ...update };
          }
          return block;
        });
        return { ...group, blocks: updatedBlocks };
      });
      if (!anyFound) return prev;

      const updatedMsg = {
        ...targetMsg,
        content: { ...targetMsg.content, renderingContent: updatedGroups },
      };
      return [...prev.slice(0, targetIdx), updatedMsg, ...prev.slice(targetIdx + 1)];
    });
  }, []);

  /** Flush throttled streaming + tool-block buffers (called on stream end). */
  const flushThrottledBuffers = useCallback(() => {
    if (streamingTimerRef.current) {
      clearTimeout(streamingTimerRef.current);
      streamingTimerRef.current = null;
    }
    if (pendingStreamingRef.current !== null) {
      setStreamingGroups(pendingStreamingRef.current);
      pendingStreamingRef.current = null;
    }
    if (toolUpdateTimerRef.current) {
      clearTimeout(toolUpdateTimerRef.current);
      toolUpdateTimerRef.current = null;
    }
    if (pendingToolUpdatesRef.current.size > 0) {
      const batch = new Map(pendingToolUpdatesRef.current);
      pendingToolUpdatesRef.current.clear();
      applyToolBlockBatch(batch);
    }
  }, [applyToolBlockBatch]);

  /**
   * Translate a single LoopEvent into React state updates. The session
   * dispatches every event from the backend through here in arrival
   * order — keep this function fast and side-effect free apart from
   * setState.
   */
  const handleLoopEvent = useCallback(
    (event: LoopEvent) => {
      switch (event.type) {
        case 'loop_started':
          // The session itself tracks loopId; we just transition phase.
          setLoopPhase('pending');
          setSoftStopRequested(false);
          break;

        case 'loop_ended':
          // Long-lived attachChat subscription delivers loop_ended whenever
          // a loop on this chat finishes. We mirror the runLoop stream's
          // `onEnd` cleanup here so the chat-view transitions back to idle
          // even when the loop was started somewhere else (e.g. project view).
          flushThrottledBuffers();
          setStreamingGroups([]);
          setDummyHookStatus(null);
          setSoftStopRequested(false);
          setLoopPhase('idle');
          callbacksRef.current.onStreamingEnd(chatId);
          if (event.status !== 'complete') {
            console.debug('[useChat] loop_ended:', event.status);
          }
          break;

        case 'snapshot_complete':
          // The `useEffect` mount handler dispatches the legacy
          // `onMessagesLoaded` callback from the same event — handled there
          // because it needs the latest `messages` state.
          break;

        case 'streaming_start':
          callbacksRef.current.onStreamingStart(chatId, 'Thinking...');
          break;

        case 'first_chunk':
          setLoopPhase('streaming');
          break;

        case 'streaming_chunk': {
          // Throttle: stash the latest groups in a ref and let the timer
          // flush at most once per STREAMING_THROTTLE_MS.
          pendingStreamingRef.current = event.groups;
          if (!streamingTimerRef.current) {
            streamingTimerRef.current = setTimeout(() => {
              streamingTimerRef.current = null;
              if (pendingStreamingRef.current !== null) {
                setStreamingGroups(pendingStreamingRef.current);
                pendingStreamingRef.current = null;
              }
            }, STREAMING_THROTTLE_MS);
          }
          break;
        }

        case 'streaming_end':
          // Final flush + clear streaming groups happen on stream_end below
          // (this is the per-iteration end, not the loop end).
          break;

        case 'message_created': {
          const msg = event.message;
          setMessages(prev => {
            // Replace if id matches a recent message; otherwise append.
            const searchStart = Math.max(0, prev.length - 10);
            for (let i = prev.length - 1; i >= searchStart; i--) {
              if (prev[i].id === msg.id) {
                const updated = [...prev];
                updated[i] = msg;
                return updated;
              }
            }
            return [...prev, msg];
          });
          // Clear streaming groups when a fresh assistant message lands so
          // the StreamingMessage doesn't double up with the MessageBubble.
          if (msg.role === 'assistant') {
            setStreamingGroups([]);
            pendingStreamingRef.current = null;
          }
          callbacksRef.current.onMessageAppended(chatId, msg);
          break;
        }

        case 'messages_truncated': {
          // Resend on a user message: backend deleted the assistant turns
          // after the anchor in storage. Drop them from React state too,
          // keeping the anchor itself.
          const anchor = event.afterMessageId;
          setMessages(prev => {
            const idx = prev.findIndex(m => m.id === anchor);
            return idx >= 0 ? prev.slice(0, idx + 1) : prev;
          });
          callbacksRef.current.onMessagesRemovedOnAndAfter(chatId, anchor);
          break;
        }

        case 'pending_tool_result': {
          const msg = event.message;
          setMessages(prev => {
            const searchStart = Math.max(0, prev.length - 10);
            for (let i = prev.length - 1; i >= searchStart; i--) {
              if (prev[i].id === msg.id) return prev;
            }
            return [...prev, msg];
          });
          break;
        }

        case 'tool_block_update': {
          const existing = pendingToolUpdatesRef.current.get(event.toolUseId);
          pendingToolUpdatesRef.current.set(
            event.toolUseId,
            existing ? { ...existing, ...event.block } : event.block
          );
          if (!toolUpdateTimerRef.current) {
            toolUpdateTimerRef.current = setTimeout(() => {
              toolUpdateTimerRef.current = null;
              const batch = new Map(pendingToolUpdatesRef.current);
              pendingToolUpdatesRef.current.clear();
              applyToolBlockBatch(batch);
            }, STREAMING_THROTTLE_MS);
          }
          break;
        }

        case 'chat_updated':
          setChat(event.chat);
          callbacksRef.current.onChatMetadataChanged?.(chatId, event.chat);
          break;

        case 'project_updated':
          setProject(event.project);
          break;

        case 'checkpoint_set':
          // Chat update with new checkpoint id arrives via `chat_updated`
          // immediately after — nothing to do here.
          break;

        case 'active_hook_changed':
          // Chat update with new activeHook arrives via `chat_updated`
          // immediately after — nothing to do here.
          break;

        case 'chat_metadata_updated':
          // Same — chat_updated covers it.
          break;

        case 'dummy_hook_start':
          setDummyHookStatus({ state: 'intercepting', hookName: event.hookName });
          break;

        case 'dummy_hook_end':
          setDummyHookStatus(prev => (prev ? { state: 'hooked', hookName: prev.hookName } : null));
          break;

        case 'tokens_consumed':
          // The backend yields chat_updated immediately after every
          // tokens_consumed, so React sees the new totals via setChat.
          break;

        case 'lock_state_changed':
          setIsLockedByIncompleteTail(event.locked);
          break;
      }
    },
    [chatId, applyToolBlockBatch]
  );

  // ============================================================================
  // Session lifecycle + initial chat load
  // ============================================================================

  useEffect(() => {
    let cancelled = false;
    let messagesLoadedFired = false;
    // Reset lock state on chat switch — the snapshot phase of the new
    // attachChat will deliver the authoritative value within one round trip,
    // but defaulting to `false` here avoids a one-frame flicker showing the
    // old chat's banner.
    setIsLockedByIncompleteTail(false);
    const session = new GremlinSession(gremlinClient, chatId);
    sessionRef.current = session;

    session.onEvent(event => {
      if (cancelled) return;
      handleLoopEvent(event);
      // The backend's `attachChat` dispatcher yields `snapshot_complete`
      // immediately after delivering the chat + persisted messages. That
      // marker is exactly when the chat-view's "messages loaded" callback
      // wants to fire (it used to fire from a separate
      // `gremlinClient.getMessages` call before the attachChat-based load).
      if (!messagesLoadedFired && event.type === 'snapshot_complete') {
        messagesLoadedFired = true;
        setMessages(prev => {
          callbacksRef.current.onMessagesLoaded(chatId, prev);
          return prev;
        });
      }
    });
    session.onEnd((_status, _detail) => {
      // The legacy onEnd path fires from runLoop stream consumers; the new
      // attachChat-based flow signals end via the `loop_ended` event handled
      // in handleLoopEvent above. Kept as a hook for the rare case where the
      // attachChat stream itself errors out — leave the cleanup there.
    });
    session.onError(error => {
      if (cancelled) return;
      console.error('[useChat] Loop error:', error.message);
    });

    // Open the long-lived `attachChat` subscription. The first batch of
    // events delivers chat + persisted messages; subsequent events are live
    // from any loop running on this chat. session.attach() resolves only
    // when the stream ends (typically on dispose), so we don't await it.
    void session.attach();

    // Load project + API definition. The chat itself comes via attachChat's
    // snapshot, but we need the chat's projectId synchronously to fetch the
    // project. Easiest path: read it directly via getChat. Both this load and
    // the attachChat snapshot deliver the same chat record; the snapshot's
    // `chat_updated` event idempotently overwrites our `setChat` below.
    const loadAuxData = async () => {
      const loadedChat = await gremlinClient.getChat(chatId);
      if (cancelled) return;
      if (!loadedChat) {
        throw new Error(`Chat not found: ${chatId}`);
      }
      setChat(loadedChat);

      const loadedProject = await gremlinClient.getProject(loadedChat.projectId);
      if (cancelled) return;
      if (!loadedProject) {
        throw new Error(`Project not found: ${loadedChat.projectId}`);
      }
      setProject(loadedProject);

      const effectiveApiDefId = loadedChat.apiDefinitionId ?? loadedProject.apiDefinitionId;
      if (effectiveApiDefId) {
        const loadedApiDef = await gremlinClient.getAPIDefinition(effectiveApiDefId);
        if (cancelled) return;
        setApiDefinition(loadedApiDef);
      }
    };

    loadAuxData().catch(err => {
      if (!cancelled) {
        console.error('[useChat] Failed to load auxiliary chat data:', err);
      }
    });

    return () => {
      cancelled = true;
      session.dispose();
      sessionRef.current = null;
      if (streamingTimerRef.current) clearTimeout(streamingTimerRef.current);
      if (toolUpdateTimerRef.current) clearTimeout(toolUpdateTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  // ============================================================================
  // Derived state
  // ============================================================================

  const tokenUsage: TokenUsage = useMemo(() => {
    if (!chat) {
      return { input: 0, output: 0, cost: 0 };
    }
    return {
      input: chat.totalInputTokens || 0,
      output: chat.totalOutputTokens || 0,
      reasoning: (chat.totalReasoningTokens || 0) > 0 ? chat.totalReasoningTokens : undefined,
      cacheCreation:
        (chat.totalCacheCreationTokens || 0) > 0 ? chat.totalCacheCreationTokens : undefined,
      cacheRead: (chat.totalCacheReadTokens || 0) > 0 ? chat.totalCacheReadTokens : undefined,
      cost: chat.totalCost || 0,
    };
  }, [chat]);

  const minionTokenUsage: TokenUsage = useMemo(() => {
    if (!chat) {
      return { input: 0, output: 0, cost: 0 };
    }
    return {
      input: chat.minionTotalInputTokens || 0,
      output: chat.minionTotalOutputTokens || 0,
      reasoning:
        (chat.minionTotalReasoningTokens || 0) > 0 ? chat.minionTotalReasoningTokens : undefined,
      cacheCreation:
        (chat.minionTotalCacheCreationTokens || 0) > 0
          ? chat.minionTotalCacheCreationTokens
          : undefined,
      cacheRead:
        (chat.minionTotalCacheReadTokens || 0) > 0 ? chat.minionTotalCacheReadTokens : undefined,
      cost: chat.minionTotalCost || 0,
    };
  }, [chat]);

  // Reload the API definition record when the chat/project override changes
  // (affects only the apiType used by `resolvePendingToolCalls('stop')`).
  useEffect(() => {
    if (!chat || !project) return;
    const effectiveApiDefId = chat.apiDefinitionId ?? project.apiDefinitionId;
    if (effectiveApiDefId && effectiveApiDefId !== apiDefinition?.id) {
      gremlinClient.getAPIDefinition(effectiveApiDefId).then(loaded => {
        if (loaded) setApiDefinition(loaded);
      });
    }
  }, [chat, project, apiDefinition?.id]);

  const isLoading = loopPhase !== 'idle';

  const showContinueBanner = useMemo(
    () =>
      loopPhase === 'idle' &&
      messages.length > 0 &&
      isToolResultMessage(messages[messages.length - 1]),
    [loopPhase, messages]
  );

  const unresolvedToolCalls = useMemo(() => {
    if (loopPhase !== 'idle') return null;
    return getUnresolvedToolCalls(messages);
  }, [messages, loopPhase]);

  // ============================================================================
  // Imperative commands — these all delegate into GremlinSession or gremlinClient
  // ============================================================================

  const sendMessage = async (
    incomingChatId: string,
    content: string,
    attachments?: MessageAttachment[]
  ) => {
    if (!verifyChatId(incomingChatId, 'sendMessage')) return;
    if (!chat || !project || !sessionRef.current) return;
    if (isLockedByIncompleteTail) {
      await showAlert(
        'Chat Locked',
        'The last assistant message was aborted. Resolve it (delete the message or roll back) before continuing.'
      );
      return;
    }

    const messageText = content.trim();
    if (!messageText && (!attachments || attachments.length === 0)) return;

    const effectiveModelId = chat.modelId ?? project.modelId;
    if (!effectiveModelId) {
      await showAlert(
        'Configuration Required',
        'Please configure a model for this chat or project.'
      );
      return;
    }

    setLoopPhase('pending');
    try {
      await sessionRef.current.send(content, attachments);
    } catch (err) {
      console.error('[useChat] sendMessage error:', err);
      setLoopPhase('idle');
    }
  };

  const editMessage = async (incomingChatId: string, messageId: string, _content: string) => {
    if (!verifyChatId(incomingChatId, 'editMessage')) return;
    if (!chat) return;

    const messageIndex = messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) return;

    // Recalculate context window from remaining messages.
    const remainingMessages = messages.slice(0, messageIndex);
    let contextWindowUsage = 0;
    for (let i = remainingMessages.length - 1; i >= 0; i--) {
      const msg = remainingMessages[i];
      if (msg.role === 'assistant' && msg.metadata?.contextWindowUsage !== undefined) {
        contextWindowUsage = msg.metadata.contextWindowUsage;
        break;
      }
    }

    const updatedChat = {
      ...chat,
      contextWindowUsage,
      lastModifiedAt: new Date(),
    };

    setChat(updatedChat);
    setMessages(prev => prev.slice(0, messageIndex));
    callbacksRef.current.onChatMetadataChanged?.(updatedChat.id, updatedChat);
    callbacksRef.current.onMessagesRemovedOnAndAfter(updatedChat.id, messageId);

    await gremlinClient.saveChat(updatedChat);
    await gremlinClient.deleteMessageAndAfter(incomingChatId, messageId);
  };

  const copyMessage = async (_incomingChatId: string, messageId: string) => {
    const message = messages.find(m => m.id === messageId);
    if (!message) return;
    try {
      const { stripMetadata } = await import('../lib/messageFormatters');
      const contentWithoutMetadata = stripMetadata(message.content.content);
      await navigator.clipboard.writeText(contentWithoutMetadata);
      await showAlert('Copied', 'Message copied to clipboard');
    } catch {
      await showAlert('Error', 'Failed to copy message');
    }
  };

  const forkChat = async (
    incomingChatId: string,
    messageId: string
  ): Promise<{ id: string } | null> => {
    if (!verifyChatId(incomingChatId, 'forkChat')) return null;
    if (!chat || !project) return null;

    const message = messages.find(m => m.id === messageId);
    const messageContent = message?.content.content;
    const result = await gremlinClient.cloneChat(chat.id, messageId, messageContent);
    return { id: result.newChatId };
  };

  const overrideModel = async (
    incomingChatId: string,
    apiDefId: string | null,
    modelId: string | null
  ) => {
    if (!verifyChatId(incomingChatId, 'overrideModel')) return;
    if (!chat) return;

    const updatedChat = {
      ...chat,
      apiDefinitionId: apiDefId,
      modelId,
      lastModifiedAt: new Date(),
    };
    setChat(updatedChat);
    callbacksRef.current.onChatMetadataChanged?.(incomingChatId, updatedChat);
    await gremlinClient.saveChat(updatedChat);
  };

  const updateChatName = async (incomingChatId: string, name: string) => {
    if (!verifyChatId(incomingChatId, 'updateChatName')) return;
    if (!chat || !name.trim()) return;

    const updatedChat = {
      ...chat,
      name: name.trim(),
      lastModifiedAt: new Date(),
    };
    setChat(updatedChat);
    callbacksRef.current.onChatMetadataChanged?.(chat.id, updatedChat);
    await gremlinClient.saveChat(updatedChat);
  };

  const resolvePendingToolCalls = async (
    mode: 'stop' | 'continue',
    userMessage?: string,
    attachments?: MessageAttachment[]
  ) => {
    if (!chat || !project || !sessionRef.current) return;
    if (!unresolvedToolCalls || unresolvedToolCalls.length === 0) return;

    setLoopPhase('pending');
    try {
      if (mode === 'continue') {
        // Continue: hand the unresolved tool blocks + optional follow-up to
        // the backend. The agentic loop executes the tools, persists their
        // results, then injects the follow-up before the next API call.
        await sessionRef.current.resolveContinue(
          unresolvedToolCalls,
          userMessage?.trim() || undefined,
          attachments
        );
      } else {
        // Stop: synthesize error tool results client-side, save them (so
        // the next backend load picks them up), optimistically update
        // React state, optionally save a user follow-up too, then call
        // continueLoop. The backend sees a chat history that already has
        // the rejection + follow-up baked in and runs from there.
        const { createToolResultRenderBlock } =
          await import('../../shared/services/agentic/agenticLoopGenerator');
        const { generateUniqueId } = await import('../../shared/protocol/idGenerator');
        const apiType = apiDefinition?.apiType ?? 'chatgpt';
        const toolResultRenderBlocks: ToolResultRenderBlock[] = [];
        const toolResults: {
          type: 'tool_result';
          tool_use_id: string;
          name: string;
          content: string;
          is_error: true;
        }[] = [];
        for (const toolUse of unresolvedToolCalls) {
          const errorMessage = 'User rejected the tool call';
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            name: toolUse.name,
            content: errorMessage,
            is_error: true,
          });
          toolResultRenderBlocks.push(
            createToolResultRenderBlock(toolUse.id, toolUse.name, errorMessage, true)
          );
        }
        const toolResultMessage: Message<unknown> = {
          id: generateUniqueId('msg_user'),
          role: 'user',
          content: {
            type: 'text',
            content: '',
            modelFamily: apiType,
            toolResults,
            renderingContent: [{ category: 'backstage', blocks: toolResultRenderBlocks }],
          },
          timestamp: new Date(),
        };
        await gremlinClient.saveMessage(chat.id, toolResultMessage);
        setMessages(prev => [...prev, toolResultMessage]);
        callbacksRef.current.onMessageAppended(chatId, toolResultMessage);

        // Optional user follow-up — save it to storage too so the loop
        // picks it up from the message history.
        const followUpText = (userMessage ?? '').trim();
        if (followUpText || (attachments && attachments.length > 0)) {
          const followUpMessage: Message<unknown> = {
            id: generateUniqueId('msg_user'),
            role: 'user',
            content: {
              type: 'text',
              content: followUpText,
              renderingContent: [
                { category: 'text', blocks: [{ type: 'text', text: followUpText }] },
              ],
            },
            timestamp: new Date(),
          };
          await gremlinClient.saveMessage(chat.id, followUpMessage);
          setMessages(prev => [...prev, followUpMessage]);
          callbacksRef.current.onMessageAppended(chatId, followUpMessage);
        }

        await sessionRef.current.continueLoop();
      }
    } catch (err) {
      console.error('[useChat] resolvePendingToolCalls error:', err);
      setLoopPhase('idle');
    }
  };

  const resendFromMessage = async (messageId: string) => {
    if (!chat || !project || !sessionRef.current) return;
    setLoopPhase('pending');
    try {
      await sessionRef.current.retry(messageId);
    } catch (err) {
      console.error('[useChat] resendFromMessage error:', err);
      setLoopPhase('idle');
    }
  };

  const requestSoftStop = useCallback(() => {
    setSoftStopRequested(true);
    sessionRef.current?.softStop().catch(err => {
      console.error('[useChat] softStop error:', err);
    });
  }, []);

  const continueAfterToolStop = async () => {
    if (!chat || !project || !sessionRef.current) return;
    setLoopPhase('pending');
    try {
      await sessionRef.current.continueLoop();
    } catch (err) {
      console.error('[useChat] continueAfterToolStop error:', err);
      setLoopPhase('idle');
    }
  };

  return {
    chat,
    messages,
    isLoading,
    loopPhase,
    showContinueBanner,
    tokenUsage,
    minionTokenUsage,
    streamingGroups,
    currentApiDefId: chat?.apiDefinitionId ?? project?.apiDefinitionId ?? null,
    currentModelId: chat?.modelId ?? project?.modelId ?? null,
    parentApiDefId: project?.apiDefinitionId ?? null,
    parentModelId: project?.modelId ?? null,
    unresolvedToolCalls,
    softStopRequested,
    dummyHookStatus,
    isLockedByIncompleteTail,
    sendMessage,
    editMessage,
    copyMessage,
    forkChat,
    overrideModel,
    updateChatName,
    resolvePendingToolCalls,
    resendFromMessage,
    requestSoftStop,
    continueAfterToolStop,
  };
}
