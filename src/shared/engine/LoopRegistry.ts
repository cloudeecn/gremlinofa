/**
 * Tracks every running agentic loop on the backend.
 *
 * Owned by `GremlinServer`. `ChatRunner` registers itself here on loop start
 * and ends itself here on terminal status. The sidebar Running Loops UI
 * subscribes via `subscribe()` (the `subscribeActiveLoops` RPC fans out the
 * resulting `ActiveLoopsChange` events to clients).
 *
 * Each registry entry holds the `AbortController` for that loop so a hard
 * abort from any client (or any tab in Phase 2) can fire `controller.abort()`
 * synchronously and let `agenticLoopGenerator`'s `throwIfAborted()` boundaries
 * trip on the next iteration.
 *
 * Lifecycle of a registered loop:
 *   register() → status: 'running'
 *   abort()    → status: 'aborting' (controller fires; the actual unwind
 *                 happens inside `agenticLoopGenerator`'s try/finally)
 *   end()      → entry removed, `ended` change broadcast with terminal status
 */

import type { ToolResultRenderBlock } from '../protocol/types/content';
import type { Message, RenderingBlockGroup, ToolResultBlock } from '../protocol/types';
import type { ActiveLoop, ActiveLoopsChange, LoopEvent, LoopId } from '../protocol/protocol';
import { applyGroupsDelta, type ToolGroupsState } from '../services/tools/toolGroupsDelta';

/** Internal record — adds the controller and a soft-stop flag. */
interface RegistryEntry {
  loop: ActiveLoop;
  abortController: AbortController;
  /**
   * Set by `softStop()` and read by the agentic loop's `shouldStop` callback
   * (which `ChatRunner` wires to `isSoftStopRequested(loopId)`). Soft stop is
   * a separate signal from hard abort: it lets the loop finish the current
   * tool round and then cleanly return a `soft_stopped` status.
   */
  softStopRequested: boolean;
}

/**
 * Snapshot of a single in-flight pending tool result. The cache below
 * keeps one of these per `toolUseId`, indexed by `chatId`, so an
 * `attachChat` re-subscriber can replay the placeholder message AND its
 * latest accumulated `renderingGroups` instead of waiting for the tool
 * to finish before any UI shows up.
 */
export interface PendingToolResultSnapshot {
  toolUseId: string;
  message: Message<unknown>;
  /**
   * The merged block state from every `tool_block_update` event for this
   * `toolUseId` since the placeholder was emitted. Merging mirrors the
   * frontend's `useChat` throttler — `{...existing, ...new}` per event.
   */
  mergedBlock: Partial<ToolResultRenderBlock>;
  /**
   * Per-`toolUseId` reconstructed `renderingGroups` state, fed by
   * `tool_groups_delta` events. `attachChat` emits this as a single
   * `tool_groups_snapshot` so a re-subscribing client doesn't have to wait
   * for the next live delta to rehydrate the streaming UI. `undefined`
   * until the first `init` delta lands for the tool call.
   */
  groupsState?: ToolGroupsState;
}

/** Subscriber callback. Receives one `snapshot` event immediately on subscribe. */
export type ActiveLoopsSubscriber = (change: ActiveLoopsChange) => void;

/** Per-chat event subscriber. Receives every LoopEvent broadcast for that chat. */
export type ChatEventSubscriber = (event: LoopEvent) => void;

