import { describe, it, expect } from 'vitest';
import type { APIType, Message, ToolResultBlock } from '../../../protocol/types';
import {
  findCheckpointIndex,
  findThinkingBoundary,
  findThinkingBoundaryN,
  tidyAgnosticMessage,
} from '../contextTidy';

function msg(
  id: string,
  role: 'user' | 'assistant',
  opts?: {
    modelFamily?: APIType;
    fullContent?: unknown;
    toolResults?: ToolResultBlock[];
  }
): Message<unknown> {
  return {
    id,
    role,
    content: {
      type: 'text',
      content: `text-${id}`,
      modelFamily: opts?.modelFamily,
      fullContent: opts?.fullContent,
      toolResults: opts?.toolResults,
    },
    timestamp: new Date(),
  };
}

/**
 * Replicates the Anthropic tidyMessages logic for testing.
 * Tests the combined checkpoint + thinking + empty text pruning behavior.
 */
function tidyAnthropicMessages(
  messages: Message<unknown>[],
  checkpointMessageId: string | undefined,
  tidyToolNames: Set<string> | undefined,
  pruneThinking: boolean,
  pruneEmptyText: boolean
): Message<unknown>[] {
  const checkpointIdx = findCheckpointIndex(messages, checkpointMessageId);
  const thinkingBoundary = pruneThinking || pruneEmptyText ? findThinkingBoundary(messages) : -1;

  if (checkpointIdx === -1 && thinkingBoundary <= 0) return messages;

  const toolNames = tidyToolNames ?? new Set<string>();
  const removedToolUseIds = new Set<string>();
  const processUntil = Math.max(checkpointIdx, thinkingBoundary - 1);
  const result: Message<unknown>[] = [];

  for (let i = 0; i <= processUntil; i++) {
    const m = messages[i];
    const inCheckpoint = checkpointIdx >= 0 && i <= checkpointIdx;
    const isCheckpoint = inCheckpoint && i === checkpointIdx;
    const inThinking = thinkingBoundary > 0 && i < thinkingBoundary;

    if (m.content.modelFamily !== 'anthropic' || m.content.fullContent == null) {
      if (inCheckpoint && !isCheckpoint) {
        const { message, newRemovedIds } = tidyAgnosticMessage(
          m,
          toolNames,
          removedToolUseIds,
          false
        );
        for (const id of newRemovedIds) removedToolUseIds.add(id);
        if (message) result.push(message);
      } else if (inThinking) {
        const hasText = m.content.content.trim().length > 0;
        const hasTools =
          (m.content.toolCalls?.length ?? 0) + (m.content.toolResults?.length ?? 0) > 0;
        if (hasText || hasTools) result.push(m);
      } else {
        result.push(m);
      }
      continue;
    }

    let blocks = m.content.fullContent as {
      type?: string;
      id?: string;
      name?: string;
      tool_use_id?: string;
      text?: string;
    }[];

    if (inCheckpoint) {
      const filtered: typeof blocks = [];
      for (const b of blocks) {
        if (b.type === 'thinking' || b.type === 'redacted_thinking') continue;
        if (isCheckpoint) {
          filtered.push(b);
          continue;
        }
        if (b.type === 'tool_use' && b.name && toolNames.has(b.name)) {
          if (b.id) removedToolUseIds.add(b.id);
          continue;
        }
        if (b.type === 'tool_result' && b.tool_use_id && removedToolUseIds.has(b.tool_use_id)) {
          continue;
        }
        filtered.push(b);
      }
      blocks = filtered;
    }

    if (inThinking && !inCheckpoint && pruneThinking) {
      blocks = blocks.filter(b => b.type !== 'thinking' && b.type !== 'redacted_thinking');
    }

    if (inThinking && pruneEmptyText) {
      blocks = blocks.filter(b => b.type !== 'text' || (b.text?.trim()?.length ?? 0) > 0);
    }

    if (blocks.length === 0) continue;
    if (blocks !== (m.content.fullContent as typeof blocks)) {
      result.push({ ...m, content: { ...m.content, fullContent: blocks } });
    } else {
      result.push(m);
    }
  }

  for (let i = processUntil + 1; i < messages.length; i++) {
    result.push(messages[i]);
  }

  return result;
}

