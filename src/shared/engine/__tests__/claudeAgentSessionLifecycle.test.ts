/**
 * Claude-agent session lifecycle: clone, rollback and fork, end to end.
 *
 * Every hazard this feature's design uncovered was found by hand-tracing, not
 * by a test — the rules are stateful and span three files. So the SDK's
 * session semantics are modelled (see `helpers/fakeClaudeAgentSessions.ts`)
 * and the real code is driven through every clone/rollback ordering against
 * them.
 *
 * The baseline group exists to prove what the "fork on branch, not on
 * rollback" rule promises for chats that were never cloned: one session for
 * the life of the chat, whatever the user does to it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { UnifiedStorage } from '../../services/storage/unifiedStorage';
import type { EncryptionCore } from '../../services/encryption/encryptionCore';
import type { Chat, MinionChat } from '../../protocol/types';
import {
  createMockAdapter,
  createMockEncryptionService,
  createTestProject,
} from '../../services/storage/__tests__/testUtils';
import {
  createFakeSessionStore,
  SessionHarness,
  type FakeSessionStore,
  type SessionTarget,
} from './helpers/fakeClaudeAgentSessions';

let storage: UnifiedStorage;
let store: FakeSessionStore;
let harness: SessionHarness;
let seq = 0;

beforeEach(async () => {
  storage = new UnifiedStorage(
    createMockAdapter(),
    createMockEncryptionService() as unknown as EncryptionCore
  );
  store = createFakeSessionStore();
  harness = new SessionHarness(store, storage);
  seq = 0;
  await storage.saveProject(createTestProject({ enabledTools: ['memory'] }));
});

async function makeChat(): Promise<SessionTarget> {
  const chat: Chat = {
    id: `chat-${++seq}`,
    projectId: 'test-project-1',
    name: 'Chat',
    apiDefinitionId: null,
    modelId: null,
    createdAt: new Date(),
    lastModifiedAt: new Date(),
  };
  await storage.saveChat(chat);
  return { kind: 'chat', id: chat.id };
}

async function makeMinion(): Promise<SessionTarget> {
  const minion: MinionChat = {
    id: `minion-${++seq}`,
    parentChatId: 'parent-chat',
    projectId: 'test-project-1',
    createdAt: new Date(),
    lastModifiedAt: new Date(),
    apiDefinitionId: 'test-api-def-1',
    modelId: 'test-model',
  };
  await storage.saveMinionChat(minion);
  return { kind: 'minion', id: minion.id };
}

const rowOf = async (t: SessionTarget) =>
  t.kind === 'chat' ? await storage.getChat(t.id) : await storage.getMinionChat(t.id);

const messagesOf = async (t: SessionTarget) =>
  t.kind === 'chat' ? await storage.getMessages(t.id) : await storage.getMinionMessages(t.id);

// ============================================================================
// Baseline — one session per lineage, whatever the user does
// ============================================================================

/**
 * The resolver's rungs, and who each one is for.
 *
 * `verified` is the only rung any chat reaches under this rule. Session ids
 * change exactly when a lineage branches, so no stamp ever goes stale and
 * nothing needs healing — which is why `assertNeverScanned()` is asserted
 * almost everywhere here rather than in a few chosen places.
 *
 * `recovered-by-scan` and `anchor-downgraded` are left standing for the two
 * genuinely legacy customers: messages written before assistant turns stamped
 * their owning session (scenario 16), and pre-change lineages whose own forks
 * collected the session their surviving stamps still name (15b). Those two
 * scenarios are the only exceptions, and both say so.
 */