export class LoopRegistry {
  private readonly entries = new Map<LoopId, RegistryEntry>();
  private readonly subscribers = new Set<ActiveLoopsSubscriber>();
  /**
   * Per-chat event subscribers. Used by `attachChat` to receive live events
   * from any loop running on that chat. Populated by
   * `subscribeChatEvents(chatId, callback)` and fanned out by
   * `broadcastChatEvent(chatId, event)`. Distinct from the per-registry
   * `subscribers` set which only receives `ActiveLoopsChange` summaries for
   * the sidebar Running Loops UI.
   */
  private readonly chatSubscribers = new Map<string, Set<ChatEventSubscriber>>();
  /**
   * Per-chat snapshot of in-flight pending tool results. The agentic loop
   * yields a `pending_tool_result` placeholder message at the start of a
   * tool round and a stream of `tool_block_update` events as the tool
   * runs. Both events are broadcast through `broadcastChatEvent` to the
   * live `attachChat` subscriber. When the user navigates away from a
   * chat mid-tool, the subscriber set goes empty and every subsequent
   * event is dropped on the floor — and the placeholder message itself
   * is never persisted to storage (only the final `message_created`).
   *
   * To make "navigate away → come back" replay the in-flight UI instead
   * of staring at an empty backstage until the tool finishes, we cache
   * the placeholder message + the merged accumulated block state per
   * `toolUseId` and let `attachChat` drain the cache during the snapshot
   * phase. The cache is intentionally per-chat so switching chats or
   * projects mid-run doesn't lose state — that's the whole point of the
   * `attachChat` design.
   *
   * Cleanup is two-pronged: (1) `message_created` carrying a tool_result
   * message clears its toolUseIds (the persisted message supersedes the
   * placeholder), and (2) `loop_ended` clears every entry for the chat
   * as a final safety net for paths that never produced a `message_created`
   * (e.g. abort mid-stream). Both rely on the existing CHAT_BUSY guarantee
   * of one root loop per chat.
   */
  private readonly pendingToolResults = new Map<
    string, // chatId
    Map<string, PendingToolResultSnapshot>
  >();

  /**
   * Per-chat snapshot of the latest in-flight `streaming_chunk` groups — the
   * partially-assembled assistant message. Same problem and lifecycle as
   * `pendingToolResults`: the assembled groups are never persisted until the
   * turn's `message_created`, and the live broadcast drops on the floor when no
   * one is subscribed. Caching the latest groups lets `attachChat` replay them
   * via `streaming_snapshot` so a reconnecting / re-navigating subscriber sees
   * the in-flight bubble immediately instead of staring at a blank one until
   * the next token.
   *
   * Each `streaming_chunk` already carries the full accumulated state (not a
   * delta), so latest-wins overwrite is correct — no merge needed. Cleared when
   * the assistant `message_created` supersedes it (mirrors `useChat`'s own
   * clear) and on `loop_ended` as the abort/no-message safety net.
   *
   * This is the single rehydration path for the claude-agent provider's whole
   * in-flight UI: its text, thinking, and bridged tool results all live in
   * these groups (the bridged results ride the MCP side-channel into the
   * assembler, not the `pendingToolResults` placeholder path).
   */
  private readonly streamingGroupsByChat = new Map<string, RenderingBlockGroup[]>();

  /**
   * Register a new running loop. The caller owns the `AbortController`; the
   * registry just keeps a reference for `abort()` to fire on demand.
   */
  register(loop: ActiveLoop, abortController: AbortController): void {
    if (this.entries.has(loop.loopId)) {
      throw new Error(`LoopRegistry: duplicate loopId ${loop.loopId}`);
    }
    this.entries.set(loop.loopId, { loop, abortController, softStopRequested: false });
    this.broadcast({ type: 'started', loop });
  }

  /**
   * Update an in-flight loop's status. Today the only meaningful transition
   * is `running → aborting` (set by `abort()` itself); kept as a public hook
   * for future statuses.
   */
  updateStatus(loopId: LoopId, status: ActiveLoop['status']): void {
    const entry = this.entries.get(loopId);
    if (!entry) return;
    if (entry.loop.status === status) return;
    entry.loop = { ...entry.loop, status };
    this.broadcast({ type: 'updated', loopId, status });
  }

  /**
   * Mark a loop as ended and remove it from the registry. Called by
   * `ChatRunner` after `runAgenticLoop` returns (success, error, or abort).
   */
  end(
    loopId: LoopId,
    status: 'complete' | 'error' | 'aborted' | 'soft_stopped' | 'max_iterations'
  ): void {
    if (!this.entries.has(loopId)) return;
    this.entries.delete(loopId);
    this.broadcast({ type: 'ended', loopId, status });
  }