describe('tidyMessages (Anthropic thinking pruning)', () => {
  it('strips thinking blocks from messages before last user text', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'hello' },
        ],
      }),
      msg('u2', 'user'),
      msg('a2', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'still thinking' },
          { type: 'text', text: 'world' },
        ],
      }),
    ];

    const result = tidyAnthropicMessages(messages, undefined, undefined, true, false);

    // a1 should have thinking stripped (before u2)
    const a1Content = result.find(m => m.id === 'a1')!.content.fullContent as { type: string }[];
    expect(a1Content).toEqual([{ type: 'text', text: 'hello' }]);

    // a2 is after last user text (u2), so thinking preserved
    const a2Content = result.find(m => m.id === 'a2')!.content.fullContent as { type: string }[];
    expect(a2Content).toHaveLength(2);
    expect(a2Content[0].type).toBe('thinking');
  });

  it('strips redacted_thinking blocks too', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'redacted_thinking', data: 'secret' },
          { type: 'text', text: 'answer' },
        ],
      }),
      msg('u2', 'user'),
    ];

    const result = tidyAnthropicMessages(messages, undefined, undefined, true, false);
    const a1Content = result.find(m => m.id === 'a1')!.content.fullContent as { type: string }[];
    expect(a1Content).toEqual([{ type: 'text', text: 'answer' }]);
  });

  it('drops messages that become empty after pruning', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [{ type: 'thinking', thinking: 'only thinking' }],
      }),
      msg('u2', 'user'),
    ];

    const result = tidyAnthropicMessages(messages, undefined, undefined, true, false);
    expect(result.find(m => m.id === 'a1')).toBeUndefined();
    expect(result).toHaveLength(2);
  });

  it('preserves thinking in agentic loop (after last user text)', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'tool_use', id: 'tc1', name: 'search', input: {} },
        ],
      }),
      msg('u2', 'user', {
        toolResults: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'result' }],
      }),
      msg('a2', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'still thinking' },
          { type: 'text', text: 'done' },
        ],
      }),
    ];

    const result = tidyAnthropicMessages(messages, undefined, undefined, true, false);
    expect(result).toHaveLength(4);
    const a1Content = result.find(m => m.id === 'a1')!.content.fullContent as { type: string }[];
    expect(a1Content[0].type).toBe('thinking');
  });

  it('returns messages unchanged when no text user message found', () => {
    const messages = [
      msg('a1', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'hi' },
        ],
      }),
    ];

    const result = tidyAnthropicMessages(messages, undefined, undefined, true, false);
    expect(result).toBe(messages);
  });

  it('returns messages unchanged when boundary at index 0', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'x' },
          { type: 'text', text: 'y' },
        ],
      }),
    ];

    const result = tidyAnthropicMessages(messages, undefined, undefined, true, false);
    expect(result).toBe(messages);
  });

  it('ignores messages from other model families', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'chatgpt',
        fullContent: { role: 'assistant', content: 'hello' },
      }),
      msg('u2', 'user'),
    ];

    const result = tidyAnthropicMessages(messages, undefined, undefined, true, false);
    expect(result).toHaveLength(3);
    expect(result[1].content.fullContent).toEqual({ role: 'assistant', content: 'hello' });
  });
});

describe('tidyMessages (empty text pruning)', () => {
  it('removes empty text blocks from pre-boundary messages', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'text', text: '' },
          { type: 'tool_use', id: 'tc1', name: 'search', input: {} },
        ],
      }),
      msg('u2', 'user'),
    ];

    const result = tidyAnthropicMessages(messages, undefined, undefined, false, true);
    const a1Content = result.find(m => m.id === 'a1')!.content.fullContent as { type: string }[];
    expect(a1Content).toEqual([{ type: 'tool_use', id: 'tc1', name: 'search', input: {} }]);
  });

  it('removes whitespace-only text blocks', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'text', text: '   ' },
          { type: 'text', text: 'real content' },
        ],
      }),
      msg('u2', 'user'),
    ];

    const result = tidyAnthropicMessages(messages, undefined, undefined, false, true);
    const a1Content = result.find(m => m.id === 'a1')!.content.fullContent as {
      type: string;
      text: string;
    }[];
    expect(a1Content).toEqual([{ type: 'text', text: 'real content' }]);
  });

  it('drops message when only empty text blocks remain', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [{ type: 'text', text: '' }],
      }),
      msg('u2', 'user'),
    ];

    const result = tidyAnthropicMessages(messages, undefined, undefined, false, true);
    expect(result.find(m => m.id === 'a1')).toBeUndefined();
  });

  it('preserves empty text blocks in current agentic loop', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'text', text: '' },
          { type: 'tool_use', id: 'tc1', name: 'search', input: {} },
        ],
      }),
    ];

    const result = tidyAnthropicMessages(messages, undefined, undefined, false, true);
    expect(result).toBe(messages);
  });
});