describe('baseline (no protect list)', () => {
  it('1. N plain sends stay on one session with no forks', async () => {
    const chat = await makeChat();
    const first = await harness.send(chat);
    await harness.send(chat);
    await harness.send(chat);

    expect(store.liveSessions()).toEqual([first.sessionId]);
    expect(store.uuidsIn(first.sessionId)).toHaveLength(3);
    // Every continuation carries the stored tip as its anchor, so each send
    // past the first resolves — and resolves directly.
    expect(harness.outcomes).toEqual(['verified', 'verified']);
    expect(harness.forkFlags).toEqual([false, false]);
    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([chat]);
  });

  it('2. a rollback rewinds in place: same session, no fork, nothing deleted', async () => {
    // The inversion this change is about. The rewound send used to fork purely
    // to obtain truncation and then delete what it forked from; `resumeSessionAt`
    // does the truncation on its own, so the id survives and so does the file.
    const chat = await makeChat();
    const first = await harness.send(chat);
    await harness.send(chat);
    await harness.send(chat);

    await harness.rollbackTo(chat, 0);
    await harness.send(chat);

    expect(store.liveSessions()).toEqual([first.sessionId]);
    expect((await rowOf(chat))?.claudeAgentSessionId).toBe(first.sessionId);
    expect(store.uuidsIn(first.sessionId)).toHaveLength(2);
    expect(harness.lastFork).toBe(false);
    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([chat]);
  });

  it('3. repeated rollbacks to the same message never need a healing rung', async () => {
    // Six steps — send, send, rollback, send, rollback, send — used to be all
    // it took for an ordinary chat to reach the scan: the first fork collected
    // the session the surviving message still named, so the second rollback
    // repointed the row at a dead id. Nothing churns now, so nothing lies.
    const chat = await makeChat();
    const first = await harness.send(chat);
    await harness.send(chat);

    await harness.rollbackTo(chat, 0);
    await harness.send(chat);
    await harness.rollbackTo(chat, 0);
    await harness.send(chat);

    expect(store.liveSessions()).toEqual([first.sessionId]);
    expect(harness.outcomes.every(o => o === 'verified')).toBe(true);
    expect(harness.forkFlags.every(f => f === false)).toBe(true);
    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([chat]);
  });

  it('4. however many rollbacks pile up, the chat keeps one session', async () => {
    const chat = await makeChat();
    const first = await harness.send(chat);
    await harness.send(chat);
    await harness.send(chat);

    for (let i = 0; i < 4; i++) {
      await harness.rollbackTo(chat, 0);
      await harness.send(chat);
      expect(harness.lastOutcome).toBe('verified');
      expect(harness.lastFork).toBe(false);
      expect(store.liveSessions()).toEqual([first.sessionId]);
      await harness.assertNoDanglingSessionRefs([chat]);
    }
    harness.assertNeverScanned();
  });

  it('5. a first turn with no prior session resolves nothing and forks nothing', async () => {
    const chat = await makeChat();
    await harness.send(chat);
    expect(store.liveSessions()).toHaveLength(1);
    expect(harness.outcomes).toEqual([]);
    expect(harness.forkFlags).toEqual([]);
    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([chat]);
  });
});

// ============================================================================
// Clone scenarios
// ============================================================================

