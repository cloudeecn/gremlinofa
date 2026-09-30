/**
 * Helpers for delta-encoding a tool's `renderingGroups` mutation.
 *
 * A minion's rendering is `[infoGroup, ...accumulatedGroups, ...streamingGroups]`.
 * Shipping that whole array per upstream chunk costs O(n²) bytes per reply,
 * so the minion ships `ToolGroupsDelta`s instead:
 *
 *   - `nextStreamingOpsDelta` wraps the child loop's own `streaming_delta`
 *     ops (see `StreamingGroupsOp`) — the first call becomes the `init`.
 *   - `applyGroupsDelta` is the inverse — used by `LoopRegistry` (server) to
 *     maintain rehydration cache state, and by `useChat` (client) to project
 *     the deltas into placeholder message rendering content.
 *   - `assembleGroups` flattens the three buckets into a single array in the
 *     `[infoGroup, ...accumulated, ...streaming]` order.
 *
 * Both sides of the wire run the same `applyGroupsDelta` against the same
 * starting state, so the protocol stays consistent without forcing a shared
 * codec — the deltas themselves are the contract.
 */

import type { RenderingBlockGroup, StreamingGroupsOp, ToolGroupsDelta } from '../../protocol/types';
import { applyStreamingGroupsOps } from '../streaming/streamingGroupsOps';

/**
 * Assembled state of a tool's `renderingGroups`. Mirrors the three-section
 * layout the minion tool produces as a flat array: a stable `infoGroup` once
 * per run, `accumulatedGroups` that grow when a sub-message finalizes, and
 * `streamingGroups` that change per upstream chunk.
 */
export interface ToolGroupsState {
  infoGroup: RenderingBlockGroup;
  accumulatedGroups: RenderingBlockGroup[];
  streamingGroups: RenderingBlockGroup[];
}

/**
 * Apply a single delta to an optional prior state and return the new state.
 * The function is total — defensive on out-of-order deltas (e.g.
 * `streaming_ops` arriving with no prior state) by returning the existing
 * state unchanged. The next `init` or `tool_groups_snapshot` will resync.
 */
export function applyGroupsDelta(
  state: ToolGroupsState | undefined,
  delta: ToolGroupsDelta
): ToolGroupsState | undefined {
  if (delta.kind === 'init') {
    return {
      infoGroup: delta.infoGroup,
      accumulatedGroups: delta.accumulatedGroups.slice(),
      streamingGroups: delta.streamingGroups.slice(),
    };
  }

  if (!state) {
    return undefined;
  }

  if (delta.kind === 'streaming_ops') {
    const streamingGroups = applyStreamingGroupsOps(state.streamingGroups, delta.ops);
    return streamingGroups === state.streamingGroups ? state : { ...state, streamingGroups };
  }

  if (delta.kind === 'message_finalized') {
    return {
      ...state,
      accumulatedGroups: delta.accumulatedGroups.slice(),
      streamingGroups: delta.streamingGroups.slice(),
    };
  }

  return state;
}

/** Flatten the three buckets back into the `[info, ...accum, ...streaming]` array shape. */
export function assembleGroups(state: ToolGroupsState): RenderingBlockGroup[] {
  return [state.infoGroup, ...state.accumulatedGroups, ...state.streamingGroups];
}

/**
 * Emit-side bookkeeping for a tool that ships deltas (the minion). Tracks
 * what the receivers hold so each yield site can pick the right delta kind.
 * `streamingGroups` only ever changes copy-on-write, so an array handed out
 * in an `init` payload never changes after the fact, even while the delta
 * sits in `attachChat`'s queue.
 */
export interface DeltaEmitterState {
  infoGroup: RenderingBlockGroup;
  accumulatedGroups: RenderingBlockGroup[];
  streamingGroups: RenderingBlockGroup[];
  initEmitted: boolean;
}

/** Create a fresh emitter state; `init` fires on the first delta. */
export function makeEmitterState(infoGroup: RenderingBlockGroup): DeltaEmitterState {
  return {
    infoGroup,
    accumulatedGroups: [],
    streamingGroups: [],
    initEmitted: false,
  };
}

/**
 * Turn the child loop's streaming ops into the delta to yield, and fold
 * them into the emitter state. The first call returns `init` carrying the
 * full current state (the ops already applied); later calls pass the ops
 * through as `streaming_ops`.
 */
export function nextStreamingOpsDelta(
  state: DeltaEmitterState,
  ops: StreamingGroupsOp[]
): ToolGroupsDelta {
  state.streamingGroups = applyStreamingGroupsOps(state.streamingGroups, ops);
  if (!state.initEmitted) {
    state.initEmitted = true;
    return {
      kind: 'init',
      infoGroup: state.infoGroup,
      accumulatedGroups: state.accumulatedGroups,
      streamingGroups: state.streamingGroups,
    };
  }
  return { kind: 'streaming_ops', ops };
}

/**
 * Handle the child loop's per-iteration `streaming_start`: the next ops
 * build a new reply from empty groups. Returns a `reset` delta when the
 * receivers still hold streaming groups, `null` when they're already empty
 * (the usual case — `message_finalized` cleared them) or haven't seen `init`
 * yet (the `init` will carry the full state anyway).
 */
export function streamingResetDelta(state: DeltaEmitterState): ToolGroupsDelta | null {
  if (state.streamingGroups.length === 0) return null;
  state.streamingGroups = [];
  if (!state.initEmitted) return null;
  return { kind: 'streaming_ops', ops: [{ op: 'reset' }] };
}

/**
 * Build a `message_finalized` delta and roll the new accumulated state into
 * the emitter. `nextStreamingGroups` defaults empty (the common case — the
 * caller just received a `message_created` and hasn't started the next
 * streaming round yet).
 */
export function finalizeMessageDelta(
  state: DeltaEmitterState,
  nextAccumulatedGroups: RenderingBlockGroup[],
  nextStreamingGroups: RenderingBlockGroup[] = []
): ToolGroupsDelta {
  state.accumulatedGroups = nextAccumulatedGroups;
  state.streamingGroups = nextStreamingGroups;
  // If init never fired (e.g., a finalize before any streaming chunk arrived
  // — possible for tool runs that finish in one shot), promote this to init
  // so the receiver still has a complete state to bootstrap from.
  if (!state.initEmitted) {
    state.initEmitted = true;
    return {
      kind: 'init',
      infoGroup: state.infoGroup,
      accumulatedGroups: nextAccumulatedGroups,
      streamingGroups: nextStreamingGroups,
    };
  }
  return {
    kind: 'message_finalized',
    accumulatedGroups: nextAccumulatedGroups,
    streamingGroups: nextStreamingGroups,
  };
}