describe('tidyMessages (combined thinking + empty text)', () => {
  it('strips both thinking and empty text from same message', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: '' },
          { type: 'text', text: 'real' },
        ],
      }),
      msg('u2', 'user'),
    ];

    const result = tidyAnthropicMessages(messages, undefined, undefined, true, true);
    const a1Content = result.find(m => m.id === 'a1')!.content.fullContent as {
      type: string;
      text: string;
    }[];
    expect(a1Content).toEqual([{ type: 'text', text: 'real' }]);
  });

  it('drops message when thinking + empty text removal empties it', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'text', text: '' },
        ],
      }),
      msg('u2', 'user'),
    ];

    const result = tidyAnthropicMessages(messages, undefined, undefined, true, true);
    expect(result.find(m => m.id === 'a1')).toBeUndefined();
  });
});

describe('tidyMessages (checkpoint + thinking combined)', () => {
  it('handles checkpoint and thinking boundary together', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'old' },
          { type: 'text', text: 'response1' },
        ],
      }),
      msg('cp', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'cp thought' },
          { type: 'text', text: 'checkpoint' },
        ],
      }),
      msg('u2', 'user'),
      msg('a2', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'post-cp' },
          { type: 'text', text: 'after checkpoint' },
        ],
      }),
      msg('u3', 'user'),
      msg('a3', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'current' },
          { type: 'text', text: 'latest' },
        ],
      }),
    ];

    const result = tidyAnthropicMessages(messages, 'cp', new Set(), true, false);

    const a1 = result.find(m => m.id === 'a1')!.content.fullContent as { type: string }[];
    expect(a1).toEqual([{ type: 'text', text: 'response1' }]);

    const cp = result.find(m => m.id === 'cp')!.content.fullContent as { type: string }[];
    expect(cp).toEqual([{ type: 'text', text: 'checkpoint' }]);

    const a2 = result.find(m => m.id === 'a2')!.content.fullContent as { type: string }[];
    expect(a2).toEqual([{ type: 'text', text: 'after checkpoint' }]);

    const a3 = result.find(m => m.id === 'a3')!.content.fullContent as { type: string }[];
    expect(a3).toHaveLength(2);
    expect(a3[0].type).toBe('thinking');
  });
});

