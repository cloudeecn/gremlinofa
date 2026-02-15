import { describe, it, expect } from 'vitest';
import { applyContextSwipe, type FilterBlocksFn } from '../contextSwipe';
import type { Message } from '../../../types';

// Helper to create a minimal message
function msg(
  id: string,
  role: 'user' | 'assistant',
  modelFamily: 'anthropic' | 'chatgpt' | 'responses_api' | 'bedrock',
  fullContent: unknown
): Message<unknown> {
  return {
    id,
    role,
    content: {
      type: 'text',
      content: `text-${id}`,
      modelFamily,
      fullContent,
    },
    timestamp: new Date(),
  };
}

// Simple array-based filter for testing: removes blocks with type 'thinking',
// removes tool_use blocks by name, removes tool_result by ID
const testFilter: FilterBlocksFn = (
  fullContent,
  removedToolNames,
  isCheckpoint,
  removedToolUseIds
) => {
  if (!Array.isArray(fullContent)) return { filtered: fullContent, newRemovedIds: [] };

  const filtered: unknown[] = [];
  const newRemovedIds: string[] = [];

  for (const block of fullContent) {
    const b = block as { type?: string; id?: string; name?: string; tool_use_id?: string };

    // Always remove thinking
    if (b.type === 'thinking') continue;

    // Checkpoint: only thinking removed
    if (isCheckpoint) {
      filtered.push(block);
      continue;
    }

    if (b.type === 'tool_use' && b.name && removedToolNames.has(b.name)) {
      if (b.id) newRemovedIds.push(b.id);
      continue;
    }

    if (b.type === 'tool_result' && b.tool_use_id && removedToolUseIds.has(b.tool_use_id)) {
      continue;
    }

    filtered.push(block);
  }

  return { filtered, newRemovedIds };
};

