/**
 * Unit tests for the delta-encoding helpers behind minion streaming.
 *
 * The contract these tests pin down:
 *   - `nextStreamingOpsDelta` turns the child loop's streaming ops into an
 *     `init` (first call) and `streaming_ops` afterwards.
 *   - `applyGroupsDelta` reconstructs the same state on the receiver side
 *     that the emitter holds. Both server (`LoopRegistry`) and client
 *     (`useChat`) run the same apply path, so this is the contract that
 *     keeps them in sync.
 *   - `streamingResetDelta` and `finalizeMessageDelta` handle the child's
 *     iteration boundaries; finalize promotes to `init` when nothing
 *     streamed yet.
 */

import { describe, it, expect } from 'vitest';
import type { RenderingBlockGroup, ToolGroupsDelta } from '../../../protocol/types';
import type { StreamChunk } from '../../api/baseClient';
import { StreamingContentAssembler } from '../../streaming/StreamingContentAssembler';
import {
  applyGroupsDelta,
  assembleGroups,
  finalizeMessageDelta,
  makeEmitterState,
  nextStreamingOpsDelta,
  streamingResetDelta,
  type DeltaEmitterState,
  type ToolGroupsState,
} from '../toolGroupsDelta';

const infoGroup: RenderingBlockGroup = {
  category: 'backstage',
  blocks: [{ type: 'tool_info', input: 'go' }],
};

function textGroup(text: string): RenderingBlockGroup {
  return { category: 'text', blocks: [{ type: 'text', text }] };
}

/** Drives a child assembler the way `minionTool` consumes `streaming_delta`. */
function makeChild(emitter: DeltaEmitterState) {
  const assembler = new StreamingContentAssembler();
  return {
    assembler,
    push(chunk: StreamChunk): ToolGroupsDelta | null {
      assembler.pushChunk(chunk);
      const ops = assembler.takeOps();
      return ops.length > 0 ? nextStreamingOpsDelta(emitter, ops) : null;
    },
  };
}

describe('nextStreamingOpsDelta + applyGroupsDelta round-trip', () => {
  it('first call emits init carrying the current state', () => {
    const emitter = makeEmitterState(infoGroup);
    const child = makeChild(emitter);
    child.assembler.pushChunk({ type: 'content.start' });
    child.assembler.pushChunk({ type: 'content', content: 'a' });
    const delta = nextStreamingOpsDelta(emitter, child.assembler.takeOps());

    expect(delta.kind).toBe('init');
    expect(applyGroupsDelta(undefined, delta)).toEqual({
      infoGroup,
      accumulatedGroups: [],
      streamingGroups: [textGroup('a')],
    });
  });

  it('later calls pass the ops through as streaming_ops', () => {
    const emitter = makeEmitterState(infoGroup);
    const child = makeChild(emitter);
    let receiver = applyGroupsDelta(undefined, child.push({ type: 'content.start' })!);

    for (const piece of ['He', 'll', 'o']) {
      const delta = child.push({ type: 'content', content: piece })!;
      expect(delta).toEqual({
        kind: 'streaming_ops',
        ops: [{ op: 'append', g: 0, b: 0, text: piece }],
      });
      receiver = applyGroupsDelta(receiver, delta);
    }
    expect(receiver?.streamingGroups).toEqual([textGroup('Hello')]);
    expect(emitter.streamingGroups).toEqual(child.assembler.getGroups());
  });

  it('init payload stays as emitted while later ops apply', () => {
    // The init can sit in attachChat's queue while the loop races ahead.
    // Copy-on-write in the emitter keeps its payload at the emit-time value.
    const emitter = makeEmitterState(infoGroup);
    const child = makeChild(emitter);
    child.assembler.pushChunk({ type: 'content.start' });
    child.assembler.pushChunk({ type: 'content', content: 'He' });
    const init = nextStreamingOpsDelta(emitter, child.assembler.takeOps());
    const initJson = JSON.stringify(init);

    const next = child.push({ type: 'content', content: 'llo' })!;
    child.push({ type: 'web_search.start', id: 'ws1' });
    expect(JSON.stringify(init)).toBe(initJson);

    let st = applyGroupsDelta(undefined, init);
    st = applyGroupsDelta(st, next);
    // No duplicated overlap on the receiver.
    expect(st?.streamingGroups).toEqual([textGroup('Hello')]);
  });

  it('streaming reset clears receivers only when they hold streaming groups', () => {
    const emitter = makeEmitterState(infoGroup);
    // Before init with nothing streamed: nothing to say.
    expect(streamingResetDelta(emitter)).toBeNull();

    const child = makeChild(emitter);
    let st = applyGroupsDelta(undefined, child.push({ type: 'thinking.start' })!);
    st = applyGroupsDelta(st, child.push({ type: 'thinking', content: 'hm' })!);

    const reset = streamingResetDelta(emitter);
    expect(reset).toEqual({ kind: 'streaming_ops', ops: [{ op: 'reset' }] });
    st = applyGroupsDelta(st, reset!);
    expect(st?.streamingGroups).toEqual([]);
    expect(emitter.streamingGroups).toEqual([]);

    // Already empty: no second reset.
    expect(streamingResetDelta(emitter)).toBeNull();

    // A new child iteration streams from empty groups and applies cleanly.
    const nextChild = makeChild(emitter);
    st = applyGroupsDelta(st, nextChild.push({ type: 'content.start' })!);
    st = applyGroupsDelta(st, nextChild.push({ type: 'content', content: 'new' })!);
    expect(st?.streamingGroups).toEqual([textGroup('new')]);
  });

  it('streaming reset before init clears emitter state without a delta', () => {
    const emitter = makeEmitterState(infoGroup);
    emitter.streamingGroups = [textGroup('stale')];
    expect(streamingResetDelta(emitter)).toBeNull();
    expect(emitter.streamingGroups).toEqual([]);
  });

  it('multi-message: finalize rolls streaming into accumulated', () => {
    const emitter = makeEmitterState(infoGroup);
    const first = makeChild(emitter);
    let st = applyGroupsDelta(undefined, first.push({ type: 'content.start' })!);
    st = applyGroupsDelta(st, first.push({ type: 'content', content: 'msg1' })!);

    st = applyGroupsDelta(st, finalizeMessageDelta(emitter, [textGroup('msg1 final')], []));
    expect(st?.accumulatedGroups).toEqual([textGroup('msg1 final')]);
    expect(st?.streamingGroups).toEqual([]);

    // Finalize emptied the streaming groups, so the next iteration needs no reset.
    expect(streamingResetDelta(emitter)).toBeNull();
    const second = makeChild(emitter);
    const delta = second.push({ type: 'content.start' })!;
    expect(delta.kind).toBe('streaming_ops');
    st = applyGroupsDelta(st, delta);
    st = applyGroupsDelta(st, second.push({ type: 'content', content: 'm' })!);
    expect(st).toEqual({
      infoGroup,
      accumulatedGroups: [textGroup('msg1 final')],
      streamingGroups: [textGroup('m')],
    });
  });

  it('finalize before any streaming promotes to init', () => {
    const emitter = makeEmitterState(infoGroup);
    const delta = finalizeMessageDelta(emitter, [textGroup('done')]);
    expect(delta.kind).toBe('init');
    expect(applyGroupsDelta(undefined, delta)).toEqual({
      infoGroup,
      accumulatedGroups: [textGroup('done')],
      streamingGroups: [],
    });
  });
});

