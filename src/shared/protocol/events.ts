/**
 * Stream event payload types — the `streams: ...` side of the method
 * registry. One file per "thing that streams": LoopEvent (the agentic loop),
 * ActiveLoopsChange (sidebar Running Loops), Export/Import progress, project
 * bundle export, VFS compact.
 */

import type {
  Chat,
  Message,
  Project,
  RenderingBlockGroup,
  TokenTotals,
  ToolGroupsDelta,
} from './types';
import type { ToolResultRenderBlock } from './types/content';
import type { CompactProgress, CompactResult } from '../services/vfs/vfsService';
import type { LoopId } from './wire';

// ============================================================================
// LoopEvent — stream events emitted by runLoop / attachChat
// ============================================================================

/**
 * Events emitted on a loop's event stream. One-to-one with the existing
 * `AgenticLoopEvent` set with two additions: `loop_started` (carries the
 * minted LoopId so subscribers can correlate), and `chat_updated` /
 * `project_updated` for sidebar/list refreshes that today happen as React
 * state side-effects in `useChat.ts`.
 */
export type LoopEvent =
  | { type: 'loop_started'; loopId: LoopId; parentLoopId?: LoopId }
  | {
      type: 'loop_ended';
      loopId: LoopId;
      status: 'complete' | 'error' | 'aborted' | 'soft_stopped' | 'max_iterations';
      detail?: string;
    }
  /**
   * Synthetic marker yielded by `attachChat` immediately after the snapshot
   * phase finishes delivering `chat_updated` + `message_created` events for
   * persisted state. The frontend uses this to fire `onMessagesLoaded` and
   * unmask any "loading initial state" UI.
   */
  | { type: 'snapshot_complete' }
  /**
   * Yielded by `attachChat` when `knownMessageIds` was provided and the
   * server matched a prefix of the client's known messages. The server
   * skips yielding `message_created` for everything up to and including
   * `lastMatchedMessageId`, sending only messages after it. The frontend
   * looks up this ID in its local `reconMapRef` to fast-forward the
   * reconciliation pointer.
   */
  | { type: 'partial_reconsolidate'; lastMatchedMessageId: string }
  /**
   * Frontend-only synthetic event dispatched by `GremlinSession.onReconnect`
   * before re-opening the `attachChat` stream. Signals `useChat` to enter
   * reconciliation mode so the incoming snapshot can be diffed against the
   * existing message array instead of blindly appending duplicates.
   */
  | { type: 'reconnect_start' }
  | { type: 'streaming_start' }
  | { type: 'streaming_chunk'; groups: RenderingBlockGroup[] }
  | { type: 'streaming_end' }
  /**
   * Full assembled streaming state for the in-flight assistant turn, fired
   * during `attachChat` replay so a reconnecting/joining subscriber rehydrates
   * the partially-streamed bubble without waiting for the next live
   * `streaming_chunk`. The one-shot rehydration counterpart to
   * `streaming_chunk` (mirrors `tool_groups_snapshot` ↔ `tool_groups_delta`).
   * Steady-state never emits this. Matters most for the claude-agent provider,
   * whose single `sendMessageStream` spans a whole multi-tool SDK turn with
   * long no-token gaps where nothing else would repaint the bubble.
   */
  | { type: 'streaming_snapshot'; groups: RenderingBlockGroup[] }
  | { type: 'first_chunk' }
  | { type: 'message_created'; message: Message<unknown> }
  /**
   * Emitted by the retry path in `ChatRunner.buildContextMessages` when a
   * resend deletes the assistant turns after the anchor user message.
   * Subscribers must drop every message strictly *after* `afterMessageId`
   * from their view; the anchor itself is kept. Snapshot replay via
   * `attachChat` reads from already-truncated storage so new subscribers
   * don't need this event — only the live subscriber that triggered the
   * retry does.
   */
  | { type: 'messages_truncated'; afterMessageId: string }
  | { type: 'pending_tool_result'; message: Message<unknown> }
  | {
      type: 'tool_block_update';
      toolUseId: string;
      block: Partial<ToolResultRenderBlock>;
    }
  /**
   * Delta encoding of a tool's `renderingGroups` mutation, emitted in lieu of
   * shipping the full assembled snapshot on every upstream SSE chunk. The
   * frontend applies these to a per-`toolUseId` accumulator and projects the
   * assembled state into the placeholder message's `renderingContent`.
   *
   * See `ToolGroupsDelta` for the discriminated payload shape.
   */
  | { type: 'tool_groups_delta'; toolUseId: string; delta: ToolGroupsDelta }
  /**
   * Full assembled state for one active tool call, fired during `attachChat`
   * replay so a reconnecting/joining subscriber rehydrates without waiting
   * for the next live delta. Steady-state never emits this — it's the
   * one-shot rehydration counterpart to `tool_groups_delta`.
   */
  | {
      type: 'tool_groups_snapshot';
      toolUseId: string;
      infoGroup: RenderingBlockGroup;
      accumulatedGroups: RenderingBlockGroup[];
      streamingGroups: RenderingBlockGroup[];
    }
  | { type: 'tokens_consumed'; tokens: TokenTotals; isToolCost?: boolean }
  | { type: 'chat_updated'; chat: Chat }
  | { type: 'project_updated'; project: Project }
  | { type: 'checkpoint_set'; messageId: string }
  | { type: 'active_hook_changed'; hookName: string | null }
  | { type: 'dummy_hook_start'; hookName: string }
  | { type: 'dummy_hook_end'; result: 'passthrough' | 'user_stop' | 'intercepted' }
  | { type: 'chat_metadata_updated'; name?: string; summary?: string }
  /**
   * Authoritative incomplete-tail lock state for the current chat. Emitted
   * on attachChat snapshot, after every `message_created` /
   * `messages_truncated` event whose effect could change the lock, and on
   * loop teardown. The frontend uses this to drive the "delete incomplete
   * message / roll back" banner and to disable the chat input.
   *
   * Pushed backend-side in Phase 1.7 so the frontend doesn't need to import
   * `isChatLockedByIncompleteTail` (and therefore `Message`) just to derive
   * a boolean.
   */
  | { type: 'lock_state_changed'; locked: boolean };