describe('clone scenarios', () => {
  /** A minion with two stamped assistant turns on one session. */
  async function seededMinion(): Promise<{ minion: SessionTarget; sessionId: string }> {
    const minion = await makeMinion();
    const first = await harness.send(minion);
    await harness.send(minion);
    return { minion, sessionId: first.sessionId };
  }

  it('6. the clone forks off the shared ancestor and the ancestor SURVIVES', async () => {
    const { minion, sessionId } = await seededMinion();
    const clone = await harness.cloneTo(minion.id);

    await harness.send(clone);

    // The flag itself, not just the resulting id: every send now carries an
    // anchor, so an implementation that forks whenever one is present would
    // pass every id-shaped assertion while restoring the old behaviour.
    expect(harness.lastFork).toBe(true);
    expect(store.exists(sessionId)).toBe(true);
    expect((await rowOf(clone))?.claudeAgentSessionId).not.toBe(sessionId);
    // The minion can still resume its own session.
    expect((await rowOf(minion))?.claudeAgentSessionId).toBe(sessionId);
    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([minion, clone]);
  });

  it('6b. the clone stops forking once it is in its own session', async () => {
    const { minion } = await seededMinion();
    const clone = await harness.cloneTo(minion.id);

    await harness.send(clone);
    const own = (await rowOf(clone))?.claudeAgentSessionId;
    await harness.send(clone);
    await harness.send(clone);

    expect(harness.forkFlags.filter(Boolean)).toHaveLength(1);
    expect((await rowOf(clone))?.claudeAgentSessionId).toBe(own);
    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([minion, clone]);
  });

  it('7. the minion rolling back AFTER the clone has sent leaves both lineages intact', async () => {
    const { minion, sessionId } = await seededMinion();
    const clone = await harness.cloneTo(minion.id);
    await harness.send(clone);

    await harness.rollbackTo(minion, 0);
    await harness.send(minion);

    // The minion's own session is in its own protect list now, so its first
    // rollback after the clone forks — whether or not it actually crosses the
    // clone point. Over-forking costs a file; under-forking costs the clone
    // its context.
    expect(harness.lastFork).toBe(true);
    expect(store.exists(sessionId)).toBe(true);
    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([minion, clone]);
  });

  it('7b. the minion CONTINUING after a clone does not fork', async () => {
    // The second half of the predicate. Without the rewind check the minion
    // would fork on every turn from here on, since its own session is
    // protected — pointlessly, because an append leaves the clone's anchor
    // exactly where it was.
    const { minion, sessionId } = await seededMinion();
    const clone = await harness.cloneTo(minion.id);

    await harness.send(minion);
    await harness.send(minion);

    expect(harness.forkFlags.filter(Boolean)).toEqual([]);
    expect((await rowOf(minion))?.claudeAgentSessionId).toBe(sessionId);
    expect(store.liveSessions()).toEqual([sessionId]);
    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([minion, clone]);
  });

  it('8. the minion rolling back BEFORE the clone’s first send leaves the clone’s anchor intact', async () => {
    // The ordering case the design was rewritten for. Without the fork the
    // minion's rewind truncates A past the clone's anchor, and
    // `findRecoverableAnchor` walks backwards — the clone silently resumes with
    // the middle of its own visible transcript missing from the model's context.
    const { minion, sessionId } = await seededMinion();
    const clone = await harness.cloneTo(minion.id);
    const cloneAnchor = (await rowOf(clone))?.claudeAgentResumeAt;
    expect(cloneAnchor).toBeDefined();

    await harness.rollbackTo(minion, 0);
    await harness.send(minion);

    expect(harness.lastFork).toBe(true);
    expect(store.exists(sessionId)).toBe(true);
    expect(store.uuidsIn(sessionId)).toContain(cloneAnchor);
    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([minion, clone]);

    // And the clone's own first send still forks from a complete history.
    await harness.send(clone);
    expect(harness.lastFork).toBe(true);
    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([minion, clone]);
  });

  it('9. rolling the clone back to a COPIED message re-forks the protected ancestor', async () => {
    const { minion, sessionId } = await seededMinion();
    const clone = await harness.cloneTo(minion.id);
    await harness.send(clone); // forks A -> B
    const ownSession = (await rowOf(clone))?.claudeAgentSessionId as string;
    expect(ownSession).not.toBe(sessionId);

    // Index 0 is a copied message, still stamped @A — the rewind repoints the
    // row back onto the shared ancestor, and rewinding there has to branch.
    await harness.rollbackTo(clone, 0);
    expect((await rowOf(clone))?.claudeAgentSessionId).toBe(sessionId);

    await harness.send(clone);
    expect(harness.lastFork).toBe(true);
    expect(harness.lastOutcome).toBe('verified');
    expect(store.exists(sessionId)).toBe(true);
    // B is abandoned, not deleted — nothing deletes any more. This is the
    // accepted cost of the rule: one extra file per rollback onto a shared-era
    // message, bounded by how often the user rolls back.
    expect(store.exists(ownSession)).toBe(true);
    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([minion, clone]);
  });

  it('9b. rolling the clone back onto its OWN turn rewinds in place', async () => {
    // Only inherited ids are protected, so within the clone's own lineage the
    // rule collapses back to the baseline: rewind, no fork, no new file.
    const { minion, sessionId } = await seededMinion();
    const clone = await harness.cloneTo(minion.id);
    await harness.send(clone); // forks A -> B
    const ownSession = (await rowOf(clone))?.claudeAgentSessionId as string;
    await harness.send(clone); // appends to B

    // Roll back onto a message the clone itself produced, stamped @B.
    const messages = await messagesOf(clone);
    const ownIndex = messages.findIndex(m => m.metadata?.claudeAgentSessionId === ownSession);
    await harness.rollbackTo(clone, ownIndex);
    await harness.send(clone);

    expect(harness.lastFork).toBe(false);
    expect((await rowOf(clone))?.claudeAgentSessionId).toBe(ownSession);
    expect(store.exists(ownSession)).toBe(true);
    expect(store.exists(sessionId)).toBe(true);
    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([minion, clone]);
  });

  it('9d. rolling the clone back BEFORE it has ever sent still forks', async () => {
    // The expected workflow for this feature: run a minion, clone the
    // transcript, then immediately trim it back to the turn you actually want
    // to continue from. The clone has never sent, so its row still names the
    // minion's own session and the rollback only moves the anchor earlier
    // within it — which is precisely the case the protect-list predicate
    // exists for, and the one a `row.sessionId !== anchor.sessionId` check
    // would get wrong.
    const { minion, sessionId } = await seededMinion();
    const clone = await harness.cloneTo(minion.id);
    const inheritedAnchor = (await rowOf(clone))?.claudeAgentResumeAt;

    await harness.rollbackTo(clone, 0);
    const row = await rowOf(clone);
    expect(row?.claudeAgentSessionId).toBe(sessionId);
    expect(row?.claudeAgentResumeAt).not.toBe(inheritedAnchor);

    await harness.send(clone);
    expect(harness.lastFork).toBe(true);
    expect(harness.lastOutcome).toBe('verified');

    // The clone continues from the earlier turn, without the one it trimmed.
    const own = (await rowOf(clone))?.claudeAgentSessionId as string;
    expect(own).not.toBe(sessionId);
    expect(store.uuidsIn(own)).not.toContain(inheritedAnchor);
    // The minion's session is untouched, trimmed turn included.
    expect(store.uuidsIn(sessionId)).toContain(inheritedAnchor);
    expect((await rowOf(minion))?.claudeAgentSessionId).toBe(sessionId);
    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([minion, clone]);
  });

  it('9e. and the minion can keep going afterwards, unaffected', async () => {
    const { minion, sessionId } = await seededMinion();
    const clone = await harness.cloneTo(minion.id);
    await harness.rollbackTo(clone, 0);
    await harness.send(clone);

    await harness.send(minion);
    expect(harness.lastFork).toBe(false);
    expect((await rowOf(minion))?.claudeAgentSessionId).toBe(sessionId);
    expect(store.uuidsIn(sessionId)).toHaveLength(3);
    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([minion, clone]);
  });

  it('9c. a minion rollback onto a post-fork message does not fork again', async () => {
    // Why over-forking in scenario 7 is self-limiting: the session that fork
    // minted is nobody else's, so the next rewind into it rewinds in place.
    const { minion, sessionId } = await seededMinion();
    const clone = await harness.cloneTo(minion.id);
    const cloneAnchor = (await rowOf(clone))?.claudeAgentResumeAt;

    await harness.rollbackTo(minion, 0);
    await harness.send(minion); // forks A -> A'
    const forked = (await rowOf(minion))?.claudeAgentSessionId as string;
    expect(forked).not.toBe(sessionId);

    const messages = await messagesOf(minion);
    await harness.rollbackTo(minion, messages.length - 1);
    await harness.send(minion);

    expect(harness.lastFork).toBe(false);
    expect((await rowOf(minion))?.claudeAgentSessionId).toBe(forked);
    expect(store.uuidsIn(sessionId)).toContain(cloneAnchor);
    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([minion, clone]);
  });

  it('10. after all that, every surviving stamp still resolves directly', async () => {
    const { minion } = await seededMinion();
    const clone = await harness.cloneTo(minion.id);
    await harness.send(clone);
    await harness.send(clone);
    await harness.rollbackTo(clone, 1);
    await harness.send(clone);

    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([minion, clone]);
  });

  it('11. cloning the same minion twice accumulates both live ancestors', async () => {
    // The real multi-lineage case, and why the protect field is a list rather
    // than a boolean: the minion forks past its first protected session, so a
    // later clone spans two ancestors that must BOTH stay unmutated.
    const { minion, sessionId: ancestorA } = await seededMinion();
    const firstClone = await harness.cloneTo(minion.id);

    await harness.rollbackTo(minion, 0);
    await harness.send(minion); // forks A -> B; A survives untouched
    const ancestorB = (await rowOf(minion))?.claudeAgentSessionId as string;
    expect(ancestorB).not.toBe(ancestorA);
    expect(store.exists(ancestorA)).toBe(true);

    const secondClone = await harness.cloneTo(minion.id);
    expect(new Set((await rowOf(secondClone))?.claudeAgentProtectedSessionIds)).toEqual(
      new Set([ancestorA, ancestorB])
    );
    expect(new Set((await rowOf(minion))?.claudeAgentProtectedSessionIds)).toEqual(
      new Set([ancestorA, ancestorB])
    );

    await harness.send(secondClone);
    expect(harness.lastFork).toBe(true);
    await harness.send(minion);
    expect(harness.lastFork).toBe(false);
    expect(store.exists(ancestorA)).toBe(true);
    expect(store.exists(ancestorB)).toBe(true);
    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([minion, firstClone, secondClone]);
  });

  it('12. interleaved rollbacks and sends on both sides keep every reference live', async () => {
    const { minion } = await seededMinion();
    const clone = await harness.cloneTo(minion.id);

    for (let round = 0; round < 4; round++) {
      await harness.send(minion);
      harness.assertNeverScanned();
      await harness.assertNoDanglingSessionRefs([minion, clone]);
      await harness.send(clone);
      harness.assertNeverScanned();
      await harness.assertNoDanglingSessionRefs([minion, clone]);
      await harness.rollbackTo(minion, 0);
      harness.assertNeverScanned();
      await harness.assertNoDanglingSessionRefs([minion, clone]);
      await harness.rollbackTo(clone, 0);
      harness.assertNeverScanned();
      await harness.assertNoDanglingSessionRefs([minion, clone]);
    }
  });
});