describe('tidyMessages (Google thoughtSignature)', () => {
  /**
   * Replicates Google tidyMessages for testing thoughtSignature stripping.
   */
  function tidyGoogleMessages(
    messages: Message<unknown>[],
    checkpointMessageId: string | undefined,
    tidyToolNames: Set<string> | undefined,
    pruneThinking: boolean,
    pruneEmptyText: boolean
  ): Message<unknown>[] {
    const checkpointIdx = findCheckpointIndex(messages, checkpointMessageId);
    const thinkingBoundary = pruneThinking || pruneEmptyText ? findThinkingBoundary(messages) : -1;

    if (checkpointIdx === -1 && thinkingBoundary <= 0) return messages;

    const toolNames = tidyToolNames ?? new Set<string>();
    const removedToolUseIds = new Set<string>();
    const processUntil = Math.max(checkpointIdx, thinkingBoundary - 1);
    const result: Message<unknown>[] = [];

    type PartLike = {
      text?: string;
      thought?: boolean;
      thoughtSignature?: string;
      functionCall?: { name: string; args?: unknown };
      functionResponse?: { name: string; response?: unknown };
    };

    for (let i = 0; i <= processUntil; i++) {
      const m = messages[i];
      const inCheckpoint = checkpointIdx >= 0 && i <= checkpointIdx;
      const isCheckpoint = inCheckpoint && i === checkpointIdx;
      const inThinking = thinkingBoundary > 0 && i < thinkingBoundary;

      if (m.content.modelFamily !== 'google' || m.content.fullContent == null) {
        if (inCheckpoint && !isCheckpoint) {
          const { message, newRemovedIds } = tidyAgnosticMessage(
            m,
            toolNames,
            removedToolUseIds,
            false
          );
          for (const id of newRemovedIds) removedToolUseIds.add(id);
          if (message) result.push(message);
        } else if (inThinking) {
          const hasText = m.content.content.trim().length > 0;
          const hasTools =
            (m.content.toolCalls?.length ?? 0) + (m.content.toolResults?.length ?? 0) > 0;
          if (hasText || hasTools) result.push(m);
        } else {
          result.push(m);
        }
        continue;
      }

      let parts = m.content.fullContent as PartLike[];

      if (inCheckpoint) {
        const filtered: PartLike[] = [];
        for (const p of parts) {
          if (p.thought) continue;
          if (isCheckpoint) {
            if (p.thoughtSignature) {
              const { thoughtSignature: _, ...rest } = p;
              if (Object.keys(rest).length > 0) filtered.push(rest);
            } else {
              filtered.push(p);
            }
            continue;
          }
          if (p.functionCall?.name && toolNames.has(p.functionCall.name)) {
            removedToolUseIds.add(p.functionCall.name);
            continue;
          }
          if (p.functionResponse?.name && removedToolUseIds.has(p.functionResponse.name)) {
            continue;
          }
          if (p.thoughtSignature) {
            const { thoughtSignature: _, ...rest } = p;
            if (Object.keys(rest).length > 0) filtered.push(rest);
          } else {
            filtered.push(p);
          }
        }
        parts = filtered;
      }

      if (inThinking && !inCheckpoint) {
        if (pruneThinking) {
          parts = parts.filter(p => !p.thought);
          parts = parts.reduce<PartLike[]>((acc, p) => {
            if (!p.thoughtSignature) {
              acc.push(p);
              return acc;
            }
            const { thoughtSignature: _, ...rest } = p;
            if (Object.keys(rest).length > 0) acc.push(rest);
            return acc;
          }, []);
        }
      }

      if (inThinking && pruneEmptyText) {
        parts = parts.filter(p => {
          if (p.text === undefined || p.thought) return true;
          return p.text.trim().length > 0;
        });
      }

      if (parts.length === 0) continue;
      if (parts !== (m.content.fullContent as PartLike[])) {
        result.push({ ...m, content: { ...m.content, fullContent: parts } });
      } else {
        result.push(m);
      }
    }

    for (let i = processUntil + 1; i < messages.length; i++) {
      result.push(messages[i]);
    }

    return result;
  }

  it('strips thoughtSignature from functionCall parts in thinking range', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'google',
        fullContent: [
          { text: 'thinking...', thought: true, thoughtSignature: 'sig1' },
          { functionCall: { name: 'search', args: {} }, thoughtSignature: 'sig2' },
        ],
      }),
      msg('u2', 'user'),
    ];

    const result = tidyGoogleMessages(messages, undefined, undefined, true, false);
    const a1Parts = result.find(m => m.id === 'a1')!.content.fullContent as {
      thoughtSignature?: string;
    }[];

    expect(a1Parts).toHaveLength(1);
    expect(a1Parts[0]).toEqual({ functionCall: { name: 'search', args: {} } });
    expect(a1Parts[0].thoughtSignature).toBeUndefined();
  });

  it('strips thoughtSignature in checkpoint range', () => {
    const messages = [
      msg('a1', 'assistant', {
        modelFamily: 'google',
        fullContent: [
          { text: 'thought', thought: true, thoughtSignature: 'sig1' },
          { functionCall: { name: 'search', args: {} }, thoughtSignature: 'sig2' },
          { text: 'visible' },
        ],
      }),
      msg('cp', 'assistant', {
        modelFamily: 'google',
        fullContent: [{ text: 'checkpoint' }],
      }),
    ];

    const result = tidyGoogleMessages(messages, 'cp', new Set(), false, false);
    const a1Parts = result.find(m => m.id === 'a1')!.content.fullContent as {
      thoughtSignature?: string;
    }[];

    expect(a1Parts).toHaveLength(2);
    expect(a1Parts[0]).toEqual({ functionCall: { name: 'search', args: {} } });
    expect(a1Parts[1]).toEqual({ text: 'visible' });
  });

  it('preserves thoughtSignature in current agentic loop', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'google',
        fullContent: [
          { text: 'thinking...', thought: true, thoughtSignature: 'sig1' },
          { functionCall: { name: 'search', args: {} }, thoughtSignature: 'sig2' },
        ],
      }),
    ];

    const result = tidyGoogleMessages(messages, undefined, undefined, true, false);
    expect(result).toBe(messages);
  });

  it('drops parts that become empty after thoughtSignature stripping', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'google',
        fullContent: [
          { text: 'thinking...', thought: true, thoughtSignature: 'sig1' },
          { thoughtSignature: 'sig2' },
          { text: 'visible' },
        ],
      }),
      msg('u2', 'user'),
    ];

    const result = tidyGoogleMessages(messages, undefined, undefined, true, false);
    const a1Parts = result.find(m => m.id === 'a1')!.content.fullContent as Record<
      string,
      unknown
    >[];

    // thought part filtered, thoughtSignature-only part dropped, text part kept
    expect(a1Parts).toHaveLength(1);
    expect(a1Parts[0]).toEqual({ text: 'visible' });
  });

  it('drops parts that become empty after thoughtSignature stripping in checkpoint', () => {
    const messages = [
      msg('a1', 'assistant', {
        modelFamily: 'google',
        fullContent: [{ thoughtSignature: 'sig1' }, { text: 'visible' }],
      }),
      msg('cp', 'assistant', {
        modelFamily: 'google',
        fullContent: [{ text: 'checkpoint' }],
      }),
    ];

    const result = tidyGoogleMessages(messages, 'cp', new Set(), false, false);
    const a1Parts = result.find(m => m.id === 'a1')!.content.fullContent as Record<
      string,
      unknown
    >[];

    expect(a1Parts).toHaveLength(1);
    expect(a1Parts[0]).toEqual({ text: 'visible' });
  });

  it('strips thoughtSignature on checkpoint message itself', () => {
    const messages = [
      msg('cp', 'assistant', {
        modelFamily: 'google',
        fullContent: [
          { text: 'thought', thought: true, thoughtSignature: 'sig1' },
          { functionCall: { name: 'search', args: {} }, thoughtSignature: 'sig2' },
        ],
      }),
      msg('u1', 'user'),
    ];

    const result = tidyGoogleMessages(messages, 'cp', new Set(), false, false);
    const cpParts = result.find(m => m.id === 'cp')!.content.fullContent as {
      thoughtSignature?: string;
    }[];
    expect(cpParts).toHaveLength(1);
    expect(cpParts[0].thoughtSignature).toBeUndefined();
  });
});