// ============================================================================
// ActiveLoop / ActiveLoopsChange — sidebar Running Loops panel
// ============================================================================

export interface ActiveLoop {
  loopId: LoopId;
  chatId: string;
  /** Present for minion sub-loops; root loops omit it. */
  parentLoopId?: LoopId;
  startedAt: number;
  status: 'running' | 'aborting';
  apiDefinitionId: string;
  modelId: string;
  /** Minion persona / display name when applicable. */
  displayName?: string;
  /**
   * Whether a soft stop has been requested for this loop. Carried in the
   * snapshot (not just the terminal status) so the UI can reconstruct the
   * "Stopping…" indicator after a chat re-attach — the request lives on the
   * backend `LoopRegistry`, not in frontend component state.
   */
  softStopRequested?: boolean;
}

/**
 * Subscriber stream for the sidebar Running Loops section. The first event
 * is always a `snapshot` carrying the current set; subsequent events are
 * deltas.
 */
export type ActiveLoopsChange =
  | { type: 'snapshot'; loops: ActiveLoop[] }
  | { type: 'started'; loop: ActiveLoop }
  | {
      type: 'updated';
      loopId: LoopId;
      status: ActiveLoop['status'];
      /** Present only on the soft-stop transition; omitted deltas leave it unchanged. */
      softStopRequested?: boolean;
    }
  | {
      type: 'ended';
      loopId: LoopId;
      status: 'complete' | 'error' | 'aborted' | 'soft_stopped' | 'max_iterations';
    }
  | { type: 'chat_title_changed'; chatId: string; title: string };

// ============================================================================
// Export / import streams
// ============================================================================

/**
 * Stream events emitted by `exportData`. The frontend assembles `chunk`
 * events into a `Blob` and triggers the download anchor click on the main
 * thread once `done` arrives.
 */
export type ExportEvent =
  | { type: 'progress'; processed: number }
  | { type: 'chunk'; data: Uint8Array }
  | { type: 'done'; suggestedName: string; mimeType: string };

/**
 * Stream events emitted by `importData`. The terminal `done` event carries
 * the final counts; the consumer collects them in lieu of a separate
 * one-shot result envelope.
 */
export type ImportProgress =
  | {
      type: 'progress';
      processed: number;
      imported: number;
      skipped: number;
      errors: number;
      estimatedTotal?: number;
    }
  | { type: 'warning'; message: string }
  | {
      type: 'vfs_migration_progress';
      projectId: string;
      projectName: string;
      filesProcessed: number;
      totalFiles: number;
      versionsProcessed: number;
    }
  | { type: 'vfs_migration_skipped'; projectId: string; projectName: string; reason: string }
  | { type: 'done'; imported: number; skipped: number; errors: string[] };

// ============================================================================
// Project bundle export stream
// ============================================================================

/**
 * Stream events emitted by `exportProject`. Each `progress` event marks
 * one VFS file loaded; the terminal `done` event carries the serialized
 * bundle JSON + counts. The frontend wraps `bundleJson` in a `Blob` and
 * triggers the download anchor on the main thread (DOM stays out of the
 * worker).
 */
export type ProjectExportEvent =
  | { type: 'progress'; loaded: number; total: number }
  | {
      type: 'done';
      bundleJson: string;
      fileCount: number;
      dirCount: number;
      projectName: string;
    };

// ============================================================================
// VFS compact stream
// ============================================================================

/**
 * Stream events emitted by `vfsCompactProject`. The compact runner walks
 * the project's tree in phases (`scanning`, `purging-deleted`,
 * `purging-orphans`, `pruning-revisions`, `done`); each call to the
 * runner's `onProgress` callback becomes one `progress` event. The
 * terminal `done` event carries the final `CompactResult`.
 */
export type VfsCompactEvent =
  | { type: 'progress'; progress: CompactProgress }
  | { type: 'done'; result: CompactResult };
