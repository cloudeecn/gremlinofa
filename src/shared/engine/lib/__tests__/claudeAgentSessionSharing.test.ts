import { describe, it, expect } from 'vitest';
import { shouldForkSession } from '../claudeAgentSessionSharing';

/** The truth table, read as (rewind, shared) → fork. */
describe('shouldForkSession', () => {
  it('does not fork a plain continuation — no rewind, nothing to truncate', () => {
    expect(shouldForkSession({ claudeAgentSessionId: 'sess-a' })).toBe(false);
  });

  it('does not fork a plain continuation even in a shared session', () => {
    // A minion whose transcript was cloned keeps appending to its own file;
    // appending leaves the clone's anchor intact.
    expect(
      shouldForkSession({
        claudeAgentSessionId: 'sess-a',
        claudeAgentProtectedSessionIds: ['sess-a'],
      })
    ).toBe(false);
  });

  it('does not fork a rollback in an uncloned chat', () => {
    expect(
      shouldForkSession({ claudeAgentSessionId: 'sess-a', claudeAgentResumeAt: 'uuid-1' })
    ).toBe(false);
  });

  it('does not fork a rollback when the protect list is empty', () => {
    expect(
      shouldForkSession({
        claudeAgentSessionId: 'sess-a',
        claudeAgentResumeAt: 'uuid-1',
        claudeAgentProtectedSessionIds: [],
      })
    ).toBe(false);
  });

  it('forks a rewind into a shared session', () => {
    // The clone's first send, and any rollback onto a copied message.
    expect(
      shouldForkSession({
        claudeAgentSessionId: 'sess-a',
        claudeAgentResumeAt: 'uuid-1',
        claudeAgentProtectedSessionIds: ['sess-a'],
      })
    ).toBe(true);
  });

  it('forks on any member of a multi-lineage list', () => {
    // A clone-of-a-clone carries one entry per ancestor lineage.
    expect(
      shouldForkSession({
        claudeAgentSessionId: 'sess-b',
        claudeAgentResumeAt: 'uuid-1',
        claudeAgentProtectedSessionIds: ['sess-a', 'sess-b'],
      })
    ).toBe(true);
  });

  it("does not fork a rewind into the record's own later session", () => {
    // Only inherited ids are protected, so a clone rolling back onto one of
    // its own turns rewinds in place — and the over-forking a shared ancestor
    // causes is self-limiting for the same reason.
    expect(
      shouldForkSession({
        claudeAgentSessionId: 'sess-c',
        claudeAgentResumeAt: 'uuid-1',
        claudeAgentProtectedSessionIds: ['sess-a', 'sess-b'],
      })
    ).toBe(false);
  });

  it('does not fork a legacy rewind with no stamped session', () => {
    // Pre-stamp messages rewind `resumeAt` alone. The client sees no session to
    // resume, treats the send as a first turn and drops the anchor entirely —
    // there is nothing to fork from.
    expect(
      shouldForkSession({
        claudeAgentResumeAt: 'uuid-1',
        claudeAgentProtectedSessionIds: ['sess-a'],
      })
    ).toBe(false);
  });
});
