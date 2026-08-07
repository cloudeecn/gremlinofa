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
import { activeLoopsStore, gremlinClient, GremlinSession } from '../client';
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
import {
  applyGroupsDelta,
  assembleGroups,
  type ToolGroupsState,
} from '../../shared/services/tools/toolGroupsDelta';

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
/**
 * For claude-agent chats: compute the SDK rewind to apply when deleting
 * messages from `cutoffIndex` onward (i.e., editing a user message at
 * cutoffIndex, which removes it and everything after). The next send
 * should resume the SDK "up to and including" the most recent assistant
 * message strictly before cutoffIndex.
 *
 * - If a prior assistant message with `claudeAgentMessageUuid` exists →
 *   set `claudeAgentResumeAt = thatUuid` (sessionId preserved).
 * - Otherwise → drop the session entirely so the next send starts a
 *   fresh SDK session.
 *
 * Returns `{}` for non-claude-agent chats — nothing to plumb.
 */
function computeClaudeAgentRewindBefore(
  chat: Chat,
  messages: Message<unknown>[],
  cutoffIndex: number
): Pick<Chat, 'claudeAgentResumeAt' | 'claudeAgentSessionId'> {
  if (!chat.claudeAgentSessionId) return {};
  for (let i = cutoffIndex - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.metadata?.claudeAgentMessageUuid) {
      console.debug(
        '[useChat] claude-agent rewind: resumeAt=%s (assistant msg %d)',
        m.metadata.claudeAgentMessageUuid,
        i
      );
      return { claudeAgentResumeAt: m.metadata.claudeAgentMessageUuid };
    }
  }
  console.debug('[useChat] claude-agent rewind: no prior assistant — fresh session');
  return { claudeAgentSessionId: undefined, claudeAgentResumeAt: undefined };
}

/**
 * Variant for rollback-on-assistant: keeps the message at `targetIndex`
 * (which the UI guarantees is an assistant message) and discards
 * everything after. SDK should resume "up to and including" the target.
 */
function computeClaudeAgentRewindKeeping(
  chat: Chat,
  messages: Message<unknown>[],
  targetIndex: number
): Pick<Chat, 'claudeAgentResumeAt' | 'claudeAgentSessionId'> {
  if (!chat.claudeAgentSessionId) return {};
  const target = messages[targetIndex];
  if (target?.role === 'assistant' && target.metadata?.claudeAgentMessageUuid) {
    console.debug(
      '[useChat] claude-agent rollback: resumeAt=%s (kept assistant msg %d)',
      target.metadata.claudeAgentMessageUuid,
      targetIndex
    );
    return { claudeAgentResumeAt: target.metadata.claudeAgentMessageUuid };
  }
  // Target isn't an assistant with a stored UUID — fall back to the
  // "rewind to before" semantics so the SDK at least lands on a sane
  // boundary instead of staying stuck on stale state.
  return computeClaudeAgentRewindBefore(chat, messages, targetIndex + 1);
}

/**
 * Split a claude-agent rewind patch into surgical `fields` (keys to set) and
 * `unset` (keys to clear). Clears MUST go through `unset` — the JSON wire drops
 * undefined-valued fields, so a `{ x: undefined }` overlay would silently be a
 * no-op patch instead of clearing the SDK session.
 */
