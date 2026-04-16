import { describe, it, expect } from 'vitest';
import {
  CHAT_INCOMPLETE_TAIL_ERROR_CODE,
  ChatIncompleteTailError,
  assertChatNotLockedByIncompleteTail,
  isChatLockedByIncompleteTail,
} from '../incompleteTail';
import type { Message } from '../../../protocol/types';

const mkMsg = (
  role: Message<unknown>['role'],
  text: string,
  incomplete?: boolean
): Message<unknown> => ({
  id: `msg_${Math.random().toString(36).slice(2, 8)}`,
  role,
  content: { type: 'text', content: text },
  timestamp: new Date(),
  ...(incomplete ? { incomplete: true } : {}),
});

describe('incompleteTail', () => {
  describe('isChatLockedByIncompleteTail', () => {
    it('returns false for an empty chat', () => {
      expect(isChatLockedByIncompleteTail([])).toBe(false);
    });

    it('returns false when last message is a complete assistant message', () => {
      const messages = [mkMsg('user', 'hi'), mkMsg('assistant', 'hello')];
      expect(isChatLockedByIncompleteTail(messages)).toBe(false);
    });

    it('returns false when last message is a user message (even if assistant earlier was incomplete)', () => {
      const messages = [
        mkMsg('user', 'hi'),
        mkMsg('assistant', 'partial', true),
        mkMsg('user', 'follow up'),
      ];
      // Note: this case shouldn't happen in practice because the lock would
      // have prevented the user message from being added — but the predicate
      // just looks at the tail.
      expect(isChatLockedByIncompleteTail(messages)).toBe(false);
    });

    it('returns true when last message is an incomplete assistant message', () => {
      const messages = [mkMsg('user', 'hi'), mkMsg('assistant', 'partial', true)];
      expect(isChatLockedByIncompleteTail(messages)).toBe(true);
    });
  });

  describe('assertChatNotLockedByIncompleteTail', () => {
    it('does not throw on a healthy chat', () => {
      const messages = [mkMsg('user', 'hi'), mkMsg('assistant', 'hello')];
      expect(() => assertChatNotLockedByIncompleteTail(messages)).not.toThrow();
    });

    it('throws ChatIncompleteTailError when last message is incomplete', () => {
      const messages = [mkMsg('user', 'hi'), mkMsg('assistant', 'partial', true)];
      expect(() => assertChatNotLockedByIncompleteTail(messages)).toThrow(ChatIncompleteTailError);
    });

    it('thrown error carries the CHAT_INCOMPLETE_TAIL code', () => {
      const messages = [mkMsg('assistant', 'partial', true)];
      try {
        assertChatNotLockedByIncompleteTail(messages);
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ChatIncompleteTailError);
        expect((err as ChatIncompleteTailError).code).toBe(CHAT_INCOMPLETE_TAIL_ERROR_CODE);
        expect((err as ChatIncompleteTailError).code).toBe('CHAT_INCOMPLETE_TAIL');
      }
    });
  });
});