// ============================================================================
// Degrade paths
// ============================================================================

describe('degrade paths', () => {
  it('13. a transcript with no stamped assistant clones with no ids and a note', async () => {
    const minion = await makeMinion();
    await storage.saveMinionMessage(minion.id, {
      id: 'legacy-1',
      role: 'assistant',
      content: { type: 'text', content: 'no stamp' },
      timestamp: new Date(),
    });

    const clone = await harness.cloneTo(minion.id);
    const row = await rowOf(clone);
    expect(row?.claudeAgentSessionId).toBeUndefined();
    expect(row?.claudeAgentProtectedSessionIds).toBeUndefined();
    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([minion, clone]);
  });

  it('14. cloning needs no claude-agent client, so worker mode does not throw', async () => {
    // Nothing in the clone path talks to the provider; the degrade is that the
    // carried session is simply unusable until the chat runs server-side.
    const minion = await makeMinion();
    await harness.send(minion);
    await expect(harness.cloneTo(minion.id)).resolves.toBeDefined();
  });

  it('15. a source session removed outright leaves nothing to resolve', async () => {
    // Artificial now that nothing deletes: the file vanished without a fork
    // copying its uuids forward, so no live session holds the anchor and the
    // stamp is all there is.
    const minion = await makeMinion();
    const first = await harness.send(minion);
    store.delete(first.sessionId);

    const clone = await harness.cloneTo(minion.id);
    const row = await rowOf(clone);
    expect(row?.claudeAgentSessionId).toBe(first.sessionId);
    // Protecting a session that is already gone achieves nothing, but it costs
    // nothing either and there is no better answer available. 15b is the case
    // that DOES have one.
    expect(row?.claudeAgentProtectedSessionIds).toContain(first.sessionId);
  });

  it('15b. pre-change history: a stamp its own fork orphaned heals by scan, once', async () => {
    // EXCEPTION to `assertNeverScanned` — deliberately, and the only realistic
    // one. Under the old rule a rollback forked A into B and then deleted A,
    // leaving surviving messages stamped @A. The current code cannot produce
    // that state, so it is seeded directly: this is what an existing chat looks
    // like on the day this change ships.
    const minion = await makeMinion();
    store.seed('sess-B', ['u-old', 'u-new']);
    for (const [id, uuid] of [
      ['pre-1', 'u-old'],
      ['pre-2', 'u-new'],
    ]) {
      await storage.saveMinionMessage(minion.id, {
        id,
        role: 'assistant',
        content: { type: 'text', content: id },
        timestamp: new Date(Date.now() + (id === 'pre-1' ? 0 : 1000)),
        metadata: { claudeAgentMessageUuid: uuid, claudeAgentSessionId: 'sess-A' },
      });
    }
    const row = (await rowOf(minion)) as MinionChat;
    row.claudeAgentSessionId = 'sess-A';
    await storage.saveMinionChat(row);

    // Cloning resolves the anchor to its real holder rather than the stamp —
    // `resolveAnchorSession` earning its keep as the legacy safety net.
    const clone = await harness.cloneTo(minion.id);
    expect((await rowOf(clone))?.claudeAgentSessionId).toBe('sess-B');
    expect((await rowOf(clone))?.claudeAgentProtectedSessionIds).toEqual(['sess-B']);

    // The minion's own row still names the tombstone, so its next send has to
    // scan — and the repoint forces a fork, because a session found by search
    // is not one we may append to.
    await harness.send(minion);
    expect(harness.lastOutcome).toBe('recovered-by-scan');
    const healed = (await rowOf(minion))?.claudeAgentSessionId as string;
    expect(healed).not.toBe('sess-A');
    expect(healed).not.toBe('sess-B');

    // Healed once, never again.
    await harness.send(minion);
    expect(harness.lastOutcome).toBe('verified');
    await harness.send(minion);
    expect(harness.lastOutcome).toBe('verified');
    await harness.assertNoDanglingSessionRefs([minion, clone], { staleStampsExpected: true });
  });
});