  /**
   * Hard-abort: fire the loop's `AbortController` and flip its status to
   * `aborting`. The actual unwind is asynchronous — the registry entry
   * remains until `ChatRunner` calls `end()` from its `try/finally`.
   *
   * Returns `true` if the loop was found and aborted, `false` if it didn't
   * exist (already ended, never started, or wrong loopId).
   */
  abort(loopId: LoopId): boolean {
    const entry = this.entries.get(loopId);
    if (!entry) return false;
    if (entry.loop.status !== 'aborting') {
      this.updateStatus(loopId, 'aborting');
    }
    // signal.aborted may already be true if abort was called twice — that's OK,
    // AbortController is idempotent.
    if (!entry.abortController.signal.aborted) {
      entry.abortController.abort();
    }
    return true;
  }

  /**
   * Soft-stop: ask a loop to stop at the next tool boundary. Idempotent.
   * Unlike `abort()`, this does not fire the AbortController — the loop
   * keeps running until its `shouldStop` check trips, at which point it
   * returns a `soft_stopped` terminal status with the current message
   * history intact.
   *
   * Returns `true` if the loop was found, `false` otherwise.
   */
  softStop(loopId: LoopId): boolean {
    const entry = this.entries.get(loopId);
    if (!entry) return false;
    // Idempotent: only the first request flips the flag and broadcasts. The
    // `updated` delta carries the soft-stop state (status stays unchanged) so
    // the sidebar + a re-attaching chat view can reflect "Stopping…" live.
    if (entry.softStopRequested) return true;
    entry.softStopRequested = true;
    this.broadcast({
      type: 'updated',
      loopId,
      status: entry.loop.status,
      softStopRequested: true,
    });
    return true;
  }

  /**
   * Read the soft-stop flag for a loop. ChatRunner installs a `shouldStop`
   * closure that calls this every iteration. Returns `false` for unknown
   * loops so already-ended runs don't accidentally short-circuit.
   */
  isSoftStopRequested(loopId: LoopId): boolean {
    return this.entries.get(loopId)?.softStopRequested ?? false;
  }

  /** Get a snapshot of every currently-running loop. Used by `listActiveLoops`. */
  list(): ActiveLoop[] {
    return Array.from(this.entries.values()).map(e => ({
      ...e.loop,
      softStopRequested: e.softStopRequested,
    }));
  }

  /** Look up a single loop by id. Returns the live record (callers must not mutate). */
  get(loopId: LoopId): ActiveLoop | undefined {
    return this.entries.get(loopId)?.loop;
  }

