import { describe, it, expect } from 'vitest';
import type { Message } from '../../../shared/protocol/types';
import type { RenderingBlockGroup } from '../../../shared/protocol/types/content';
import {
  isToolResultMessage,
  messagePreviewLine,
  userMessageText,
  formatTokenCount,
  formatTokens,
  formatTokenGroup,
  formatTimestamp,
  formatContextWindow,
  truncateModelName,
  tailPreview,
} from '../messageFormatters';

describe('tailPreview', () => {
  it('returns short text unchanged', () => {
    expect(tailPreview('ok')).toBe('ok');
    expect(tailPreview('x'.repeat(200))).toBe('x'.repeat(200));
  });

  it('keeps the end of long text behind an ellipsis', () => {
    const text = 'a'.repeat(1000) + 'THE END';
    const preview = tailPreview(text, 20);
    expect(preview).toBe('…' + text.slice(-20));
    expect(preview.endsWith('THE END')).toBe(true);
  });
});

describe('formatTimestamp', () => {
  it('shows month, day and time without the year for the current year', () => {
    const now = new Date(2026, 8, 10, 9, 0);
    expect(formatTimestamp(new Date(2026, 8, 10, 15, 42), now)).toBe('Sep 10, 3:42 PM');
  });

  it('spells out the year when it differs from the current one', () => {
    const now = new Date(2026, 8, 10, 9, 0);
    expect(formatTimestamp(new Date(2025, 11, 3, 15, 42), now)).toBe('Dec 3, 2025, 3:42 PM');
  });
});

describe('formatContextWindow', () => {
  it('returns empty for missing or zero usage', () => {
    expect(formatContextWindow(undefined, 200000)).toBe('');
    expect(formatContextWindow(0, 200000)).toBe('');
  });

  it('renders usage alone when the window is unknown', () => {
    expect(formatContextWindow(5000)).toBe('5000');
    expect(formatContextWindow(12500, 0)).toBe('12.5k');
  });

  it('renders usage/max when both are known', () => {
    expect(formatContextWindow(12500, 200000)).toBe('12.5k/200.0k');
  });
});

describe('truncateModelName', () => {
  it('leaves ids at or under the limit alone', () => {
    expect(truncateModelName('gpt-5-2026-08-01')).toBe('gpt-5-2026-08-01');
    expect(truncateModelName('gpt-5')).toBe('gpt-5');
  });

  it('keeps max-1 characters plus an ellipsis for longer ids', () => {
    expect(truncateModelName('claude-fable-5-1-20260901')).toBe('claude-fable-5-…');
    expect(truncateModelName('claude-fable-5-1-20260901', 8)).toBe('claude-…');
  });
});

describe('formatTokenCount', () => {
  it('returns plain number for small counts', () => {
    expect(formatTokenCount(500)).toBe('500');
    expect(formatTokenCount(10000)).toBe('10000');
  });

  it('formats large counts as ##.#k', () => {
    expect(formatTokenCount(10001)).toBe('10.0k');
    expect(formatTokenCount(12500)).toBe('12.5k');
    expect(formatTokenCount(150000)).toBe('150.0k');
  });
});

describe('formatTokens', () => {
  it('returns empty string for zero or undefined', () => {
    expect(formatTokens('↑', 0)).toBe('');
    expect(formatTokens('↑', undefined)).toBe('');
  });

  it('formats with prefix', () => {
    expect(formatTokens('↑', 123)).toBe('↑123');
    expect(formatTokens(' R:', 456)).toBe(' R:456');
  });
});

