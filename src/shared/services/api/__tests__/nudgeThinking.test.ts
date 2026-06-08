import { describe, it, expect } from 'vitest';
import type { Message } from '../../../protocol/types';
import { applyNudgeThinking, NUDGE_THINKING_DEFAULT } from '../apiService';

function userMsg(id: string, text: string): Message<unknown> {
  return {
    id,
    role: 'user',
    content: { type: 'text', content: text },
    timestamp: new Date(),
  };
}

function assistantMsg(id: string, text: string): Message<unknown> {
  return {
    id,
    role: 'assistant',
    content: { type: 'text', content: text },
    timestamp: new Date(),
  };
}

describe('applyNudgeThinking', () => {
  it('appends nudge to last user message with a blank-line separator', () => {
    const messages = [
      userMsg('u1', 'Hello'),
      assistantMsg('a1', 'Hi'),
      userMsg('u2', 'Think about this'),
    ];
    const result = applyNudgeThinking(messages, NUDGE_THINKING_DEFAULT);

    expect(result[2].content.content).toBe(`Think about this\n\n${NUDGE_THINKING_DEFAULT}`);
    expect(result[0].content.content).toBe('Hello');
  });

  it('accepts arbitrary nudge text for experimentation', () => {
    const messages = [userMsg('u1', 'Task')];
    const result = applyNudgeThinking(messages, '<<TAKE A DEEP BREATH>>');

    expect(result[0].content.content).toBe('Task\n\n<<TAKE A DEEP BREATH>>');
  });

  it('is a no-op when nudge is empty string', () => {
    const messages = [userMsg('u1', 'Hello')];
    const result = applyNudgeThinking(messages, '');

    expect(result).toBe(messages);
    expect(messages[0].content.content).toBe('Hello');
  });

  it('does not mutate original messages', () => {
    const messages = [userMsg('u1', 'Hello')];
    const result = applyNudgeThinking(messages, NUDGE_THINKING_DEFAULT);

    expect(result).not.toBe(messages);
    expect(messages[0].content.content).toBe('Hello');
    expect(result[0].content.content).toBe(`Hello\n\n${NUDGE_THINKING_DEFAULT}`);
  });

  it('returns original array when no user message exists', () => {
    const messages = [assistantMsg('a1', 'Hi')];
    const result = applyNudgeThinking(messages, NUDGE_THINKING_DEFAULT);

    expect(result).toBe(messages);
  });

  it('handles empty messages array', () => {
    const result = applyNudgeThinking([], NUDGE_THINKING_DEFAULT);
    expect(result).toEqual([]);
  });

  it('targets only the last user message when multiple exist', () => {
    const messages = [
      userMsg('u1', 'First'),
      assistantMsg('a1', 'Response'),
      userMsg('u2', 'Second'),
      assistantMsg('a2', 'Response 2'),
      userMsg('u3', 'Third'),
    ];
    const result = applyNudgeThinking(messages, NUDGE_THINKING_DEFAULT);

    expect(result[0].content.content).toBe('First');
    expect(result[2].content.content).toBe('Second');
    expect(result[4].content.content).toBe(`Third\n\n${NUDGE_THINKING_DEFAULT}`);
  });
});