// ============================================================================
// The healing rungs and who they are for
// ============================================================================

describe('the healing rungs and who they are for', () => {
  it('16. a legacy message with no session stamp is what the scan is actually for', async () => {
    // The case the scan was built for: a message written before assistant
    // turns stamped their owning session. There is no stamp to trust, so the
    // uuid has to be located by search — and a clone should land on whichever
    // session really holds it, not on whatever the row happens to name.
    const minion = await makeMinion();
    const live = await harness.send(minion); // gives the row a real session
    store.seed('sess-legacy', ['legacy-u']);

    await storage.saveMinionMessage(minion.id, {
      id: 'legacy-msg',
      role: 'assistant',
      content: { type: 'text', content: 'from before stamping' },
      timestamp: new Date(Date.now() + 60_000), // tail
      metadata: { claudeAgentMessageUuid: 'legacy-u' }, // uuid only, no session
    });

    const clone = await harness.cloneTo(minion.id);
    const row = await rowOf(clone);

    expect(row?.claudeAgentResumeAt).toBe('legacy-u');
    expect(row?.claudeAgentSessionId).toBe('sess-legacy');
    expect(row?.claudeAgentSessionId).not.toBe(live.sessionId);
    expect(row?.claudeAgentProtectedSessionIds).toEqual(['sess-legacy']);

    // The search happened at clone time, so the clone's own sends never need
    // the rung: its row names the holder outright.
    await harness.send(clone);
    expect(harness.lastOutcome).toBe('verified');
    expect(harness.lastFork).toBe(true);
    harness.assertNeverScanned();
    await harness.assertNoDanglingSessionRefs([minion, clone]);
  });

  it('17. an unresolvable anchor falls through to the row, not to a wrong session', async () => {
    // No live session holds the uuid: the resolver has nothing to offer, so the
    // stamp/row stands and the send-time ladder owns the recovery.
    const minion = await makeMinion();
    const live = await harness.send(minion);
    await storage.saveMinionMessage(minion.id, {
      id: 'orphan-msg',
      role: 'assistant',
      content: { type: 'text', content: 'orphan' },
      timestamp: new Date(Date.now() + 60_000),
      metadata: { claudeAgentMessageUuid: 'nowhere-u' },
    });

    const clone = await harness.cloneTo(minion.id);
    expect((await rowOf(clone))?.claudeAgentSessionId).toBe(live.sessionId);
    expect((await rowOf(clone))?.claudeAgentResumeAt).toBe('nowhere-u');
  });
});