describe('applyContextSwipe', () => {
  it('returns messages unchanged when no checkpointMessageId', () => {
    const messages = [msg('m1', 'user', 'anthropic', [{ type: 'text', text: 'hi' }])];
    const result = applyContextSwipe(messages, undefined, undefined, 'anthropic', testFilter);
    expect(result).toBe(messages); // Same reference
  });

  it('returns messages unchanged when checkpoint not found', () => {
    const messages = [msg('m1', 'user', 'anthropic', [{ type: 'text', text: 'hi' }])];
    const result = applyContextSwipe(messages, 'nonexistent', undefined, 'anthropic', testFilter);
    expect(result).toBe(messages);
  });

  it('removes thinking blocks from messages before checkpoint', () => {
    const messages = [
      msg('m1', 'assistant', 'anthropic', [
        { type: 'thinking', thinking: 'deep thought' },
        { type: 'text', text: 'hello' },
      ]),
      msg('m2', 'user', 'anthropic', [{ type: 'text', text: 'response' }]),
      msg('checkpoint', 'assistant', 'anthropic', [
        { type: 'thinking', thinking: 'more thinking' },
        { type: 'text', text: 'checkpoint msg' },
      ]),
      msg('m4', 'user', 'anthropic', [{ type: 'text', text: 'after checkpoint' }]),
    ];

    const result = applyContextSwipe(
      messages,
      'checkpoint',
      new Set<string>(),
      'anthropic',
      testFilter
    );

    // m1: thinking removed, text kept
    expect(result[0].content.fullContent).toEqual([{ type: 'text', text: 'hello' }]);
    // m2: untouched (no thinking)
    expect(result[1].content.fullContent).toEqual([{ type: 'text', text: 'response' }]);
    // checkpoint: thinking removed (checkpoint message still gets thinking stripped)
    expect(result[2].content.fullContent).toEqual([{ type: 'text', text: 'checkpoint msg' }]);
    // m4: untouched (after checkpoint)
    expect(result[3].content.fullContent).toEqual([{ type: 'text', text: 'after checkpoint' }]);
  });

  it('removes tool_use and matching tool_result blocks', () => {
    const messages = [
      msg('m1', 'assistant', 'anthropic', [
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', id: 'tool1', name: 'filesystem', input: {} },
        { type: 'tool_use', id: 'tool2', name: 'memory', input: {} },
      ]),
      msg('m2', 'user', 'anthropic', [
        { type: 'tool_result', tool_use_id: 'tool1', content: 'file content' },
        { type: 'tool_result', tool_use_id: 'tool2', content: 'memory content' },
      ]),
      msg('checkpoint', 'assistant', 'anthropic', [{ type: 'text', text: 'done' }]),
    ];

    const result = applyContextSwipe(
      messages,
      'checkpoint',
      new Set(['filesystem']),
      'anthropic',
      testFilter
    );

    // m1: filesystem tool_use removed, memory kept
    expect(result[0].content.fullContent).toEqual([
      { type: 'text', text: 'let me check' },
      { type: 'tool_use', id: 'tool2', name: 'memory', input: {} },
    ]);
    // m2: filesystem tool_result removed, memory kept
    expect(result[1].content.fullContent).toEqual([
      { type: 'tool_result', tool_use_id: 'tool2', content: 'memory content' },
    ]);
  });

  it('drops messages with empty fullContent after filtering', () => {
    const messages = [
      msg('m1', 'assistant', 'anthropic', [{ type: 'thinking', thinking: 'only thinking' }]),
      msg('checkpoint', 'assistant', 'anthropic', [{ type: 'text', text: 'cp' }]),
    ];

    const result = applyContextSwipe(
      messages,
      'checkpoint',
      new Set<string>(),
      'anthropic',
      testFilter
    );

    // m1 should be dropped (only had thinking)
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('checkpoint');
  });

  it('skips messages with mismatched modelFamily', () => {
    const messages = [
      msg('m1', 'assistant', 'chatgpt', [{ type: 'thinking', thinking: 'should stay' }]),
      msg('checkpoint', 'assistant', 'anthropic', [{ type: 'text', text: 'cp' }]),
    ];

    const result = applyContextSwipe(
      messages,
      'checkpoint',
      new Set<string>(),
      'anthropic',
      testFilter
    );

    // m1: skipped (chatgpt != anthropic), kept as-is
    expect(result[0].content.fullContent).toEqual([{ type: 'thinking', thinking: 'should stay' }]);
  });

  it('skips messages with null fullContent', () => {
    const noFull: Message<unknown> = {
      id: 'm1',
      role: 'user',
      content: { type: 'text', content: 'plain text', modelFamily: 'anthropic' },
      timestamp: new Date(),
    };
    const checkpoint = msg('cp', 'assistant', 'anthropic', [{ type: 'text', text: 'cp' }]);
    const messages = [noFull, checkpoint];

    const result = applyContextSwipe(messages, 'cp', new Set<string>(), 'anthropic', testFilter);

    expect(result.length).toBe(2);
    expect(result[0].id).toBe('m1');
  });

  it('preserves tool blocks on checkpoint message itself', () => {
    const messages = [
      msg('checkpoint', 'assistant', 'anthropic', [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'tool_use', id: 'tool1', name: 'filesystem', input: {} },
        { type: 'text', text: 'checkpoint text' },
      ]),
    ];

    const result = applyContextSwipe(
      messages,
      'checkpoint',
      new Set(['filesystem']),
      'anthropic',
      testFilter
    );

    // Checkpoint: thinking removed, but tool_use preserved (isCheckpointMessage=true)
    expect(result[0].content.fullContent).toEqual([
      { type: 'tool_use', id: 'tool1', name: 'filesystem', input: {} },
      { type: 'text', text: 'checkpoint text' },
    ]);
  });

  it('does not mutate original messages', () => {
    const original = [
      { type: 'thinking', thinking: 'deep' },
      { type: 'text', text: 'hello' },
    ];
    const messages = [
      msg('m1', 'assistant', 'anthropic', original),
      msg('cp', 'assistant', 'anthropic', [{ type: 'text', text: 'cp' }]),
    ];

    applyContextSwipe(messages, 'cp', new Set<string>(), 'anthropic', testFilter);

    // Original message fullContent unchanged
    expect(messages[0].content.fullContent).toEqual([
      { type: 'thinking', thinking: 'deep' },
      { type: 'text', text: 'hello' },
    ]);
  });

  it('messages after checkpoint are untouched', () => {
    const messages = [
      msg('cp', 'assistant', 'anthropic', [{ type: 'text', text: 'cp' }]),
      msg('after', 'assistant', 'anthropic', [
        { type: 'thinking', thinking: 'post-cp thinking' },
        { type: 'text', text: 'after text' },
      ]),
    ];

    const result = applyContextSwipe(messages, 'cp', new Set<string>(), 'anthropic', testFilter);

    // After-checkpoint message: thinking preserved (not filtered)
    expect(result[1].content.fullContent).toEqual([
      { type: 'thinking', thinking: 'post-cp thinking' },
      { type: 'text', text: 'after text' },
    ]);
  });

  it('handles multiple tool removals cascading across messages', () => {
    const messages = [
      msg('a1', 'assistant', 'anthropic', [
        { type: 'tool_use', id: 't1', name: 'filesystem', input: {} },
        { type: 'tool_use', id: 't2', name: 'javascript', input: {} },
        { type: 'tool_use', id: 't3', name: 'memory', input: {} },
      ]),
      msg('u1', 'user', 'anthropic', [
        { type: 'tool_result', tool_use_id: 't1', content: 'fs result' },
        { type: 'tool_result', tool_use_id: 't2', content: 'js result' },
        { type: 'tool_result', tool_use_id: 't3', content: 'mem result' },
      ]),
      msg('cp', 'assistant', 'anthropic', [{ type: 'text', text: 'done' }]),
    ];

    const result = applyContextSwipe(
      messages,
      'cp',
      new Set(['filesystem', 'javascript']),
      'anthropic',
      testFilter
    );

    // a1: only memory tool_use kept
    expect(result[0].content.fullContent).toEqual([
      { type: 'tool_use', id: 't3', name: 'memory', input: {} },
    ]);
    // u1: only memory tool_result kept
    expect(result[1].content.fullContent).toEqual([
      { type: 'tool_result', tool_use_id: 't3', content: 'mem result' },
    ]);
  });

  it('preserves checkpoint tool_use when checkpointMessageId points to tool_use assistant message', () => {
    // Models the full checkpoint flow:
    // a1: pre-checkpoint assistant with filesystem tool (should be swiped)
    // u1: tool_result for a1
    // a2 (checkpoint): assistant with checkpoint tool_use + text (tool blocks preserved)
    // u2: tool_result for checkpoint
    // a3: end_turn response after checkpoint
    // u3: "please continue" auto-continue message
    const messages = [
      msg('a1', 'assistant', 'anthropic', [
        { type: 'thinking', thinking: 'planning' },
        { type: 'tool_use', id: 't1', name: 'filesystem', input: { path: '/' } },
      ]),
      msg('u1', 'user', 'anthropic', [
        { type: 'tool_result', tool_use_id: 't1', content: 'file listing' },
      ]),
      msg('a2_checkpoint', 'assistant', 'anthropic', [
        { type: 'thinking', thinking: 'setting checkpoint' },
        { type: 'tool_use', id: 't_ckpt', name: 'checkpoint', input: {} },
        { type: 'text', text: 'checkpoint response' },
      ]),
      msg('u2', 'user', 'anthropic', [
        { type: 'tool_result', tool_use_id: 't_ckpt', content: 'Checkpoint created' },
      ]),
      msg('a3', 'assistant', 'anthropic', [{ type: 'text', text: 'continuing work' }]),
      msg('u3', 'user', 'anthropic', [{ type: 'text', text: 'please continue' }]),
    ];

    // checkpointMessageId points to a2 (the tool_use message), NOT a3
    const result = applyContextSwipe(
      messages,
      'a2_checkpoint',
      new Set(['filesystem', 'checkpoint']),
      'anthropic',
      testFilter
    );

    // a1: thinking removed, filesystem tool_use swiped → message dropped (empty)
    // u1: filesystem tool_result swiped → message dropped (empty)
    // a2 (checkpoint): thinking removed, tool blocks PRESERVED (isCheckpoint=true)
    // u2, a3, u3: after checkpoint, untouched
    expect(result.length).toBe(4);
    expect(result[0].id).toBe('a2_checkpoint');
    expect(result[0].content.fullContent).toEqual([
      { type: 'tool_use', id: 't_ckpt', name: 'checkpoint', input: {} },
      { type: 'text', text: 'checkpoint response' },
    ]);
    // Messages after checkpoint are untouched
    expect(result[1].id).toBe('u2');
    expect(result[2].id).toBe('a3');
    expect(result[3].id).toBe('u3');
  });

  it('handles empty swipeToolNames (only thinking removed)', () => {
    const messages = [
      msg('a1', 'assistant', 'anthropic', [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'tool_use', id: 't1', name: 'filesystem', input: {} },
        { type: 'text', text: 'hi' },
      ]),
      msg('cp', 'assistant', 'anthropic', [{ type: 'text', text: 'done' }]),
    ];

    const result = applyContextSwipe(
      messages,
      'cp',
      new Set<string>(), // empty set
      'anthropic',
      testFilter
    );

    // thinking removed, tool_use kept
    expect(result[0].content.fullContent).toEqual([
      { type: 'tool_use', id: 't1', name: 'filesystem', input: {} },
      { type: 'text', text: 'hi' },
    ]);
  });
});
