import { describe, expect, it } from 'vitest';
import { ProtocolError } from '../../../shared/protocol/protocolError';
import { describeLoopStartError } from '../loopStartError';

describe('describeLoopStartError', () => {
  it('explains CHAT_BUSY', () => {
    expect(describeLoopStartError(new ProtocolError('CHAT_BUSY', 'chat c1 is busy'))).toMatch(
      /already has a reply running/
    );
  });

  it('explains CHAT_INCOMPLETE_TAIL', () => {
    expect(describeLoopStartError(new ProtocolError('CHAT_INCOMPLETE_TAIL', 'locked'))).toMatch(
      /was aborted/
    );
  });

  it('falls back to the error message', () => {
    expect(describeLoopStartError(new Error('Model not found: m1'))).toBe('Model not found: m1');
    expect(describeLoopStartError('socket closed')).toBe('socket closed');
  });
});