describe('findThinkingBoundaryN', () => {
  const u = (id: string) => msg(id, 'user');
  const uTool = (id: string): Message<unknown> => ({
    ...msg(id, 'user'),
    content: {
      ...msg(id, 'user').content,
      toolResults: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
    },
  });
  const a = (id: string) => msg(id, 'assistant');

  it('n=1 returns the last user text index (parity with findThinkingBoundary)', () => {
    const messages = [u('u1'), a('a1'), u('u2'), a('a2')];
    expect(findThinkingBoundaryN(messages, 1)).toBe(2);
    expect(findThinkingBoundary(messages)).toBe(2);
  });

  it('n=2 returns the second-to-last user text index', () => {
    const messages = [u('u1'), a('a1'), u('u2'), a('a2'), u('u3')];
    expect(findThinkingBoundaryN(messages, 2)).toBe(2);
  });

  it('n=3 returns the third-to-last user text index', () => {
    const messages = [u('u1'), a('a1'), u('u2'), a('a2'), u('u3')];
    expect(findThinkingBoundaryN(messages, 3)).toBe(0);
  });

  it('user messages carrying tool_results are skipped (only plain user text counts)', () => {
    // U a U-tool a U  → user-text msgs are at indices 0 and 4.
    const messages = [u('u1'), a('a1'), uTool('ut'), a('a2'), u('u3')];
    expect(findThinkingBoundaryN(messages, 1)).toBe(4);
    expect(findThinkingBoundaryN(messages, 2)).toBe(0);
  });

  it('returns -1 when fewer than n user text messages exist', () => {
    const messages = [u('u1'), a('a1')];
    expect(findThinkingBoundaryN(messages, 2)).toBe(-1);
  });

  it('n<=0 returns messages.length so every message is "before the boundary"', () => {
    const messages = [u('u1'), a('a1'), u('u2')];
    expect(findThinkingBoundaryN(messages, 0)).toBe(messages.length);
    expect(findThinkingBoundaryN(messages, -5)).toBe(messages.length);
  });
});

