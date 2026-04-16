import { describe, it, expect } from 'vitest';
import type { Message } from '../../../types';
import { applyNudgeThinking } from '../apiService';

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
  it('appends nudge suffix to last user message', () => {
    const messages = [
      userMsg('u1', 'Hello'),
      assistantMsg('a1', 'Hi'),
      userMsg('u2', 'Think about this'),
    ];
    const result = applyNudgeThinking(messages);

    expect(result[2].content.content).toBe('Think about this\n\n<<WITH THINKING STEPS>>');
    expect(result[0].content.content).toBe('Hello');
  });

  it('does not mutate original messages', () => {
    const messages = [userMsg('u1', 'Hello')];
    const result = applyNudgeThinking(messages);

    expect(result).not.toBe(messages);
    expect(messages[0].content.content).toBe('Hello');
    expect(result[0].content.content).toBe('Hello\n\n<<WITH THINKING STEPS>>');
  });

  it('returns original array when no user message exists', () => {
    const messages = [assistantMsg('a1', 'Hi')];
    const result = applyNudgeThinking(messages);

    expect(result).toBe(messages);
  });

  it('handles empty messages array', () => {
    const result = applyNudgeThinking([]);
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
    const result = applyNudgeThinking(messages);

    expect(result[0].content.content).toBe('First');
    expect(result[2].content.content).toBe('Second');
    expect(result[4].content.content).toBe('Third\n\n<<WITH THINKING STEPS>>');
  });
});