describe('applyGroupsDelta defensive paths', () => {
  it('drops streaming_ops when no prior state', () => {
    const delta: ToolGroupsDelta = {
      kind: 'streaming_ops',
      ops: [{ op: 'add', g: 0, category: 'text', block: { type: 'text', text: 'x' } }],
    };
    expect(applyGroupsDelta(undefined, delta)).toBeUndefined();
  });

  it('keeps the state for an empty op batch', () => {
    const state: ToolGroupsState = {
      infoGroup,
      accumulatedGroups: [],
      streamingGroups: [textGroup('t')],
    };
    expect(applyGroupsDelta(state, { kind: 'streaming_ops', ops: [] })).toBe(state);
  });

  it('ignores ops that do not fit the streaming groups', () => {
    const state = applyGroupsDelta(undefined, {
      kind: 'init',
      infoGroup,
      accumulatedGroups: [],
      streamingGroups: [{ category: 'backstage', blocks: [{ type: 'tool_info', input: 'x' }] }],
    });
    const result = applyGroupsDelta(state, {
      kind: 'streaming_ops',
      ops: [{ op: 'append', g: 0, b: 0, text: 'x' }],
    });
    expect(result?.streamingGroups).toEqual(state?.streamingGroups);
  });

  it('assembleGroups returns the flat [info, ...accum, ...streaming] array', () => {
    const state = applyGroupsDelta(undefined, {
      kind: 'init',
      infoGroup,
      accumulatedGroups: [textGroup('done')],
      streamingGroups: [textGroup('streaming')],
    });
    expect(assembleGroups(state!)).toEqual([infoGroup, textGroup('done'), textGroup('streaming')]);
  });
});

describe('bandwidth: streaming_ops payloads stay small', () => {
  it('a web_search ahead of the answer does not make every chunk a full resend', () => {
    // The old structural diff compared non-text blocks by identity against a
    // cloned snapshot, so a search block before the text forced a full
    // `replace_streaming` on every chunk.
    const emitter = makeEmitterState(infoGroup);
    const child = makeChild(emitter);
    let receiver: ToolGroupsState | undefined;
    const apply = (delta: ToolGroupsDelta | null) => {
      if (delta) receiver = applyGroupsDelta(receiver, delta);
      return delta;
    };
    apply(child.push({ type: 'web_search.start', id: 'ws1' }));
    apply(child.push({ type: 'web_search', id: 'ws1', query: 'what do axolotls eat' }));
    apply(
      child.push({
        type: 'web_search.result',
        tool_use_id: 'ws1',
        title: 'Axolotl care',
        url: 'https://axolotl.example/care',
      })
    );
    apply(child.push({ type: 'content.start' }));

    let totalDeltaBytes = 0;
    let largestDelta = 0;
    let snapshotEquivalent = 0;
    for (let i = 0; i < 200; i++) {
      const delta = apply(child.push({ type: 'content', content: ' worms' }))!;
      expect(delta.kind).toBe('streaming_ops');
      const bytes = JSON.stringify(delta).length;
      totalDeltaBytes += bytes;
      largestDelta = Math.max(largestDelta, bytes);
      snapshotEquivalent += JSON.stringify(assembleGroups(receiver!)).length;
    }

    expect(receiver?.streamingGroups).toEqual(child.assembler.getGroups());
    expect(largestDelta).toBeLessThan(100);
    expect(totalDeltaBytes * 10).toBeLessThan(snapshotEquivalent);
  });
});
