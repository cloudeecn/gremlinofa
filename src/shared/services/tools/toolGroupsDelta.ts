/**
 * Helpers for delta-encoding a tool's `renderingGroups` mutation.
 *
 * The minion tool currently yields the full assembled groups array on every
 * upstream SSE chunk, which the wire then ships as a `tool_block_update` with
 * `renderingGroups`. For a 2 KB message split into ~10-char chunks that's
 * ~200 KB shipped to deliver 2 KB of content. These helpers replace that
 * snapshot stream with deltas:
 *
 *   - `diffStreamingGroups` is the bandwidth fast-path picker. It returns an
 *     `append` delta if only the trailing text/thinking block grew, and falls
 *     back to `replace_streaming` whenever the structure changed.
 *   - `applyGroupsDelta` is the inverse — used by `LoopRegistry` (server) to
 *     maintain rehydration cache state, and by `useChat` (client) to project
 *     the deltas into placeholder message rendering content.
 *   - `assembleGroups` flattens the three buckets into a single array in the
 *     same `[infoGroup, ...accumulated, ...streaming]` order the legacy
 *     snapshot path used.
 *
 * Both sides of the wire run the same `applyGroupsDelta` against the same
 * starting state, so the protocol stays consistent without forcing a shared
 * codec — the deltas themselves are the contract.
 */

import type { RenderingBlockGroup, ToolGroupsDelta } from '../../protocol/types';
import type {
  RenderingContentBlock,
  TextRenderBlock,
  ThinkingRenderBlock,
} from '../../protocol/types/content';

/**
 * Assembled state of a tool's `renderingGroups`. Mirrors the three-section
 * layout the minion tool produced as a flat array: a stable `infoGroup` once
 * per run, `accumulatedGroups` that grow when a sub-message finalizes, and
 * `streamingGroups` that mutate per upstream SSE chunk.
 */
export interface ToolGroupsState {
  infoGroup: RenderingBlockGroup;
  accumulatedGroups: RenderingBlockGroup[];
  streamingGroups: RenderingBlockGroup[];
}

/**
 * Compute the smallest delta describing the transition from `prior` streaming
 * groups to `next` streaming groups. Falls back to `replace_streaming`
 * whenever the structure changed or the last block didn't grow as a strict
 * suffix — the receiver always converges on the next replace/snapshot, so
 * being conservative is cheap.
 */
export function diffStreamingGroups(
  prior: RenderingBlockGroup[],
  next: RenderingBlockGroup[]
):
  | { kind: 'append'; target: 'last_text' | 'last_thinking'; text: string }
  | { kind: 'replace_streaming'; streamingGroups: RenderingBlockGroup[] } {
  if (prior.length === 0 || prior.length !== next.length) {
    return { kind: 'replace_streaming', streamingGroups: next };
  }

  for (let i = 0; i < prior.length - 1; i++) {
    if (!groupsStructurallyEqual(prior[i], next[i])) {
      return { kind: 'replace_streaming', streamingGroups: next };
    }
  }

  const priorLast = prior[prior.length - 1];
  const nextLast = next[next.length - 1];

  if (
    priorLast.category !== nextLast.category ||
    priorLast.blocks.length !== nextLast.blocks.length ||
    priorLast.blocks.length === 0
  ) {
    return { kind: 'replace_streaming', streamingGroups: next };
  }

  for (let i = 0; i < priorLast.blocks.length - 1; i++) {
    if (!blocksStructurallyEqual(priorLast.blocks[i], nextLast.blocks[i])) {
      return { kind: 'replace_streaming', streamingGroups: next };
    }
  }

  const priorBlock = priorLast.blocks[priorLast.blocks.length - 1];
  const nextBlock = nextLast.blocks[nextLast.blocks.length - 1];

  if (priorBlock.type === 'text' && nextBlock.type === 'text') {
    const a = (priorBlock as TextRenderBlock).text;
    const b = (nextBlock as TextRenderBlock).text;
    if (a === b) return { kind: 'replace_streaming', streamingGroups: next };
    if (b.startsWith(a)) {
      return { kind: 'append', target: 'last_text', text: b.slice(a.length) };
    }
    return { kind: 'replace_streaming', streamingGroups: next };
  }

  if (priorBlock.type === 'thinking' && nextBlock.type === 'thinking') {
    const a = (priorBlock as ThinkingRenderBlock).thinking;
    const b = (nextBlock as ThinkingRenderBlock).thinking;
    if (a === b) return { kind: 'replace_streaming', streamingGroups: next };
    if (b.startsWith(a)) {
      return { kind: 'append', target: 'last_thinking', text: b.slice(a.length) };
    }
    return { kind: 'replace_streaming', streamingGroups: next };
  }

  return { kind: 'replace_streaming', streamingGroups: next };
}

