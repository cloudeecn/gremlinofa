import { describe, it, expect } from 'vitest';
import { StreamingContentAssembler } from '../StreamingContentAssembler';
import { applyStreamingGroupsOps } from '../streamingGroupsOps';
import type { StreamChunk } from '../../api/baseClient';
import type { RenderingBlockGroup, StreamingGroupsOp } from '../../../protocol/types';

/**
 * Push `chunks` one at a time, taking ops after each, and check that a
 * receiver applying only the ops always matches the assembler. Also checks
 * that ops taken earlier never change afterwards (they sit in queues while
 * the assembler keeps mutating its blocks).
 */
function roundTrip(chunks: StreamChunk[], takeEvery = 1) {
  const assembler = new StreamingContentAssembler();
  let receiver: RenderingBlockGroup[] = [];
  const taken: { ops: StreamingGroupsOp[]; json: string }[] = [];
  chunks.forEach((chunk, i) => {
    assembler.pushChunk(chunk);
    if ((i + 1) % takeEvery !== 0 && i !== chunks.length - 1) return;
    const ops = assembler.takeOps();
    taken.push({ ops, json: JSON.stringify(ops) });
    receiver = applyStreamingGroupsOps(receiver, ops);
    expect(receiver).toEqual(assembler.getGroups());
  });
  for (const { ops, json } of taken) {
    expect(JSON.stringify(ops)).toBe(json);
  }
  return { assembler, receiver, ops: taken.map(t => t.ops) };
}

const plainText: StreamChunk[] = [
  { type: 'content.start' },
  { type: 'content', content: 'Hel' },
  { type: 'content', content: 'lo' },
  { type: 'content', content: ' world' },
  { type: 'content.end' },
];

const thinkingThenText: StreamChunk[] = [
  { type: 'thinking.start' },
  { type: 'thinking', content: 'Let me ' },
  { type: 'thinking', content: 'think.' },
  { type: 'thinking.end' },
  { type: 'content.start' },
  { type: 'content', content: 'Answer' },
  { type: 'content', content: ' here.' },
  { type: 'content.end' },
];

const searchBeforeText: StreamChunk[] = [
  { type: 'web_search.start', id: 'ws1' },
  { type: 'web_search', id: 'ws1', query: 'axolotl diet' },
  { type: 'web_search.result', tool_use_id: 'ws1', title: 'Axolotls', url: 'https://a.example' },
  { type: 'web_search.result', tool_use_id: 'ws1', title: 'Diet', url: 'https://b.example' },
  { type: 'web_fetch.start', id: 'wf1' },
  { type: 'web_fetch', id: 'wf1', url: 'https://a.example' },
  { type: 'web_fetch.result', tool_use_id: 'wf1', url: 'https://a.example', title: 'Axolotls' },
  { type: 'content.start' },
  { type: 'content', content: 'They eat ' },
  { type: 'content', content: 'worms.' },
  { type: 'content.end' },
];

// Google grounding opens a web_search while the text block is still open;
// the text that follows lands on the earlier block, not the last one.
const searchMidText: StreamChunk[] = [
  { type: 'content.start' },
  { type: 'content', content: 'Before ' },
  { type: 'web_search.start', id: 'g1' },
  { type: 'web_search', id: 'g1', query: 'grounding' },
  { type: 'content', content: 'after.' },
  { type: 'web_search.result', tool_use_id: 'g1', title: 'T', url: 'https://g.example' },
  { type: 'content', content: ' More.' },
  { type: 'content.end' },
];

const notifyMidText: StreamChunk[] = [
  { type: 'content.start' },
  { type: 'content', content: 'Working' },
  { type: 'notify', text: 'Compacting conversation', key: 'compact', color: 'warning' },
  { type: 'content', content: ' on it' },
  { type: 'content.end' },
];

const citations: StreamChunk[] = [
  { type: 'content.start' },
  { type: 'citation', url: 'https://c.example', title: 'Source', citedText: 'quoted' },
  { type: 'content', content: 'Cited claim.' },
  { type: 'content.end' },
  { type: 'content.start' },
  { type: 'content', content: ' Next sentence.' },
  { type: 'content.end' },
];

const toolRound: StreamChunk[] = [
  { type: 'content.start' },
  { type: 'content', content: 'Reading the file.' },
  { type: 'content.end' },
  { type: 'tool_use', id: 'tu1', name: 'filesystem', input: { path: '/a.txt' } },
  {
    type: 'tool_result',
    tool_use_id: 'tu1',
    name: 'filesystem',
    content: 'file body',
    renderingGroups: [{ category: 'text', blocks: [{ type: 'text', text: 'nested' }] }],
  },
  {
    type: 'tool_result_annotation',
    tool_use_id: 'tu1',
    modelDelivery: { status: 'truncated', detail: 'model got 4 of 9 chars' },
  },
  { type: 'content.start' },
  { type: 'content', content: 'Done.' },
  { type: 'content.end' },
];