describe('tidyMessages with pruneThinkingKeepTurns (N-turn pruning)', () => {
  it('N=1 → only thinking before the last user text is stripped (matches legacy)', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'old' },
          { type: 'text', text: 'first' },
        ],
      }),
      msg('u2', 'user'),
      msg('a2', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'fresh' },
          { type: 'text', text: 'second' },
        ],
      }),
    ];

    const result = tidyAnthropicMessagesN(messages, undefined, new Set(), 1);
    const a1Blocks = result.find(m => m.id === 'a1')!.content.fullContent as {
      type?: string;
    }[];
    expect(a1Blocks.find(b => b.type === 'thinking')).toBeUndefined();
    const a2Blocks = result.find(m => m.id === 'a2')!.content.fullContent as {
      type?: string;
    }[];
    expect(a2Blocks.find(b => b.type === 'thinking')).toBeDefined();
  });

  it('N=2 → keeps thinking from the prior user-text turn onward', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'old' },
          { type: 'text', text: 'oldtxt' },
        ],
      }),
      msg('u2', 'user'),
      msg('a2', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'midthink' },
          { type: 'text', text: 'midtxt' },
        ],
      }),
      msg('u3', 'user'),
      msg('a3', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'freshthink' },
          { type: 'text', text: 'freshtxt' },
        ],
      }),
    ];

    const result = tidyAnthropicMessagesN(messages, undefined, new Set(), 2);
    const a1Blocks = result.find(m => m.id === 'a1')!.content.fullContent as {
      type?: string;
    }[];
    const a2Blocks = result.find(m => m.id === 'a2')!.content.fullContent as {
      type?: string;
    }[];
    const a3Blocks = result.find(m => m.id === 'a3')!.content.fullContent as {
      type?: string;
    }[];
    expect(a1Blocks.find(b => b.type === 'thinking')).toBeUndefined();
    // a2 is at index 3, boundary is at index 2 (u2). a2 is NOT before boundary.
    expect(a2Blocks.find(b => b.type === 'thinking')).toBeDefined();
    expect(a3Blocks.find(b => b.type === 'thinking')).toBeDefined();
  });

  it('after a fresh user msg with N=1, no thinking is kept', () => {
    // UTRTRTRU pattern, here approximated as: u a u → with thinking on a → result strips a's thinking.
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'recent' },
          { type: 'text', text: 'recent_txt' },
        ],
      }),
      msg('u2', 'user'), // fresh user msg
    ];
    const result = tidyAnthropicMessagesN(messages, undefined, new Set(), 1);
    const a1Blocks = result.find(m => m.id === 'a1')!.content.fullContent as {
      type?: string;
    }[];
    expect(a1Blocks.find(b => b.type === 'thinking')).toBeUndefined();
  });

  it('after a fresh user msg with N=2, the prior agentic-run thinking is preserved', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'recent' },
          { type: 'text', text: 'recent_txt' },
        ],
      }),
      msg('u2', 'user'),
    ];
    const result = tidyAnthropicMessagesN(messages, undefined, new Set(), 2);
    const a1Blocks = result.find(m => m.id === 'a1')!.content.fullContent as {
      type?: string;
    }[];
    expect(a1Blocks.find(b => b.type === 'thinking')).toBeDefined();
  });

  it('undefined → no client-side pruning (legacy provider flag still respected separately)', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', {
        modelFamily: 'anthropic',
        fullContent: [
          { type: 'thinking', thinking: 'kept' },
          { type: 'text', text: 'txt' },
        ],
      }),
      msg('u2', 'user'),
    ];
    const result = tidyAnthropicMessagesN(messages, undefined, new Set(), undefined);
    const a1Blocks = result.find(m => m.id === 'a1')!.content.fullContent as {
      type?: string;
    }[];
    expect(a1Blocks.find(b => b.type === 'thinking')).toBeDefined();
  });
});

