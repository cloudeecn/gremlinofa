/**
 * Unit tests for the delta-encoding helpers that replace minion's
 * snapshot-per-frame streaming.
 *
 * The contract these tests pin down:
 *   - `nextStreamingDelta` picks `append` whenever only the trailing
 *     text/thinking block grew; falls back to `replace_streaming` on any
 *     structural change.
 *   - `applyGroupsDelta` reconstructs the same state on the receiver side
 *     that the emitter intended. Both server (`LoopRegistry`) and client
 *     (`useChat`) run the same apply path, so this is the contract that
 *     guarantees they stay in sync.
 *   - `finalizeMessageDelta` rolls in-flight streaming into accumulated
 *     and promotes to `init` when no streaming chunk fired yet.
 */

import { describe, it, expect } from 'vitest';
import type { RenderingBlockGroup, ToolGroupsDelta } from '../../../protocol/types';
import {
  applyGroupsDelta,
  assembleGroups,
  diffStreamingGroups,
  finalizeMessageDelta,
  makeEmitterState,
  nextStreamingDelta,
} from '../toolGroupsDelta';

const infoGroup: RenderingBlockGroup = {
  category: 'backstage',
  blocks: [{ type: 'tool_info', input: 'go' }],
};

function textGroup(text: string): RenderingBlockGroup {
  return { category: 'text', blocks: [{ type: 'text', text }] };
}

function thinkingGroup(thinking: string): RenderingBlockGroup {
  return { category: 'text', blocks: [{ type: 'thinking', thinking }] };
}

describe('diffStreamingGroups', () => {
  it('returns append for trailing text growth', () => {
    const delta = diffStreamingGroups([textGroup('Hello')], [textGroup('Hello world')]);
    expect(delta).toEqual({ kind: 'append', target: 'last_text', text: ' world' });
  });

  it('returns append for trailing thinking growth', () => {
    const delta = diffStreamingGroups(
      [thinkingGroup('Considering')],
      [thinkingGroup('Considering options')]
    );
    expect(delta).toEqual({ kind: 'append', target: 'last_thinking', text: ' options' });
  });

  it('falls back to replace_streaming on group-count mismatch', () => {
    const next = [textGroup('a'), thinkingGroup('b')];
    const delta = diffStreamingGroups([textGroup('a')], next);
    expect(delta).toEqual({ kind: 'replace_streaming', streamingGroups: next });
  });

  it('falls back to replace_streaming on block-type switch', () => {
    const delta = diffStreamingGroups([textGroup('hi')], [thinkingGroup('hi')]);
    expect(delta.kind).toBe('replace_streaming');
  });

  it('falls back to replace_streaming when prefix breaks', () => {
    // Text shrank — not a strict suffix of the prior.
    const delta = diffStreamingGroups([textGroup('Hello world')], [textGroup('Hello')]);
    expect(delta.kind).toBe('replace_streaming');
  });

  it('falls back to replace_streaming when prior was empty', () => {
    const delta = diffStreamingGroups([], [textGroup('x')]);
    expect(delta.kind).toBe('replace_streaming');
  });
});