describe('StreamingContentAssembler.takeOps', () => {
  const scenarios: [string, StreamChunk[]][] = [
    ['plain text', plainText],
    ['thinking then text', thinkingThenText],
    ['web_search and web_fetch before text', searchBeforeText],
    ['web_search opened while text is still streaming', searchMidText],
    ['notify mid-text', notifyMidText],
    ['citations appended at content.end', citations],
    ['tool_use, tool_result and annotation', toolRound],
  ];

  describe.each(scenarios)('round trip: %s', (_name, chunks) => {
    it('matches getGroups() after every chunk', () => {
      roundTrip(chunks);
    });

    it('matches getGroups() when ops are taken every few chunks', () => {
      roundTrip(chunks, 3);
    });
  });

  it('first take after a block is added carries one add with the grown text', () => {
    const assembler = new StreamingContentAssembler();
    assembler.pushChunk({ type: 'content.start' });
    assembler.pushChunk({ type: 'content', content: 'ab' });
    assembler.pushChunk({ type: 'content', content: 'cd' });
    expect(assembler.takeOps()).toEqual([
      { op: 'add', g: 0, category: 'text', block: { type: 'text', text: 'abcd' } },
    ]);
    assembler.pushChunk({ type: 'content', content: 'ef' });
    expect(assembler.takeOps()).toEqual([{ op: 'append', g: 0, b: 0, text: 'ef' }]);
  });

  it('appends to an earlier block while a later one exists (Google grounding)', () => {
    const { ops } = roundTrip(searchMidText);
    // 'after.' goes to the text block at (0, 0) although the search is at (1, 0)
    expect(ops[4]).toEqual([{ op: 'append', g: 0, b: 0, text: 'after.' }]);
  });

  it('ships only the new text once a web_search sits ahead of the answer', () => {
    const { ops } = roundTrip(searchBeforeText);
    expect(ops[9]).toEqual([{ op: 'append', g: 1, b: 0, text: 'worms.' }]);
  });

  it('ships a put for web_search results and tool_result annotations', () => {
    const search = roundTrip(searchBeforeText).ops;
    expect(search[2]).toEqual([
      {
        op: 'put',
        g: 0,
        b: 0,
        block: {
          type: 'web_search',
          id: 'ws1',
          query: 'axolotl diet',
          results: [{ title: 'Axolotls', url: 'https://a.example' }],
        },
      },
    ]);

    const tools = roundTrip(toolRound).ops;
    expect(tools[5]).toEqual([
      expect.objectContaining({
        op: 'put',
        g: 1,
        b: 1,
        block: expect.objectContaining({
          type: 'tool_result',
          modelDelivery: { status: 'truncated', detail: 'model got 4 of 9 chars' },
        }),
      }),
    ]);
  });

  it('never aliases live assembler state in add/put payloads', () => {
    const assembler = new StreamingContentAssembler();
    assembler.pushChunk({ type: 'web_search.start', id: 'ws1' });
    const [add] = assembler.takeOps();
    assembler.pushChunk({ type: 'web_search', id: 'ws1', query: 'q' });
    assembler.pushChunk({ type: 'web_search.result', tool_use_id: 'ws1', title: 't', url: 'u' });
    expect(add).toEqual({
      op: 'add',
      g: 0,
      category: 'backstage',
      block: { type: 'web_search', id: 'ws1', query: '', results: [] },
    });
    expect(add.op === 'add' && add.block).not.toBe(assembler.getGroups()[0].blocks[0]);
  });

  it('produces no ops for chunks that change nothing visible', () => {
    const assembler = new StreamingContentAssembler();
    assembler.pushChunk({ type: 'content.start' });
    assembler.pushChunk({ type: 'content', content: 'x' });
    assembler.takeOps();

    assembler.pushChunk({ type: 'token_usage', inputTokens: 10, outputTokens: 2 });
    expect(assembler.takeOps()).toEqual([]);
    assembler.pushChunk({ type: 'citation', url: 'https://c.example' });
    expect(assembler.takeOps()).toEqual([]);
    assembler.pushChunk({ type: 'content', content: '' });
    expect(assembler.takeOps()).toEqual([]);
    // Reusing the previous text block is not a structural change either.
    assembler.pushChunk({ type: 'content.end' });
    assembler.takeOps();
    assembler.pushChunk({ type: 'content.start' });
    expect(assembler.takeOps()).toEqual([]);
  });

  it('starts the batch after reset() with a reset op', () => {
    const assembler = new StreamingContentAssembler();
    let receiver: RenderingBlockGroup[] = [];
    assembler.pushChunk({ type: 'thinking.start' });
    assembler.pushChunk({ type: 'thinking', content: 'old' });
    receiver = applyStreamingGroupsOps(receiver, assembler.takeOps());

    assembler.pushChunk({ type: 'thinking', content: ' more' });
    assembler.reset();
    assembler.pushChunk({ type: 'content.start' });
    assembler.pushChunk({ type: 'content', content: 'new' });
    const ops = assembler.takeOps();
    expect(ops).toEqual([
      { op: 'reset' },
      { op: 'add', g: 0, category: 'text', block: { type: 'text', text: 'new' } },
    ]);
    receiver = applyStreamingGroupsOps(receiver, ops);
    expect(receiver).toEqual(assembler.getGroups());
  });

  it('keeps bytes per chunk proportional to the chunk, not the reply', () => {
    const measure = (n: number, withSnapshots: boolean) => {
      const assembler = new StreamingContentAssembler();
      assembler.pushChunk({ type: 'content.start' });
      let opBytes = JSON.stringify(assembler.takeOps()).length;
      let snapshotBytes = 0;
      for (let i = 0; i < n; i++) {
        assembler.pushChunk({ type: 'content', content: 'abcdefgh' });
        opBytes += JSON.stringify(assembler.takeOps()).length;
        if (withSnapshots) snapshotBytes += JSON.stringify(assembler.getGroups()).length;
      }
      return { opBytes, snapshotBytes };
    };

    const small = measure(5_000, true);
    const large = measure(10_000, false);
    const ratio = large.opBytes / small.opBytes;
    expect(ratio).toBeGreaterThan(1.9);
    expect(ratio).toBeLessThan(2.1);
    // The old protocol shipped the whole reply per chunk: ~O(n²).
    expect(small.opBytes * 100).toBeLessThan(small.snapshotBytes);
  });
});