/**
 * Apply a single delta to an optional prior state and return the new state.
 * The function is total — defensive on out-of-order deltas (e.g. an `append`
 * arriving with no prior state) by returning the existing state unchanged.
 * The next `replace_streaming` or `tool_groups_snapshot` will resync.
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

  if (delta.kind === 'append') {
    if (state.streamingGroups.length === 0) return state;
    const lastGroupIdx = state.streamingGroups.length - 1;
    const lastGroup = state.streamingGroups[lastGroupIdx];
    if (lastGroup.blocks.length === 0) return state;
    const lastBlockIdx = lastGroup.blocks.length - 1;
    const lastBlock = lastGroup.blocks[lastBlockIdx];

    let updatedBlock: RenderingContentBlock | null = null;
    if (delta.target === 'last_text' && lastBlock.type === 'text') {
      updatedBlock = {
        ...lastBlock,
        text: (lastBlock as TextRenderBlock).text + delta.text,
      };
    } else if (delta.target === 'last_thinking' && lastBlock.type === 'thinking') {
      updatedBlock = {
        ...lastBlock,
        thinking: (lastBlock as ThinkingRenderBlock).thinking + delta.text,
      };
    }
    if (!updatedBlock) return state;

    const newBlocks = lastGroup.blocks.slice();
    newBlocks[lastBlockIdx] = updatedBlock;
    const newStreaming = state.streamingGroups.slice();
    newStreaming[lastGroupIdx] = { ...lastGroup, blocks: newBlocks };
    return { ...state, streamingGroups: newStreaming };
  }

  if (delta.kind === 'replace_streaming') {
    return { ...state, streamingGroups: delta.streamingGroups.slice() };
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

function groupsStructurallyEqual(a: RenderingBlockGroup, b: RenderingBlockGroup): boolean {
  if (a === b) return true;
  if (a.category !== b.category || a.blocks.length !== b.blocks.length) return false;
  if (a.isToolGenerated !== b.isToolGenerated) return false;
  for (let i = 0; i < a.blocks.length; i++) {
    if (!blocksStructurallyEqual(a.blocks[i], b.blocks[i])) return false;
  }
  return true;
}

function blocksStructurallyEqual(a: RenderingContentBlock, b: RenderingContentBlock): boolean {
  if (a === b) return true;
  if (a.type !== b.type) return false;
  if (a.type === 'text' && b.type === 'text') {
    return (a as TextRenderBlock).text === (b as TextRenderBlock).text;
  }
  if (a.type === 'thinking' && b.type === 'thinking') {
    return (a as ThinkingRenderBlock).thinking === (b as ThinkingRenderBlock).thinking;
  }
  // For other block types (tool_use, tool_result, etc.) be conservative —
  // they don't normally change mid-stream, so an identity miss means the
  // structure mutated and we want to fall back to replace_streaming.
  return false;
}

/**
 * Closure-style state holder used by emitters (minion tool) that need to
 * track prior streaming groups across yield sites. Distinct from the
 * `ToolGroupsState` returned by `applyGroupsDelta` because emitters care
 * about emit-side bookkeeping (has init fired? what was the last yield?)
 * rather than reconstructed display state.
 */
export interface DeltaEmitterState {
  infoGroup: RenderingBlockGroup;
  accumulatedGroups: RenderingBlockGroup[];
  streamingGroups: RenderingBlockGroup[];
  initEmitted: boolean;
}

/**
 * Snapshot streaming groups so the emitter's prior state is decoupled from
 * the producer's mutable block objects.
 *
 * `StreamingContentAssembler.getGroups()` returns a shallow copy of the
 * outer array, but the inner group + block objects are mutated in place as
 * text/thinking grows. If we stored those refs directly, the next diff
 * would compare the present against itself (same object identity, same
 * mutated text) and conclude "no change" — silently dropping every
 * streaming update after the first one. Cloning blocks here captures the
 * text/thinking strings (strings are immutable, so a shallow copy is
 * enough) so the next frame's diff sees the genuine delta.
 */
function snapshotStreamingGroups(groups: RenderingBlockGroup[]): RenderingBlockGroup[] {
  return groups.map(g => ({
    ...g,
    blocks: g.blocks.map(b => ({ ...b })),
  }));
}

/**
 * Create a fresh emitter state. `accumulatedGroups` and `streamingGroups`
 * default empty — pass non-empty arrays only if the emitter starts mid-state
 * (e.g. resuming a paused tool).
 */
export function makeEmitterState(infoGroup: RenderingBlockGroup): DeltaEmitterState {
  return {
    infoGroup,
    accumulatedGroups: [],
    streamingGroups: [],
    initEmitted: false,
  };
}

/**
 * Compute the next delta for a new `streamingGroups` value. Mutates the
 * emitter state to track the latest streaming snapshot. Returns the delta
 * the emitter should yield, or `null` if there's nothing to send (e.g. no
 * structural or content change).
 */
export function nextStreamingDelta(
  state: DeltaEmitterState,
  nextStreamingGroups: RenderingBlockGroup[]
): ToolGroupsDelta | null {
  // Snapshot up front and emit from the snapshot — never from the live
  // `nextStreamingGroups`. `getGroups()` hands back block objects the producer
  // keeps growing in place, and a delta can sit in the broadcast queue while
  // the background loop races ahead. If we emitted the live ref, the payload
  // would serialize whatever text the producer reached by flush time instead
  // of the baseline this frame's diff was computed against — and `init` /
  // `replace_streaming` carrying grown text while `state.streamingGroups`
  // stays frozen makes the next `append` re-ship the overlap, duplicating the
  // early characters on the receiver. The snapshot is value-stable.
  const snapshot = snapshotStreamingGroups(nextStreamingGroups);

  if (!state.initEmitted) {
    state.initEmitted = true;
    state.streamingGroups = snapshot;
    return {
      kind: 'init',
      infoGroup: state.infoGroup,
      accumulatedGroups: state.accumulatedGroups,
      streamingGroups: snapshot,
    };
  }
  const delta = diffStreamingGroups(state.streamingGroups, snapshot);
  // `replace_streaming` with identical contents is a no-op — the diff
  // returns it for empty-prior or no-change edge cases. Filter so we don't
  // ship a ~kilobyte payload for zero change.
  if (
    delta.kind === 'replace_streaming' &&
    state.streamingGroups.length === snapshot.length &&
    state.streamingGroups.every((g, i) => groupsStructurallyEqual(g, snapshot[i]))
  ) {
    return null;
  }
  state.streamingGroups = snapshot;
  return delta;
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