// ============================================================================
// Randomized invariant sweep
// ============================================================================

describe('randomized sweep', () => {
  /** Deterministic PRNG so a failure reproduces from its seed alone. */
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  const SEEDS = [1, 7, 42, 99, 123, 2024, 31337, 65535, 777, 8675309];

  it.each(SEEDS)('19. holds the invariant across a random script (seed %i)', async seed => {
    const rand = rng(seed);
    const minion = await makeMinion();
    await harness.send(minion);

    const targets: SessionTarget[] = [minion];
    const clonable = [minion.id];

    for (let step = 0; step < 20; step++) {
      const target = targets[Math.floor(rand() * targets.length)];
      const roll = rand();

      if (roll < 0.5) {
        await harness.send(target);
      } else if (roll < 0.8) {
        const count =
          target.kind === 'chat'
            ? (await storage.getMessages(target.id)).length
            : (await storage.getMinionMessages(target.id)).length;
        if (count > 1) await harness.rollbackTo(target, Math.floor(rand() * (count - 1)));
      } else if (targets.length < 4) {
        const source = clonable[Math.floor(rand() * clonable.length)];
        targets.push(await harness.cloneTo(source));
      }

      await harness.assertNoDanglingSessionRefs(targets);
      // No script of ordinary operations should ever need a healing rung.
      harness.assertNeverScanned();
    }
  });
});