describe('formatTokenGroup', () => {
  it('returns empty string when main is undefined', () => {
    expect(formatTokenGroup('↑', undefined, [])).toBe('');
  });

  it('renders zero main token count', () => {
    expect(formatTokenGroup('↑', 0, [])).toBe('↑0');
    expect(formatTokenGroup('↑', 0, [{ prefix: 'C↑', value: 100 }])).toBe('↑(0, C↑100)');
  });

  it('returns flat format when no extras', () => {
    expect(formatTokenGroup('↑', 123, [])).toBe('↑123');
    expect(formatTokenGroup('↓', 456, [])).toBe('↓456');
  });

  it('returns flat format when all extras are zero or undefined', () => {
    expect(
      formatTokenGroup('↑', 123, [
        { prefix: 'C↑', value: 0 },
        { prefix: 'C↓', value: undefined },
      ])
    ).toBe('↑123');
  });

  it('returns grouped format with one extra', () => {
    expect(formatTokenGroup('↓', 456, [{ prefix: 'R:', value: 789 }])).toBe('↓(456, R:789)');
  });

  it('returns grouped format with multiple extras', () => {
    expect(
      formatTokenGroup('↑', 123, [
        { prefix: 'C↑', value: 101 },
        { prefix: 'C↓', value: 202 },
      ])
    ).toBe('↑(123, C↑101, C↓202)');
  });

  it('filters out zero extras from grouped format', () => {
    expect(
      formatTokenGroup('↑', 123, [
        { prefix: 'C↑', value: 101 },
        { prefix: 'C↓', value: 0 },
      ])
    ).toBe('↑(123, C↑101)');
  });

  it('uses k-format for large numbers', () => {
    expect(formatTokenGroup('↑', 50000, [{ prefix: 'C↓', value: 20000 }])).toBe(
      '↑(50.0k, C↓20.0k)'
    );
  });
});

function message(
  role: 'user' | 'assistant',
  content: string,
  renderingContent?: RenderingBlockGroup[],
  attachmentIds?: string[]
): Message<unknown> {
  return {
    id: 'm1',
    role,
    timestamp: new Date(2026, 0, 1),
    content: { type: 'text', content, renderingContent, attachmentIds },
  } as Message<unknown>;
}

const textGroup = (...texts: string[]): RenderingBlockGroup => ({
  category: 'text',
  blocks: texts.map(text => ({ type: 'text', text })),
});

const toolResultGroup: RenderingBlockGroup = {
  category: 'backstage',
  blocks: [{ type: 'tool_result', tool_use_id: 't1', name: 'read', content: 'ok' }],
} as unknown as RenderingBlockGroup;

describe('userMessageText', () => {
  it('joins the rendered text blocks', () => {
    expect(userMessageText(message('user', 'raw', [textGroup('Hello ', 'world')]))).toBe(
      'Hello world'
    );
  });

  it('falls back to the raw content minus metadata', () => {
    expect(userMessageText(message('user', '<metadata>x</metadata>\nHi'))).toBe('Hi');
  });
});

describe('isToolResultMessage', () => {
  it('is a user message carrying tool_result blocks', () => {
    expect(isToolResultMessage(message('user', '', [toolResultGroup]))).toBe(true);
    expect(isToolResultMessage(message('user', 'hi', [textGroup('hi')]))).toBe(false);
    expect(isToolResultMessage(message('assistant', '', [toolResultGroup]))).toBe(false);
  });
});

describe('messagePreviewLine', () => {
  it('takes the first non-empty line without markdown markers', () => {
    const assistant = message('assistant', '', [textGroup('\n## Plan\n\nStep one')]);
    expect(messagePreviewLine(assistant)).toBe('Plan');
    expect(messagePreviewLine(message('user', '', [textGroup('> quoted\nmore')]))).toBe('quoted');
  });

  it('truncates long lines', () => {
    const line = messagePreviewLine(message('user', '', [textGroup('x'.repeat(300))]), 10);
    expect(line).toBe(`${'x'.repeat(9)}…`);
  });

  it('names tool results, tool calls and attachments when there is no text', () => {
    expect(messagePreviewLine(message('user', '', [toolResultGroup]))).toBe('Tool results');
    const toolCalls: RenderingBlockGroup = {
      category: 'backstage',
      blocks: [
        { type: 'tool_use', id: '1', name: 'read_file', input: {} },
        { type: 'tool_use', id: '2', name: 'grep', input: {} },
      ],
    };
    expect(messagePreviewLine(message('assistant', '', [toolCalls]))).toBe('read_file, grep');
    expect(messagePreviewLine(message('user', '', [textGroup()], ['att_1']))).toBe('Attachment');
    expect(messagePreviewLine(message('assistant', '', []))).toBe('…');
  });
});
