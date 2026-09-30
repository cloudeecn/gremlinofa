import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyStreamingGroupsOps } from '../streamingGroupsOps';
import type { RenderingBlockGroup, StreamingGroupsOp } from '../../../protocol/types';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function baseGroups(): RenderingBlockGroup[] {
  return [
    {
      category: 'backstage',
      blocks: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'web_search', id: 'ws1', query: 'q', results: [] },
      ],
    },
    { category: 'text', blocks: [{ type: 'text', text: 'Hello' }] },
  ];
}

describe('applyStreamingGroupsOps', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the same array for an empty batch', () => {
    const groups = baseGroups();
    expect(applyStreamingGroupsOps(groups, [])).toBe(groups);
  });

  it('reset empties the groups', () => {
    expect(applyStreamingGroupsOps(baseGroups(), [{ op: 'reset' }])).toEqual([]);
  });

  it('add opens a new group at g === length', () => {
    const next = applyStreamingGroupsOps(baseGroups(), [
      { op: 'add', g: 2, category: 'backstage', block: { type: 'thinking', thinking: 'x' } },
    ]);
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({
      category: 'backstage',
      blocks: [{ type: 'thinking', thinking: 'x' }],
    });
  });

  it('add pushes onto the last group at g === length - 1', () => {
    const next = applyStreamingGroupsOps(baseGroups(), [
      { op: 'add', g: 1, category: 'text', block: { type: 'text', text: 'more' } },
    ]);
    expect(next[1].blocks).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'more' },
    ]);
  });

  it('append extends text and thinking at any position', () => {
    const next = applyStreamingGroupsOps(baseGroups(), [
      { op: 'append', g: 0, b: 0, text: ' more' },
      { op: 'append', g: 1, b: 0, text: ' world' },
      { op: 'append', g: 1, b: 0, text: '!' },
    ]);
    expect(next[0].blocks[0]).toEqual({ type: 'thinking', thinking: 'hmm more' });
    expect(next[1].blocks[0]).toEqual({ type: 'text', text: 'Hello world!' });
  });

  it('put replaces a block', () => {
    const next = applyStreamingGroupsOps(baseGroups(), [
      {
        op: 'put',
        g: 0,
        b: 1,
        block: { type: 'web_search', id: 'ws1', query: 'q', results: [{ title: 't', url: 'u' }] },
      },
    ]);
    expect(next[0].blocks[1]).toEqual({
      type: 'web_search',
      id: 'ws1',
      query: 'q',
      results: [{ title: 't', url: 'u' }],
    });
  });

  it('applies adds and appends after a reset in one batch', () => {
    const next = applyStreamingGroupsOps(baseGroups(), [
      { op: 'reset' },
      { op: 'add', g: 0, category: 'text', block: { type: 'text', text: 'a' } },
      { op: 'append', g: 0, b: 0, text: 'b' },
      { op: 'add', g: 0, category: 'text', block: { type: 'fallback' } },
    ]);
    expect(next).toEqual([
      {
        category: 'text',
        blocks: [{ type: 'text', text: 'ab' }, { type: 'fallback' }],
      },
    ]);
  });

  it('drops ops that do not fit and keeps the rest', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const misfits: StreamingGroupsOp[] = [
      // add past the end
      { op: 'add', g: 5, category: 'text', block: { type: 'text', text: 'x' } },
      // add into a group that is not the last one
      { op: 'add', g: 0, category: 'backstage', block: { type: 'thinking', thinking: 'x' } },
      // add onto the last group with a different category
      { op: 'add', g: 1, category: 'backstage', block: { type: 'thinking', thinking: 'x' } },
      { op: 'add', g: -1, category: 'text', block: { type: 'text', text: 'x' } },
      // append to a block that is not text/thinking
      { op: 'append', g: 0, b: 1, text: 'x' },
      // append out of range
      { op: 'append', g: 3, b: 0, text: 'x' },
      { op: 'append', g: 1, b: 4, text: 'x' },
      // put out of range
      { op: 'put', g: 1, b: 1, block: { type: 'text', text: 'x' } },
      { op: 'put', g: 9, b: 0, block: { type: 'text', text: 'x' } },
    ];
    const next = applyStreamingGroupsOps(baseGroups(), [
      ...misfits,
      { op: 'append', g: 1, b: 0, text: '!' },
    ]);
    expect(next).toEqual([
      baseGroups()[0],
      { category: 'text', blocks: [{ type: 'text', text: 'Hello!' }] },
    ]);
    expect(debug).toHaveBeenCalledTimes(misfits.length);
    expect(debug).toHaveBeenCalledWith('[streamingOps] dropped %o', misfits[0]);
  });

  it('never mutates recursively frozen inputs or op payloads', () => {
    const groups = deepFreeze(baseGroups());
    const ops = deepFreeze<StreamingGroupsOp[]>([
      { op: 'append', g: 0, b: 0, text: '!' },
      { op: 'append', g: 1, b: 0, text: ' there' },
      { op: 'put', g: 0, b: 1, block: { type: 'web_search', id: 'ws1', query: 'z', results: [] } },
      { op: 'add', g: 1, category: 'text', block: { type: 'text', text: 'new' } },
      { op: 'append', g: 1, b: 1, text: ' block' },
      { op: 'add', g: 2, category: 'backstage', block: { type: 'thinking', thinking: 'deep' } },
      { op: 'append', g: 2, b: 0, text: 'er' },
    ]);
    const before = JSON.stringify({ groups, ops });

    const next = applyStreamingGroupsOps(groups, ops);

    expect(JSON.stringify({ groups, ops })).toBe(before);
    expect(next[1].blocks).toEqual([
      { type: 'text', text: 'Hello there' },
      { type: 'text', text: 'new block' },
    ]);
    expect(next[2].blocks).toEqual([{ type: 'thinking', thinking: 'deeper' }]);
  });

  it('keeps identity of untouched groups and blocks', () => {
    const groups = baseGroups();
    const next = applyStreamingGroupsOps(groups, [{ op: 'append', g: 1, b: 0, text: '!' }]);
    expect(next).not.toBe(groups);
    expect(next[0]).toBe(groups[0]);
    expect(next[1]).not.toBe(groups[1]);

    const later = applyStreamingGroupsOps(next, [
      { op: 'add', g: 2, category: 'backstage', block: { type: 'thinking', thinking: '' } },
    ]);
    expect(later[0]).toBe(groups[0]);
    expect(later[1]).toBe(next[1]);
    expect(later[1].blocks[0]).toBe(next[1].blocks[0]);
  });

  it('keeps an earlier result unchanged after later batches', () => {
    const first = applyStreamingGroupsOps(
      [],
      [{ op: 'add', g: 0, category: 'text', block: { type: 'text', text: 'a' } }]
    );
    const firstJson = JSON.stringify(first);
    const second = applyStreamingGroupsOps(first, [{ op: 'append', g: 0, b: 0, text: 'bc' }]);
    applyStreamingGroupsOps(second, [{ op: 'append', g: 0, b: 0, text: 'de' }]);
    expect(JSON.stringify(first)).toBe(firstJson);
    expect(second[0].blocks[0]).toEqual({ type: 'text', text: 'abc' });
  });
});