function splitRewindPatch(rewind: Partial<Chat>): {
  fields: Partial<Chat>;
  unset: (keyof Chat)[];
} {
  const fields: Partial<Chat> = {};
  const unset: (keyof Chat)[] = [];
  for (const key of Object.keys(rewind) as (keyof Chat)[]) {
    if (rewind[key] === undefined) unset.push(key);
    else (fields as Record<string, unknown>)[key as string] = rewind[key];
  }
  return { fields, unset };
}

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
  /** True while the initial or reconnect snapshot is being replayed. */
  snapshotLoading: boolean;
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
  /** Roll back to a message — delete everything after it, keep the target */
  rollbackToMessage: (chatId: string, messageId: string) => Promise<void>;
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
  // True while the initial (or reconnect) snapshot is being replayed — the
  // UI suppresses auto-scroll, locks input, and gates flickery derived state.
  const [snapshotLoading, setSnapshotLoading] = useState(true);

  // Reset the lock/snapshot flags whenever chatId changes — the snapshot
  // phase of the new attachChat will deliver the authoritative values within
  // one round trip, but defaulting here avoids a one-frame flicker showing
  // the old chat's banner. Adjusted during render (rather than in the
  // session-lifecycle effect) to keep react-hooks/set-state-in-effect happy.
  const [prevChatId, setPrevChatId] = useState(chatId);
  if (prevChatId !== chatId) {
    setPrevChatId(chatId);
    setIsLockedByIncompleteTail(false);
    setSnapshotLoading(true);
  }

  // Mirror messages state in a ref so `handleLoopEvent` (which doesn't
  // have `messages` in its dependency array) can read the latest committed
  // value — needed by `reconnect_start` to build the recon map. The effect
  // runs after every commit; `handleLoopEvent` only fires from async network
  // events that arrive post-commit, so the one-tick lag is irrelevant.
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  });

  // Throttle state for streaming UI updates. Refs (not state) so the
  // throttled callbacks can read the latest pending value without
  // re-creating their closure on every render.
  const pendingStreamingRef = useRef<RenderingBlockGroup[] | null>(null);
  const streamingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingToolUpdatesRef = useRef<Map<string, Partial<ToolResultRenderBlock>>>(new Map());
  const toolUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Per-`toolUseId` reconstructed `renderingGroups` state, accumulated from
  // `tool_groups_delta` events emitted by delta-encoded tools (minion). A
  // throttled flush projects the assembled `[info, ...accum, ...streaming]`
  // groups into the matching placeholder message's `renderingContent` via
  // the existing `applyToolBlockBatch` projection. Cleared on `loop_ended`.
  // Notably NOT cleared on `reconnect_start`: the live state survives the
  // disconnect, and a `tool_groups_snapshot` from the attach replay will
  // overwrite each entry — if no snapshot lands, the entry is harmless and
  // `loop_ended` will clean it up.
  const toolGroupsRef = useRef<Map<string, ToolGroupsState>>(new Map());
  const toolGroupsDirtyRef = useRef<Set<string>>(new Set());
  const toolGroupsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reconnect reconciliation state. Built on `reconnect_start`, consumed
  // during the snapshot replay, discarded on `snapshot_complete`.
  const reconMapRef = useRef<Map<string, number> | null>(null);
  const reconPosRef = useRef(0);
  const reconTruncatedRef = useRef(false);

  // IDs of in-flight pending tool result messages not yet finalized by
  // a `message_created` event. Stripped from state on reconnect so the
  // snapshot's finalized version lands through the normal mismatch path.
  const unstableMessageIdsRef = useRef<Set<string>>(new Set());

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
            const current = (block as ToolResultRenderBlock).status;
            const merged = { ...block, ...update };
            // Never downgrade a terminal block: the tool-block and
            // tool-groups buffers flush on independent timers, so a stale
            // non-terminal status may land after 'complete'/'error'.
            if (
              (current === 'complete' || current === 'error') &&
              update.status !== 'complete' &&
              update.status !== 'error'
            ) {
              merged.status = current;
            }
            return merged;
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

  /**
   * Project the dirty entries from `toolGroupsRef` into placeholder
   * messages by assembling each entry's `[info, ...accum, ...streaming]`
   * and reusing the existing `tool_block_update` projection — same target
   * search, same backward-scan logic, no duplicated state path.
   */
  const flushToolGroupsBatch = useCallback(() => {
    if (toolGroupsDirtyRef.current.size === 0) return;
    const batch = new Map<string, Partial<ToolResultRenderBlock>>();
    for (const toolUseId of toolGroupsDirtyRef.current) {
      const state = toolGroupsRef.current.get(toolUseId);
      if (!state) continue;
      // Project only the groups — status is owned by `tool_block_update`
      // events ('running' at tool start, 'complete'/'error' at tool end).
      // Writing 'running' here would race the tool-block flush on its own
      // timer and could clobber a finished block back to running, hiding
      // the minion result box until reload.
      batch.set(toolUseId, {
        renderingGroups: assembleGroups(state),
      });
    }
    toolGroupsDirtyRef.current.clear();
    if (batch.size > 0) applyToolBlockBatch(batch);
  }, [applyToolBlockBatch]);

  /** Schedule a throttled projection of accumulated tool-group deltas. */
  const scheduleToolGroupsFlush = useCallback(() => {
    if (toolGroupsTimerRef.current) return;
    toolGroupsTimerRef.current = setTimeout(() => {
      toolGroupsTimerRef.current = null;
      flushToolGroupsBatch();
    }, STREAMING_THROTTLE_MS);
  }, [flushToolGroupsBatch]);

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
    if (toolGroupsTimerRef.current) {
      clearTimeout(toolGroupsTimerRef.current);
      toolGroupsTimerRef.current = null;
    }
    flushToolGroupsBatch();
  }, [applyToolBlockBatch, flushToolGroupsBatch]);

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
          // Seed the soft-stop indicator from backend canon rather than
          // forcing false. A fresh loop has the flag unset in the registry;
          // a re-attach (attachChat synthesizes loop_started) carries the
          // real request through the ActiveLoopsStore snapshot, so the
          // "Stopping…" button survives a chat switch.
          setSoftStopRequested(
            activeLoopsStore.getSnapshot().find(l => l.chatId === chatId)?.softStopRequested ??
              false
          );
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
          toolGroupsRef.current.clear();
          toolGroupsDirtyRef.current.clear();
          callbacksRef.current.onStreamingEnd(chatId);
          if (event.status !== 'complete') {
            console.debug('[useChat] loop_ended:', event.status);
          }
          break;

        case 'reconnect_start': {
          setSnapshotLoading(true);

          // Discard transient streaming state — the snapshot will
          // re-establish it via synthetic loop_started / tool events
          // if a loop is still running.
          if (streamingTimerRef.current) {
            clearTimeout(streamingTimerRef.current);
            streamingTimerRef.current = null;
          }
          pendingStreamingRef.current = null;
          setStreamingGroups([]);
          if (toolUpdateTimerRef.current) {
            clearTimeout(toolUpdateTimerRef.current);
            toolUpdateTimerRef.current = null;
          }
          pendingToolUpdatesRef.current.clear();
          // Tool-groups projection timer: cancel the pending flush and
          // wipe the dirty set. The `tool_groups_snapshot` from the
          // attach replay will repopulate `toolGroupsRef` and re-dirty
          // each tool's entry, so the next throttle window projects the
          // post-reconnect state, not stale pre-reconnect leftovers. The
          // `toolGroupsRef` map itself is intentionally preserved — if
          // the loop completed during disconnect, `loop_ended` clears it.
          if (toolGroupsTimerRef.current) {
            clearTimeout(toolGroupsTimerRef.current);
            toolGroupsTimerRef.current = null;
          }
          toolGroupsDirtyRef.current.clear();
          setLoopPhase('idle');
          setDummyHookStatus(null);
          setSoftStopRequested(false);

          // Strip unstable (pending tool result) messages — the snapshot
          // will deliver the finalized versions as new messages.
          let base = messagesRef.current;
          if (unstableMessageIdsRef.current.size > 0) {
            base = base.filter(m => !unstableMessageIdsRef.current.has(m.id));
            setMessages(base);
            messagesRef.current = base;
            unstableMessageIdsRef.current = new Set();
          }

          // Build reconciliation map so the incoming snapshot can diff
          // positionally instead of duplicating. Must be synchronous (not
          // inside a setMessages updater) because React defers updaters
          // and the next event would read the ref before the updater runs.
          const map = new Map<string, number>();
          base.forEach((msg, idx) => map.set(msg.id, idx));
          reconMapRef.current = map;
          reconPosRef.current = 0;
          reconTruncatedRef.current = false;
          break;
        }

        case 'partial_reconsolidate': {
          // Server matched a prefix — fast-forward reconPosRef past the
          // matched messages so reconciliation only covers the tail.
          const reconMap = reconMapRef.current;
          if (reconMap) {
            const localIdx = reconMap.get(event.lastMatchedMessageId);
            if (localIdx !== undefined) {
              reconPosRef.current = localIdx + 1;
            }
          }
          break;
        }

        case 'snapshot_complete':
          // Finalize reconciliation: trim trailing messages the server
          // no longer has (e.g. deleted during disconnect).
          if (reconMapRef.current) {
            if (!reconTruncatedRef.current) {
              const trimAt = reconPosRef.current;
              setMessages(prev => (prev.length > trimAt ? prev.slice(0, trimAt) : prev));
            }
            reconMapRef.current = null;
          }
          setSnapshotLoading(false);
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

        case 'streaming_snapshot':
          // attachChat replay of the in-flight assistant bubble (text +
          // thinking + provider-side tool results). Apply directly, bypassing
          // the streaming throttle, so the bubble repaints instantly on
          // reattach instead of waiting for the next live `streaming_chunk`.
          // Any live chunk arriving after lands on top via the normal path.
          pendingStreamingRef.current = null;
          setStreamingGroups(event.groups);
          break;

        case 'message_created': {
          const msg = event.message;
          const reconMap = reconMapRef.current;

          if (reconMap && !reconTruncatedRef.current) {
            // Reconciliation mode — positional matching against pre-reconnect state.
            const expectedPos = reconPosRef.current;
            const oldIdx = reconMap.get(msg.id);

            if (oldIdx !== undefined && oldIdx === expectedPos) {
              // Position match — persisted messages are immutable, skip entirely.
              reconPosRef.current = expectedPos + 1;
              break;
            }
            // First mismatch — truncate at expected position, append.
            reconTruncatedRef.current = true;
            reconPosRef.current = expectedPos + 1;
            setMessages(prev => [...prev.slice(0, expectedPos), msg]);
          } else if (reconMap) {
            // Already truncated — append remaining snapshot messages.
            reconPosRef.current += 1;
            setMessages(prev => [...prev, msg]);
          } else {
            // Normal mode — dedup against recent messages for retransmissions.
            setMessages(prev => {
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
          }

          // Finalized message supersedes any pending placeholder.
          unstableMessageIdsRef.current.delete(msg.id);

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
          unstableMessageIdsRef.current.add(msg.id);
          // In reconciliation mode (reconnect snapshot replay), pending_tool_result
          // always arrives AFTER persisted message_created events — the placeholder
          // belongs at the matched-prefix tail. Take the same truncate+append path
          // message_created uses on first mismatch, so snapshot_complete's trim
          // becomes a no-op and the placeholder survives. Without this, an
          // in-flight minion's progress vanishes on reconnect because the
          // placeholder carrying its tool_result block is sliced off before the
          // follow-up tool_block_update can populate renderingGroups.
          if (reconMapRef.current && !reconTruncatedRef.current) {
            const expectedPos = reconPosRef.current;
            reconTruncatedRef.current = true;
            reconPosRef.current = expectedPos + 1;
            setMessages(prev => [...prev.slice(0, expectedPos), msg]);
          } else {
            setMessages(prev => {
              const searchStart = Math.max(0, prev.length - 10);
              for (let i = prev.length - 1; i >= searchStart; i--) {
                if (prev[i].id === msg.id) return prev;
              }
              return [...prev, msg];
            });
          }
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

        case 'tool_groups_delta': {
          const next = applyGroupsDelta(toolGroupsRef.current.get(event.toolUseId), event.delta);
          if (!next) break;
          toolGroupsRef.current.set(event.toolUseId, next);
          toolGroupsDirtyRef.current.add(event.toolUseId);
          // First sign of streamed content from a delta-encoded tool
          // means the loop has crossed into the streaming phase. The
          // `first_chunk` event covers the assistant's own streaming,
          // but minion tool runs ride this code path instead — flip the
          // phase here so the chat view shows the streaming UI rather
          // than the pending spinner.
          if (next.streamingGroups.length > 0) {
            setLoopPhase(prev => (prev === 'streaming' ? prev : 'streaming'));
          }
          scheduleToolGroupsFlush();
          break;
        }

        case 'tool_groups_snapshot': {
          toolGroupsRef.current.set(event.toolUseId, {
            infoGroup: event.infoGroup,
            accumulatedGroups: event.accumulatedGroups.slice(),
            streamingGroups: event.streamingGroups.slice(),
          });
          toolGroupsDirtyRef.current.add(event.toolUseId);
          // Rehydration after reconnect: if the snapshot carries in-flight
          // streaming content we want the streaming UI back immediately,
          // not stuck in `pending` until the next live delta arrives.
          if (event.streamingGroups.length > 0) {
            setLoopPhase(prev => (prev === 'streaming' ? prev : 'streaming'));
          }
          scheduleToolGroupsFlush();
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
    [chatId, applyToolBlockBatch, flushThrottledBuffers, scheduleToolGroupsFlush]
  );

  // ============================================================================
  // Session lifecycle + initial chat load
  // ============================================================================

  useEffect(() => {
    let cancelled = false;
    let messagesLoadedFired = false;
    // Note: the lock / snapshot-loading flags are reset during render (see the
    // prevChatId tracker above) — keep them out of this effect.
    const session = new GremlinSession(gremlinClient, chatId);
    sessionRef.current = session;

    session.setKnownMessageIdsProvider(() => {
      const msgs = messagesRef.current;
      return msgs.slice(-20).map(m => m.id);
    });

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
      if (toolGroupsTimerRef.current) clearTimeout(toolGroupsTimerRef.current);
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
      !snapshotLoading &&
      loopPhase === 'idle' &&
      messages.length > 0 &&
      messages[messages.length - 1].role === 'user' &&
      !getUnresolvedToolCalls(messages),
    [snapshotLoading, loopPhase, messages]
  );

  const unresolvedToolCalls = useMemo(() => {
    if (snapshotLoading || loopPhase !== 'idle') return null;
    return getUnresolvedToolCalls(messages);
  }, [snapshotLoading, messages, loopPhase]);

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

    // claude-agent: rewind the SDK session to the assistant turn that
    // preceded the message being edited. If no prior assistant exists
    // (e.g., editing the first user message), drop the session so the
    // next send starts a fresh one.
    const sdkRewind = computeClaudeAgentRewindBefore(chat, messages, messageIndex);

    const updatedChat = {
      ...chat,
      contextWindowUsage,
      lastModifiedAt: new Date(),
      ...sdkRewind,
    };

    setChat(updatedChat);
    setMessages(prev => prev.slice(0, messageIndex));
    callbacksRef.current.onChatMetadataChanged?.(updatedChat.id, updatedChat);
    callbacksRef.current.onMessagesRemovedOnAndAfter(updatedChat.id, messageId);

    // Patch only the fields we touch (+ SDK rewind clears via `unset`) so we
    // don't clobber unrelated chat state with a whole-object write.
    const { fields: sdkFields, unset: sdkUnset } = splitRewindPatch(sdkRewind);
    await gremlinClient.patchChat(
      incomingChatId,
      { contextWindowUsage, ...sdkFields },
      { touch: true, unset: sdkUnset }
    );
    await gremlinClient.deleteMessageAndAfter(incomingChatId, messageId);
  };

  const rollbackToMessage = async (incomingChatId: string, messageId: string) => {
    if (!verifyChatId(incomingChatId, 'rollbackToMessage')) return;
    if (!chat) return;

    const messageIndex = messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) return;
    if (messageIndex === messages.length - 1) return; // nothing after — no-op

    const nextMessageId = messages[messageIndex + 1].id;

    // Recalculate context window from remaining messages (including target).
    const remainingMessages = messages.slice(0, messageIndex + 1);
    let contextWindowUsage = 0;
    for (let i = remainingMessages.length - 1; i >= 0; i--) {
      const msg = remainingMessages[i];
      if (msg.role === 'assistant' && msg.metadata?.contextWindowUsage !== undefined) {
        contextWindowUsage = msg.metadata.contextWindowUsage;
        break;
      }
    }

    // claude-agent: rollback target is itself an assistant message (UI
    // hides this button on user messages for claude-agent chats). Resume
    // "up to and including" THIS assistant so the SDK history matches
    // what we kept locally.
    const sdkRewind = computeClaudeAgentRewindKeeping(chat, messages, messageIndex);

    const updatedChat = {
      ...chat,
      contextWindowUsage,
      lastModifiedAt: new Date(),
      ...sdkRewind,
    };

    setChat(updatedChat);
    setMessages(prev => prev.slice(0, messageIndex + 1));
    callbacksRef.current.onChatMetadataChanged?.(updatedChat.id, updatedChat);
    callbacksRef.current.onMessagesRemovedOnAndAfter(updatedChat.id, nextMessageId);

    const { fields: sdkFields, unset: sdkUnset } = splitRewindPatch(sdkRewind);
    await gremlinClient.patchChat(
      incomingChatId,
      { contextWindowUsage, ...sdkFields },
      { touch: true, unset: sdkUnset }
    );
    await gremlinClient.deleteMessageAndAfter(incomingChatId, nextMessageId);
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
    // Patch only the override fields (+ touch) so an in-flight loop's token
    // totals survive. `null` clears the override; it crosses the wire fine
    // (only `undefined` is dropped).
    await gremlinClient.patchChat(
      incomingChatId,
      { apiDefinitionId: apiDefId, modelId },
      { touch: true }
    );
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
    // Patch only the name (+ touch) so a rename mid-loop doesn't clobber the
    // loop's token totals (and vice versa).
    await gremlinClient.patchChat(chat.id, { name: name.trim() }, { touch: true });
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
    snapshotLoading,
    sendMessage,
    editMessage,
    copyMessage,
    forkChat,
    overrideModel,
    updateChatName,
    resolvePendingToolCalls,
    resendFromMessage,
    rollbackToMessage,
    requestSoftStop,
    continueAfterToolStop,
  };
}
