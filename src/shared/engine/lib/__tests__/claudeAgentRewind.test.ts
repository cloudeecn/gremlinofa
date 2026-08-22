import { describe, it, expect } from 'vitest';
import {
  computeClaudeAgentRewindBefore,
  computeClaudeAgentRewindKeeping,
  findAssistantAnchorAtOrBefore,
  rewindPatchFromAnchor,
  type ClaudeAgentStampedMessage,
} from '../claudeAgentRewind';

type Chat = { claudeAgentSessionId?: string };
type Message<T> = ClaudeAgentStampedMessage & { id: string; _t?: T };

describe('claude-agent rewind helpers', () => {
  const agentChat = { claudeAgentSessionId: 'sess-cur' } as unknown as Chat;
  const asst = (id: string, uuid?: string, sessionId?: string): Message<unknown> =>
    ({
      id,
      role: 'assistant',
      ...(uuid
        ? {
            metadata: {
              claudeAgentMessageUuid: uuid,
              ...(sessionId ? { claudeAgentSessionId: sessionId } : {}),
            },
          }
        : {}),
    }) as unknown as Message<unknown>;
  const user = (id: string): Message<unknown> =>
    ({ id, role: 'user' }) as unknown as Message<unknown>;

  describe('computeClaudeAgentRewindBefore', () => {
    it('returns {} for non-claude-agent chats', () => {
      expect(computeClaudeAgentRewindBefore({} as Chat, [asst('m0', 'u0')], 1)).toEqual({});
    });

    it('anchors to the prior assistant, keeping the session for unstamped anchors', () => {
      const messages = [asst('m0', 'uuid-0'), user('m1')];
      expect(computeClaudeAgentRewindBefore(agentChat, messages, 1)).toEqual({
        claudeAgentResumeAt: 'uuid-0',
      });
    });

    it('repoints the session to the anchor stamp when present', () => {
      const messages = [asst('m0', 'uuid-0', 'sess-old'), user('m1')];
      expect(computeClaudeAgentRewindBefore(agentChat, messages, 1)).toEqual({
        claudeAgentResumeAt: 'uuid-0',
        claudeAgentSessionId: 'sess-old',
      });
    });

    it('drops the session when no prior assistant carries a uuid', () => {
      expect(computeClaudeAgentRewindBefore(agentChat, [user('m0'), user('m1')], 1)).toEqual({
        claudeAgentSessionId: undefined,
        claudeAgentResumeAt: undefined,
      });
    });
  });

  describe('computeClaudeAgentRewindKeeping', () => {
    it('anchors to the kept assistant and repoints to its stamp', () => {
      const messages = [user('m0'), asst('m1', 'uuid-1', 'sess-old'), user('m2')];
      expect(computeClaudeAgentRewindKeeping(agentChat, messages, 1)).toEqual({
        claudeAgentResumeAt: 'uuid-1',
        claudeAgentSessionId: 'sess-old',
      });
    });

    it('falls back to rewind-before semantics when the target has no uuid', () => {
      const messages = [asst('m0', 'uuid-0', 'sess-old'), asst('m1'), user('m2')];
      expect(computeClaudeAgentRewindKeeping(agentChat, messages, 1)).toEqual({
        claudeAgentResumeAt: 'uuid-0',
        claudeAgentSessionId: 'sess-old',
      });
    });
  });
});

describe('findAssistantAnchorAtOrBefore', () => {
  const asst = (id: string, uuid?: string, sessionId?: string): ClaudeAgentStampedMessage =>
    ({
      id,
      role: 'assistant',
      ...(uuid
        ? {
            metadata: {
              claudeAgentMessageUuid: uuid,
              ...(sessionId ? { claudeAgentSessionId: sessionId } : {}),
            },
          }
        : {}),
    }) as ClaudeAgentStampedMessage;

  it('skips unstamped assistants and user turns', () => {
    const messages = [
      asst('m0', 'u0', 's0'),
      asst('m1'),
      { id: 'm2', role: 'user' } as ClaudeAgentStampedMessage,
    ];
    expect(findAssistantAnchorAtOrBefore(messages, 2)).toEqual({ uuid: 'u0', sessionId: 's0' });
  });

  it('clamps an index past the end rather than reading undefined', () => {
    expect(findAssistantAnchorAtOrBefore([asst('m0', 'u0')], 99)).toEqual({
      uuid: 'u0',
      sessionId: undefined,
    });
  });

  it('returns undefined for an empty history or a negative index', () => {
    expect(findAssistantAnchorAtOrBefore([], 0)).toBeUndefined();
    expect(findAssistantAnchorAtOrBefore([asst('m0', 'u0')], -1)).toBeUndefined();
  });
});

describe('rewindPatchFromAnchor', () => {
  it('omits the session for an unstamped anchor so the row keeps its own', () => {
    expect(rewindPatchFromAnchor({ uuid: 'u1' })).toEqual({ claudeAgentResumeAt: 'u1' });
  });

  it('clears both fields when there is no anchor', () => {
    expect(rewindPatchFromAnchor(undefined)).toEqual({
      claudeAgentSessionId: undefined,
      claudeAgentResumeAt: undefined,
    });
  });
});