  /** True iff the registry currently holds a running (or aborting) loop for this chat. */
  hasRunningLoopForChat(chatId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.loop.chatId === chatId) return true;
    }
    return false;
  }

  /**
   * Minion chats have no ChatRunner CHAT_BUSY equivalent (their child loops
   * register under the PARENT chat id), so the minion tool takes an exclusive
   * hold on the minion chat id for the duration of a call. Guards the lazy
   * savepoint rollback and claude-agent session bookkeeping against a second
   * caller driving the same minion chat concurrently.
   */
  private readonly busyMinionChats = new Set<string>();

  /** Take the exclusive hold. False = already held; caller must not proceed. */
  acquireMinionChat(minionChatId: string): boolean {
    if (this.busyMinionChats.has(minionChatId)) return false;
    this.busyMinionChats.add(minionChatId);
    return true;
  }

  /** Release the hold taken by `acquireMinionChat`. Safe to call when unheld. */
  releaseMinionChat(minionChatId: string): void {
    this.busyMinionChats.delete(minionChatId);
  }

  /**
   * Subscribe to change events. The subscriber receives a `snapshot` event
   * immediately, then `started` / `updated` / `ended` deltas. Returns an
   * unsubscribe function the caller MUST invoke to release the subscription.
   */
  subscribe(callback: ActiveLoopsSubscriber): () => void {
    this.subscribers.add(callback);
    try {
      callback({ type: 'snapshot', loops: this.list() });
    } catch (err) {
      console.error('[LoopRegistry] subscriber threw on initial snapshot:', err);
    }
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private broadcast(change: ActiveLoopsChange): void {
    for (const sub of this.subscribers) {
      try {
        sub(change);
      } catch (err) {
        console.error('[LoopRegistry] subscriber threw:', err);
      }
    }
  }

  // ==========================================================================
  // Per-chat event pubsub — used by `attachChat` for live event delivery
  // ==========================================================================

  /**
   * Subscribe to live LoopEvents for a chat. The subscriber receives every
   * event broadcast via `broadcastChatEvent(chatId, ...)` until the returned
   * unsubscribe function is called. Multiple subscribers per chat are
   * allowed (Phase 2 multi-tab).
   */
  subscribeChatEvents(chatId: string, callback: ChatEventSubscriber): () => void {
    let set = this.chatSubscribers.get(chatId);
    if (!set) {
      set = new Set();
      this.chatSubscribers.set(chatId, set);
    }
    set.add(callback);
    return () => {
      const s = this.chatSubscribers.get(chatId);
      if (!s) return;
      s.delete(callback);
      if (s.size === 0) {
        this.chatSubscribers.delete(chatId);
      }
    };
  }

  /**
   * Fan out a LoopEvent to every `attachChat` subscriber for this chat. Used
   * by the `startLoop` background driver to push events into the per-chat
   * event stream.
   *
   * Before fanning out, three event types update the pending tool result
   * cache so a future re-attaching subscriber can replay the in-flight
   * placeholder + its accumulated streaming state via
   * `getPendingToolResults`. Cache updates happen unconditionally — they
   * don't depend on whether anyone is currently subscribed, since the
   * whole point is to remember state for subscribers that join later.
   */
  broadcastChatEvent(chatId: string, event: LoopEvent): void {
    this.recordPendingToolResultEvent(chatId, event);

    // Pipe chat title changes to the active-loops stream so the sidebar
    // Running Loops section updates without a full re-fetch.
    if (event.type === 'chat_metadata_updated' && event.name !== undefined) {
      this.broadcast({ type: 'chat_title_changed', chatId, title: event.name });
    }

    const set = this.chatSubscribers.get(chatId);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(event);
      } catch (err) {
        console.error('[LoopRegistry] chat subscriber threw:', err);
      }
    }
  }

  /**
   * Snapshot of every in-flight pending tool result for a chat. Used by
   * `GremlinServer.attachChat` to replay the placeholder messages and
   * their accumulated `renderingGroups` to a fresh subscriber. Returns a
   * shallow copy so callers can iterate without holding a reference to
   * the live cache.
   */
  getPendingToolResults(chatId: string): PendingToolResultSnapshot[] {
    const inner = this.pendingToolResults.get(chatId);
    if (!inner) return [];
    return Array.from(inner.values()).map(entry => ({
      toolUseId: entry.toolUseId,
      message: entry.message,
      mergedBlock: { ...entry.mergedBlock },
      groupsState: entry.groupsState
        ? {
            infoGroup: entry.groupsState.infoGroup,
            accumulatedGroups: entry.groupsState.accumulatedGroups.slice(),
            streamingGroups: entry.groupsState.streamingGroups.slice(),
          }
        : undefined,
    }));
  }

  /**
   * Latest cached in-flight `streaming_chunk` groups for a chat, or `undefined`
   * when no turn is mid-stream. Used by `GremlinServer.attachChat` to replay the
   * partially-streamed assistant bubble as a `streaming_snapshot`. Returns a
   * shallow copy of the outer array so callers don't hold a live reference.
   */
  getStreamingGroups(chatId: string): RenderingBlockGroup[] | undefined {
    const groups = this.streamingGroupsByChat.get(chatId);
    return groups ? groups.slice() : undefined;
  }

  /**
   * Update the per-chat replay caches (pending tool results + in-flight
   * streaming groups) from a broadcast LoopEvent. Event types that matter:
   *
   *   - `streaming_chunk`: overwrite the chat's cached assistant groups with
   *     the latest full accumulated state (replayed as `streaming_snapshot`).
   *   - `pending_tool_result`: insert/replace one entry per `toolUseId`
   *     referenced by the placeholder message's `content.toolResults`.
   *     `mergedBlock` starts empty — the first `tool_block_update` for
   *     each id will populate it.
   *   - `tool_block_update`: merge `event.block` into the matching
   *     entry's `mergedBlock`. Same `{...existing, ...new}` semantics as
   *     `useChat`'s frontend throttler. Out-of-order updates (no
   *     placeholder yet) create a placeholder-less entry — defensive,
   *     normally never triggers because the loop yields the placeholder
   *     before any updates.
   *   - `message_created`: an assistant message clears the cached streaming
   *     groups (the persisted message supersedes them); a tool_result message
   *     clears its toolUseIds from the pending cache.
   *   - `loop_ended`: nuke every entry for the chat (both caches) as a final
   *     cleanup for paths that never produced a `message_created` (abort, etc.).
   */
  private recordPendingToolResultEvent(chatId: string, event: LoopEvent): void {
    if (event.type === 'streaming_chunk') {
      // Latest accumulated assistant groups — overwrite (each chunk is the full
      // state, not a delta). `getGroups()` returns a fresh outer array, so the
      // stored reference is safe to keep.
      this.streamingGroupsByChat.set(chatId, event.groups);
      return;
    }

    if (event.type === 'pending_tool_result') {
      const toolResults = (event.message.content as { toolResults?: ToolResultBlock[] })
        .toolResults;
      if (!toolResults || toolResults.length === 0) return;
      let inner = this.pendingToolResults.get(chatId);
      if (!inner) {
        inner = new Map();
        this.pendingToolResults.set(chatId, inner);
      }
      for (const tr of toolResults) {
        inner.set(tr.tool_use_id, {
          toolUseId: tr.tool_use_id,
          message: event.message,
          mergedBlock: {},
        });
      }
      return;
    }

    if (event.type === 'tool_block_update') {
      const inner = this.pendingToolResults.get(chatId);
      if (!inner) return;
      const existing = inner.get(event.toolUseId);
      if (!existing) return;
      existing.mergedBlock = { ...existing.mergedBlock, ...event.block };
      return;
    }

    if (event.type === 'tool_groups_delta') {
      const inner = this.pendingToolResults.get(chatId);
      if (!inner) return;
      const existing = inner.get(event.toolUseId);
      if (!existing) return;
      // `applyGroupsDelta` returns `undefined` only when an `append` /
      // `replace_streaming` / `message_finalized` arrives without a prior
      // `init`. That can't happen mid-run because the emitter always fires
      // `init` first, but stay defensive — drop the delta on the floor and
      // let the next `init` (or `tool_groups_snapshot` on attach) resync.
      existing.groupsState = applyGroupsDelta(existing.groupsState, event.delta);
      return;
    }

    if (event.type === 'message_created') {
      // A finalized assistant message supersedes the in-flight streaming groups
      // (mirrors `useChat` clearing `streamingGroups` on an assistant
      // `message_created`). Runs before the tool-result early return below,
      // which only concerns user-role tool_result placeholder messages.
      if (event.message.role === 'assistant') {
        this.streamingGroupsByChat.delete(chatId);
      }
      const toolResults = (event.message.content as { toolResults?: ToolResultBlock[] })
        .toolResults;
      if (!toolResults || toolResults.length === 0) return;
      const inner = this.pendingToolResults.get(chatId);
      if (!inner) return;
      for (const tr of toolResults) {
        inner.delete(tr.tool_use_id);
      }
      if (inner.size === 0) this.pendingToolResults.delete(chatId);
      return;
    }

    if (event.type === 'loop_ended') {
      this.pendingToolResults.delete(chatId);
      this.streamingGroupsByChat.delete(chatId);
      return;
    }
  }
}
