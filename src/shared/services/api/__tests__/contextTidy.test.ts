import { describe, it, expect } from 'vitest';
import { findCheckpointIndex, findThinkingBoundary, tidyAgnosticMessage } from '../contextTidy';
import type { Message, ToolUseBlock, ToolResultBlock } from '../../../protocol/types';

function msg(
  id: string,
  role: 'user' | 'assistant',
  opts?: {
    toolCalls?: ToolUseBlock[];
    toolResults?: ToolResultBlock[];
    text?: string;
  }
): Message<unknown> {
  return {
    id,
    role,
    content: {
      type: 'text',
      content: opts?.text ?? `text-${id}`,
      toolCalls: opts?.toolCalls,
      toolResults: opts?.toolResults,
    },
    timestamp: new Date(),
  };
}

describe('findCheckpointIndex', () => {
  it('returns -1 when id is undefined', () => {
    expect(findCheckpointIndex([msg('m1', 'user')], undefined)).toBe(-1);
  });

  it('returns -1 when id not found', () => {
    expect(findCheckpointIndex([msg('m1', 'user')], 'nope')).toBe(-1);
  });

  it('finds checkpoint scanning newest first', () => {
    const messages = [msg('a', 'user'), msg('b', 'assistant'), msg('c', 'user')];
    expect(findCheckpointIndex(messages, 'b')).toBe(1);
  });
});

describe('findThinkingBoundary', () => {
  it('returns -1 when no user messages', () => {
    expect(findThinkingBoundary([msg('a1', 'assistant')])).toBe(-1);
  });

  it('returns index of last text user message', () => {
    const messages = [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user')];
    expect(findThinkingBoundary(messages)).toBe(2);
  });

  it('skips user messages with tool results', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant'),
      msg('u2', 'user', {
        toolResults: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'result' }],
      }),
    ];
    expect(findThinkingBoundary(messages)).toBe(0);
  });
});

describe('tidyAgnosticMessage', () => {
  it('returns checkpoint message unchanged', () => {
    const m = msg('cp', 'assistant', {
      toolCalls: [{ type: 'tool_use', id: 't1', name: 'fs', input: {} }],
    });
    const { message, newRemovedIds } = tidyAgnosticMessage(m, new Set(['fs']), new Set(), true);
    expect(message).toBe(m);
    expect(newRemovedIds).toEqual([]);
  });

  it('filters toolCalls by name and collects removed IDs', () => {
    const removedIds = new Set<string>();
    const m = msg('a1', 'assistant', {
      toolCalls: [
        { type: 'tool_use', id: 't1', name: 'filesystem', input: {} },
        { type: 'tool_use', id: 't2', name: 'memory', input: {} },
      ],
    });
    const { message, newRemovedIds } = tidyAgnosticMessage(
      m,
      new Set(['filesystem']),
      removedIds,
      false
    );
    expect(message!.content.toolCalls).toEqual([
      { type: 'tool_use', id: 't2', name: 'memory', input: {} },
    ]);
    expect(newRemovedIds).toEqual(['t1']);
  });

  it('filters toolResults by removedToolUseIds', () => {
    const removedIds = new Set(['t1']);
    const m = msg('u1', 'user', {
      toolResults: [
        { type: 'tool_result', tool_use_id: 't1', content: 'fs' },
        { type: 'tool_result', tool_use_id: 't2', content: 'mem' },
      ],
    });
    const { message } = tidyAgnosticMessage(m, new Set(), removedIds, false);
    expect(message!.content.toolResults).toEqual([
      { type: 'tool_result', tool_use_id: 't2', content: 'mem' },
    ]);
  });

  it('drops message when all tools removed and no text', () => {
    const m = msg('a1', 'assistant', {
      text: '',
      toolCalls: [{ type: 'tool_use', id: 't1', name: 'filesystem', input: {} }],
    });
    const { message } = tidyAgnosticMessage(m, new Set(['filesystem']), new Set(), false);
    expect(message).toBeNull();
  });

  it('keeps message with text even when all tools removed', () => {
    const m = msg('a1', 'assistant', {
      text: 'some text',
      toolCalls: [{ type: 'tool_use', id: 't1', name: 'filesystem', input: {} }],
    });
    const { message } = tidyAgnosticMessage(m, new Set(['filesystem']), new Set(), false);
    expect(message).not.toBeNull();
    expect(message!.content.toolCalls).toBeUndefined();
  });

  it('drops message with no text and no tools', () => {
    const m = msg('a1', 'assistant', { text: '' });
    const { message } = tidyAgnosticMessage(m, new Set(), new Set(), false);
    expect(message).toBeNull();
  });

  it('keeps message with text and no tools', () => {
    const m = msg('a1', 'assistant', { text: 'hello' });
    const { message } = tidyAgnosticMessage(m, new Set(), new Set(), false);
    expect(message).toBe(m);
  });

  it('does not mutate original toolCalls array', () => {
    const originalCalls: ToolUseBlock[] = [
      { type: 'tool_use', id: 't1', name: 'filesystem', input: {} },
      { type: 'tool_use', id: 't2', name: 'memory', input: {} },
    ];
    const m = msg('a1', 'assistant', { toolCalls: originalCalls });
    tidyAgnosticMessage(m, new Set(['filesystem']), new Set(), false);
    expect(originalCalls).toHaveLength(2);
  });
});