/**
 * Mirrors the Anthropic tidyMessages logic with the new `pruneThinkingKeepTurns`
 * parameter — keeps the test self-contained from production code.
 */
function tidyAnthropicMessagesN(
  messages: Message<unknown>[],
  checkpointMessageId: string | undefined,
  tidyToolNames: Set<string> | undefined,
  pruneThinkingKeepTurns: number | undefined
): Message<unknown>[] {
  const checkpointIdx = findCheckpointIndex(messages, checkpointMessageId);
  const projectPruneActive = pruneThinkingKeepTurns !== undefined && pruneThinkingKeepTurns >= 0;
  const effectiveKeep = projectPruneActive ? (pruneThinkingKeepTurns as number) : 1;
  const anyPrune = projectPruneActive;
  const thinkingBoundary = anyPrune ? findThinkingBoundaryN(messages, effectiveKeep) : -1;

  if (checkpointIdx === -1 && thinkingBoundary <= 0) return messages;

  const toolNames = tidyToolNames ?? new Set<string>();
  const removedToolUseIds = new Set<string>();
  const processUntil = Math.max(checkpointIdx, thinkingBoundary - 1);
  const result: Message<unknown>[] = [];

  for (let i = 0; i <= processUntil; i++) {
    const m = messages[i];
    const inCheckpoint = checkpointIdx >= 0 && i <= checkpointIdx;
    const isCheckpoint = inCheckpoint && i === checkpointIdx;
    const inThinking = thinkingBoundary > 0 && i < thinkingBoundary;

    if (m.content.modelFamily !== 'anthropic' || m.content.fullContent == null) {
      if (inCheckpoint && !isCheckpoint) {
        const { message, newRemovedIds } = tidyAgnosticMessage(
          m,
          toolNames,
          removedToolUseIds,
          false
        );
        for (const id of newRemovedIds) removedToolUseIds.add(id);
        if (message) result.push(message);
      } else if (inThinking) {
        const hasText = m.content.content.trim().length > 0;
        const hasTools =
          (m.content.toolCalls?.length ?? 0) + (m.content.toolResults?.length ?? 0) > 0;
        if (hasText || hasTools) result.push(m);
      } else {
        result.push(m);
      }
      continue;
    }

    let blocks = m.content.fullContent as {
      type?: string;
      id?: string;
      name?: string;
      tool_use_id?: string;
      text?: string;
    }[];

    if (inCheckpoint) {
      const filtered: typeof blocks = [];
      for (const b of blocks) {
        if (b.type === 'thinking' || b.type === 'redacted_thinking') continue;
        if (isCheckpoint) {
          filtered.push(b);
          continue;
        }
        if (b.type === 'tool_use' && b.name && toolNames.has(b.name)) {
          if (b.id) removedToolUseIds.add(b.id);
          continue;
        }
        if (b.type === 'tool_result' && b.tool_use_id && removedToolUseIds.has(b.tool_use_id)) {
          continue;
        }
        filtered.push(b);
      }
      blocks = filtered;
    }

    if (inThinking && !inCheckpoint && projectPruneActive) {
      blocks = blocks.filter(b => b.type !== 'thinking' && b.type !== 'redacted_thinking');
    }

    if (blocks.length === 0) continue;
    if (blocks !== (m.content.fullContent as typeof blocks)) {
      result.push({ ...m, content: { ...m.content, fullContent: blocks } });
    } else {
      result.push(m);
    }
  }

  for (let i = processUntil + 1; i < messages.length; i++) {
    result.push(messages[i]);
  }

  return result;
}