describe('nextStreamingDelta + applyGroupsDelta round-trip', () => {
  it('first call emits init carrying the current state', () => {
    const state = makeEmitterState(infoGroup);
    const delta = nextStreamingDelta(state, [textGroup('a')]);
    expect(delta?.kind).toBe('init');

    const applied = applyGroupsDelta(undefined, delta!);
    expect(applied).toEqual({
      infoGroup,
      accumulatedGroups: [],
      streamingGroups: [textGroup('a')],
    });
  });

  it('subsequent chunks emit append and reconstruct identical state', () => {
    const emitter = makeEmitterState(infoGroup);
    let receiverState = applyGroupsDelta(undefined, nextStreamingDelta(emitter, [textGroup('H')])!);

    const chunks = ['He', 'Hel', 'Hell', 'Hello'];
    for (const text of chunks) {
      const delta = nextStreamingDelta(emitter, [textGroup(text)]);
      expect(delta?.kind).toBe('append');
      receiverState = applyGroupsDelta(receiverState, delta!);
    }
    expect(receiverState?.streamingGroups).toEqual([textGroup('Hello')]);
  });

  it('skips re-yields when streaming groups are unchanged', () => {
    const emitter = makeEmitterState(infoGroup);
    nextStreamingDelta(emitter, [textGroup('x')]);
    const second = nextStreamingDelta(emitter, [textGroup('x')]);
    expect(second).toBeNull();
  });

  it('multi-message: finalize rolls streaming into accumulated', () => {
    const emitter = makeEmitterState(infoGroup);
    let st = applyGroupsDelta(undefined, nextStreamingDelta(emitter, [textGroup('msg1')])!);

    // Sub-message finalizes: caller pushed the finalized group into accumulated.
    const finalizeDelta = finalizeMessageDelta(emitter, [textGroup('msg1 final')], []);
    st = applyGroupsDelta(st, finalizeDelta);
    expect(st?.accumulatedGroups).toEqual([textGroup('msg1 final')]);
    expect(st?.streamingGroups).toEqual([]);

    // Next round streams in a new sub-message
    const initLike = nextStreamingDelta(emitter, [textGroup('m')]);
    // After finalize, `streamingGroups` was reset, so the next chunk emits
    // replace_streaming (length grew from 0 to 1).
    expect(initLike?.kind).toBe('replace_streaming');
    st = applyGroupsDelta(st, initLike!);
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
    const state = applyGroupsDelta(undefined, delta);
    expect(state).toEqual({
      infoGroup,
      accumulatedGroups: [textGroup('done')],
      streamingGroups: [],
    });
  });

  it('detects per-chunk growth even when producer mutates blocks in place', () => {
    // Regression: `StreamingContentAssembler.getGroups()` returns a shallow
    // copy of the outer array but the inner group + block objects are
    // mutated in place as text grows. If the emitter stores those refs
    // directly, the next diff compares the present against itself and
    // returns "no change" — silently dropping every chunk after the
    // first. This test holds the producer's block ref steady and grows
    // its `.text` between yields to prove the emitter still notices.
    const emitter = makeEmitterState(infoGroup);
    const liveBlock = { type: 'text' as const, text: 'H' };
    const liveGroup: RenderingBlockGroup = { category: 'text', blocks: [liveBlock] };
    const producerView = [liveGroup];

    const first = nextStreamingDelta(emitter, producerView);
    expect(first?.kind).toBe('init');

    liveBlock.text = 'Hi';
    const second = nextStreamingDelta(emitter, producerView);
    expect(second).toEqual({ kind: 'append', target: 'last_text', text: 'i' });

    liveBlock.text = 'Hi there';
    const third = nextStreamingDelta(emitter, producerView);
    expect(third).toEqual({ kind: 'append', target: 'last_text', text: ' there' });
  });

  it('init payload is frozen against later in-place mutation', () => {
    // Regression: the emitter must not alias the producer's live block. The
    // background loop pump can grow the block while the init delta is still
    // queued for the wire; the payload must keep the value it had at emit time.
    const emitter = makeEmitterState(infoGroup);
    const liveBlock = { type: 'text' as const, text: 'He' };
    const liveGroup: RenderingBlockGroup = { category: 'text', blocks: [liveBlock] };

    const init = nextStreamingDelta(emitter, [liveGroup]);
    expect(init?.kind).toBe('init');

    // Producer races ahead after the init was emitted.
    liveBlock.text = 'Hello';

    expect(init?.kind === 'init' && init.streamingGroups).toEqual([textGroup('He')]);
  });

  it('no duplication when producer mutates between emit and apply', () => {
    // End-to-end: emit init at "He", let the producer grow to "Hello", then
    // emit the next delta. Applying both on a fresh receiver must land on
    // "Hello" — not "Hellollo" (the overlap re-shipped by the next append).
    const emitter = makeEmitterState(infoGroup);
    const liveBlock = { type: 'text' as const, text: 'He' };
    const liveGroup: RenderingBlockGroup = { category: 'text', blocks: [liveBlock] };

    const init = nextStreamingDelta(emitter, [liveGroup])!;
    liveBlock.text = 'Hello';
    const next = nextStreamingDelta(emitter, [liveGroup])!;
    expect(next).toEqual({ kind: 'append', target: 'last_text', text: 'llo' });

    let st = applyGroupsDelta(undefined, init);
    st = applyGroupsDelta(st, next);
    expect(st?.streamingGroups).toEqual([textGroup('Hello')]);
  });

  it('replace_streaming payload is frozen against later in-place mutation', () => {
    const emitter = makeEmitterState(infoGroup);
    applyGroupsDelta(undefined, nextStreamingDelta(emitter, [textGroup('hi')])!);

    // Structural change (text → thinking) forces replace_streaming.
    const liveBlock = { type: 'thinking' as const, thinking: 'pondering' };
    const liveGroup: RenderingBlockGroup = { category: 'text', blocks: [liveBlock] };
    const replace = nextStreamingDelta(emitter, [liveGroup]);
    expect(replace?.kind).toBe('replace_streaming');

    liveBlock.thinking = 'pondering harder';

    expect(replace?.kind === 'replace_streaming' && replace.streamingGroups).toEqual([
      thinkingGroup('pondering'),
    ]);
  });

  it('structural change yields replace_streaming and resyncs receiver', () => {
    const emitter = makeEmitterState(infoGroup);
    let st = applyGroupsDelta(undefined, nextStreamingDelta(emitter, [textGroup('H')])!);
    // Apply append a couple times
    st = applyGroupsDelta(st, nextStreamingDelta(emitter, [textGroup('Hi')])!);
    // Now switch to thinking block — structural change
    const structural = nextStreamingDelta(emitter, [thinkingGroup('thinking')]);
    expect(structural?.kind).toBe('replace_streaming');
    st = applyGroupsDelta(st, structural!);
    expect(st?.streamingGroups).toEqual([thinkingGroup('thinking')]);
  });
});

describe('applyGroupsDelta defensive paths', () => {
  it('drops append when no prior state', () => {
    const delta: ToolGroupsDelta = { kind: 'append', target: 'last_text', text: 'x' };
    expect(applyGroupsDelta(undefined, delta)).toBeUndefined();
  });

  it('drops replace_streaming when no prior state', () => {
    const delta: ToolGroupsDelta = { kind: 'replace_streaming', streamingGroups: [textGroup('x')] };
    expect(applyGroupsDelta(undefined, delta)).toBeUndefined();
  });

  it('drops append when target type mismatches last block', () => {
    const state = applyGroupsDelta(undefined, {
      kind: 'init',
      infoGroup,
      accumulatedGroups: [],
      streamingGroups: [thinkingGroup('t')],
    });
    const result = applyGroupsDelta(state, { kind: 'append', target: 'last_text', text: 'x' });
    // Type mismatch — leave state untouched.
    expect(result?.streamingGroups).toEqual([thinkingGroup('t')]);
  });

  it('assembleGroups returns the flat snapshot the legacy path used', () => {
    const state = applyGroupsDelta(undefined, {
      kind: 'init',
      infoGroup,
      accumulatedGroups: [textGroup('done')],
      streamingGroups: [textGroup('streaming')],
    });
    expect(assembleGroups(state!)).toEqual([infoGroup, textGroup('done'), textGroup('streaming')]);
  });
});

describe('bandwidth: append delta payloads stay small', () => {
  it('per-chunk delta carries only the new chars, not the full assembled text', () => {
    const emitter = makeEmitterState(infoGroup);
    nextStreamingDelta(emitter, [textGroup('Hello')]); // init

    let text = 'Hello';
    let totalAppendPayload = 0;
    let snapshotEquivalent = 0;
    let largestDelta = 0;
    for (let i = 0; i < 200; i++) {
      text += ' world';
      const delta = nextStreamingDelta(emitter, [textGroup(text)]);
      expect(delta?.kind).toBe('append');
      const json = JSON.stringify(delta);
      totalAppendPayload += json.length;
      largestDelta = Math.max(largestDelta, json.length);
      // What the old snapshot path would have shipped this frame:
      snapshotEquivalent += JSON.stringify({
        type: 'groups_update',
        groups: [infoGroup, textGroup(text)],
      }).length;
    }

    // Each append carries fixed JSON overhead + 6 chars of text suffix.
    expect(largestDelta).toBeLessThan(150);
    // The whole delta stream should be dramatically smaller than the
    // snapshot stream — pin at 10x as a regression sanity check (the
    // observed ratio is closer to 20x in practice).
    expect(totalAppendPayload * 10).toBeLessThan(snapshotEquivalent);
  });
});
