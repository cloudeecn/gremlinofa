/**
 * In-memory stand-in for the Claude Agent SDK's session storage, plus a
 * harness that replays our two claude-agent turn dispatchers against it.
 *
 * Deliberately NOT backed by real JSONL files. `resolveResumeTarget`'s
 * filesystem probes — `existsSync`, the `"uuid":"…"` substring match, the
 * mtime-ordered scan — already have real-fixture coverage in
 * `claudeAgentClient.test.ts`. Re-exercising that ladder here would duplicate
 * it, make every scenario pay temp-dir and mtime costs, and give each failure
 * two possible causes. What this module owns is *ownership, fork decisions and
 * reference integrity*; the resolver's precondition is what those produce, so
 * the scenarios assert it directly instead of asking the resolver.
 *
 * ## Modelled SDK behaviours
 *
 * These are assumptions we cannot verify without the real CLI. Stating them is
 * the point: if one is wrong, the fake is wrong in the same direction as
 * production, and this table says where to correct it.
 *
 * | Behaviour | Source |
 * |---|---|
 * | `resumeSessionAt` + `forkSession` mints a NEW session holding history up to and including the anchor; the source file is left untouched | `claudeAgentClient.ts` fork call site, plus the engine GC'ing the source *after* the fork back when it did — which presupposed it survives |
 * | The authoritative session id arrives on `system:init`, differing from the requested one exactly on forks | `claudeAgentClient.ts` init handling; development.md "Claude Agent provider" |
 * | A plain `resume` with no anchor APPENDS to the named session | development.md "Session-per-chat" |
 * | `resumeSessionAt` WITHOUT a fork TRUNCATES the session: everything after the anchor stops existing | Unverified, and deliberately the harsher of the two readings — see below |
 *
 * That last row is the one the "fork on branch, not on rollback" rule
 * introduced, and the only one where we chose a reading rather than inferring
 * it. The alternative — appending a dead branch and leaving the old entries in
 * the file — cannot fail: nothing is ever removed, so dangling references
 * become impossible by construction and the invariant check goes vacuous for
 * precisely the operation under test. Truncating turns "a non-forked rewind can
 * only destroy messages our own rollback already deleted" into a claim these
 * scenarios can falsify — break the fork rule and a clone's anchor vanishes
 * from the store. If the real CLI appends, this model is merely stricter than
 * production.
 */

import type { Chat, Message, MinionChat } from '../../../protocol/types';
import type { UnifiedStorage } from '../../../services/storage/unifiedStorage';
import { generateUniqueId } from '../../../protocol/idGenerator';
import { computeClaudeAgentRewindKeeping } from '../../lib/claudeAgentRewind';
import { shouldForkSession } from '../../lib/claudeAgentSessionSharing';
import { cloneMinionChatToChat } from '../../cloneMinionChat';

/**
 * How the "CLI" arrived at the session it wrote to — the semantic equivalent of
 * `resolveResumeTarget`'s outcome, minus its filesystem probes.
 */
export type ResolveOutcome = 'verified' | 'recovered-by-scan' | 'anchor-downgraded' | 'fresh';

export interface ResolveResult {
  sessionId: string;
  resumeAt?: string;
  outcome: ResolveOutcome;
}

export interface FakeSessionStore {
  /** Pre-create a session holding `uuids`, for scenarios that start mid-history. */
  seed(sessionId: string, uuids: string[]): void;
  /** First turn of a chat: mint a session the caller names. */
  start(sessionId: string): { sessionId: string; uuid: string };
  /**
   * Model `resolveResumeTarget`'s recovery ladder at the semantic level: the
   * stated session when it holds the anchor, else any session that does, else
   * an earlier anchor from `anchorChain` that some session holds, else a fresh
   * session. The fs probes behind each rung are covered by real fixtures in
   * `claudeAgentClient.test.ts`; what matters here is which rung gets reached.
   *
   * @param anchorChain the record's stamped uuids, NEWEST FIRST, starting at
   * the requested anchor — the walk-backwards candidates for a downgrade.
   */
  resolve(statedSessionId: string, resumeAt: string, anchorChain: string[]): ResolveResult;
  /**
   * Continue a session. Three shapes, mirroring the client's option matrix:
   * `resumeAt` + `fork` mints a new id holding history up to and including the
   * anchor and leaves the source untouched; `resumeAt` alone truncates the
   * named session to the anchor and appends there; neither appends at the tip.
   * Returns the id the "CLI" actually wrote to — what `system:init` reports.
   */
  send(
    sessionId: string,
    opts?: { resumeAt?: string; fork?: boolean }
  ): { sessionId: string; uuid: string };
  delete(sessionId: string): void;
  exists(sessionId: string): boolean;
  uuidsIn(sessionId: string): string[];
  /** Any live session holding `uuid` — the scan rung, and the leak-free check. */
  sessionsHolding(uuid: string): string[];
  /** Every session id currently on "disk" — for leak assertions. */
  liveSessions(): string[];
}

export function createFakeSessionStore(): FakeSessionStore {
  const sessions = new Map<string, string[]>();
  let seq = 0;
  const nextUuid = () => `u${++seq}`;
  const nextSession = () => `sess-${++seq}`;

  const holding = (uuid: string) =>
    [...sessions.entries()].filter(([, uuids]) => uuids.includes(uuid)).map(([id]) => id);

  return {
    seed(sessionId, uuids) {
      sessions.set(sessionId, [...uuids]);
    },
    start(sessionId) {
      const uuid = nextUuid();
      sessions.set(sessionId, [uuid]);
      return { sessionId, uuid };
    },
    resolve(statedSessionId, resumeAt, anchorChain) {
      if (sessions.get(statedSessionId)?.includes(resumeAt)) {
        return { sessionId: statedSessionId, resumeAt, outcome: 'verified' };
      }
      const scanned = holding(resumeAt);
      if (scanned.length > 0) {
        return { sessionId: scanned[0], resumeAt, outcome: 'recovered-by-scan' };
      }
      // Walk backwards past the requested anchor. This is the silent context
      // truncation the protect list exists to prevent — it succeeds, but the
      // model loses everything between the downgraded anchor and the real one.
      for (const candidate of anchorChain.slice(1)) {
        const found = holding(candidate);
        if (found.length > 0) {
          return { sessionId: found[0], resumeAt: candidate, outcome: 'anchor-downgraded' };
        }
      }
      return { sessionId: nextSession(), outcome: 'fresh' };
    },
    send(sessionId, opts) {
      const source = sessions.get(sessionId);
      if (!source) {
        const fresh = nextSession();
        const uuid = nextUuid();
        sessions.set(fresh, [uuid]);
        return { sessionId: fresh, uuid };
      }

      if (opts?.resumeAt) {
        const cut = source.indexOf(opts.resumeAt);
        const kept = cut === -1 ? [] : source.slice(0, cut + 1);
        const uuid = nextUuid();
        if (opts.fork) {
          const forked = nextSession();
          sessions.set(forked, [...kept, uuid]);
          return { sessionId: forked, uuid };
        }
        // In place, and destructively: whatever followed the anchor is gone.
        sessions.set(sessionId, [...kept, uuid]);
        return { sessionId, uuid };
      }

      const uuid = nextUuid();
      source.push(uuid);
      return { sessionId, uuid };
    },
    delete(sessionId) {
      sessions.delete(sessionId);
    },
    exists(sessionId) {
      return sessions.has(sessionId);
    },
    uuidsIn(sessionId) {
      return [...(sessions.get(sessionId) ?? [])];
    },
    sessionsHolding: holding,
    liveSessions() {
      return [...sessions.keys()].sort();
    },
  };
}

/** Which record a harness operation targets. */
export type SessionTarget = { kind: 'chat' | 'minion'; id: string };

/**
 * Replays a chat's or minion's claude-agent turn against the fake store,
 * running the real fork predicate, the real rewind arithmetic and the real
 * clone path. Only the surrounding loop is scaffolding; every decision under
 * test is production code.
 */
export class SessionHarness {
  readonly store: FakeSessionStore;
  private readonly storage: UnifiedStorage;

  constructor(store: FakeSessionStore, storage: UnifiedStorage) {
    this.store = store;
    this.storage = storage;
  }

  /** Assert no send has needed the legacy-healing rungs of the resolver. */
  assertNeverScanned(): void {
    const healed = this.outcomes.filter(
      o => o === 'recovered-by-scan' || o === 'anchor-downgraded'
    );
    if (healed.length > 0) {
      throw new Error(
        `resolver fell back to legacy healing (${healed.join(', ')}) in a fully-stamped chat; ` +
          `full outcome sequence: ${this.outcomes.join(' → ')}`
      );
    }
  }

  private async row(target: SessionTarget): Promise<Chat | MinionChat> {
    const record =
      target.kind === 'chat'
        ? await this.storage.getChat(target.id)
        : await this.storage.getMinionChat(target.id);
    if (!record) throw new Error(`harness: ${target.kind} ${target.id} not found`);
    return record;
  }

  private async messages(target: SessionTarget): Promise<Message<unknown>[]> {
    return target.kind === 'chat'
      ? this.storage.getMessages(target.id)
      : this.storage.getMinionMessages(target.id);
  }

  private async saveMessage(target: SessionTarget, msg: Message<unknown>): Promise<void> {
    if (target.kind === 'chat') await this.storage.saveMessage(target.id, msg);
    else await this.storage.saveMinionMessage(target.id, msg);
  }

  private async writeRow(target: SessionTarget, row: Chat | MinionChat): Promise<void> {
    if (target.kind === 'chat') await this.storage.saveChat(row as Chat);
    else await this.storage.saveMinionChat(row as MinionChat);
  }

  /** Outcome of the most recent send that had to resolve an anchor. */
  lastOutcome?: ResolveOutcome;
  /**
   * Every resolve outcome in order. The scan and downgrade rungs exist to heal
   * legacy chats whose messages predate uuid stamping; a fully-stamped chat
   * reaching them means the stamps are lying about where history lives. Tests
   * assert on this rather than trusting that they don't.
   */
  readonly outcomes: ResolveOutcome[] = [];
  /**
   * The engine's fork decision per send, in order — `shouldForkSession`'s
   * answer, not whatever session id came back.
   *
   * Asserting the flag is the point. Every send now carries an anchor, so an
   * implementation that keys `forkSession` off anchor presence restores the old
   * fork-every-rollback behaviour while leaving every session-id assertion
   * intact. Sends before the first session exists record nothing.
   */
  readonly forkFlags: boolean[] = [];
  /** The fork decision of the most recent send that had a session to resume. */
  lastFork?: boolean;

  /**
   * One user turn. Mirrors `ChatRunner`'s and `minionTool`'s
   * `claude_agent_turn` arms: persist the returned id and clear `resumeAt`.
   * Nothing is deleted — an id only changes when the send forked off a session
   * another record shares.
   */
  async send(target: SessionTarget): Promise<{ sessionId: string; uuid: string }> {
    const row = await this.row(target);
    const messages = await this.messages(target);
    const previousSessionId = row.claudeAgentSessionId;
    const resumeAt = row.claudeAgentResumeAt;

    let turn: { sessionId: string; uuid: string };
    if (!previousSessionId) {
      this.lastOutcome = undefined;
      this.lastFork = undefined;
      turn = this.store.start(generateUniqueId('sess'));
    } else {
      // Candidate anchors, newest first: the rollback's anchor for a rewind, or
      // the stored tip for a plain continuation (the client synthesizes one on
      // every send), then the earlier ones for the downgrade rung.
      const chain = messages
        .filter(m => m.role === 'assistant' && m.metadata?.claudeAgentMessageUuid)
        .map(m => m.metadata?.claudeAgentMessageUuid as string)
        .reverse();
      // The client drops a synthesized anchor the stated session doesn't hold,
      // so a plain continuation falls back to the anchorless path it always had.
      const tip = chain[0];
      const statedLives = this.store.exists(previousSessionId);
      // A rewind brings its own anchor. A plain continuation gets the stored
      // tip, but only when the stated session holds it: an anchor the file
      // lacks is dropped so the send takes the anchorless path instead of
      // scanning and repointing. When the file is gone entirely there is
      // nothing to keep, and the tip goes to the recovery ladder exactly as
      // `findRecoverableAnchor` would take it.
      const tipUsable =
        tip !== undefined && (!statedLives || this.store.uuidsIn(previousSessionId).includes(tip));
      const anchor = resumeAt ?? (tipUsable ? tip : undefined);
      const fork = shouldForkSession(row);
      this.forkFlags.push(fork);
      this.lastFork = fork;

      if (!anchor) {
        this.lastOutcome = statedLives ? 'verified' : 'fresh';
        this.outcomes.push(this.lastOutcome);
        turn = this.store.send(previousSessionId);
      } else {
        const from = chain.indexOf(anchor);
        const resolved = this.store.resolve(
          previousSessionId,
          anchor,
          from === -1 ? [anchor, ...chain] : chain.slice(from)
        );
        this.lastOutcome = resolved.outcome;
        this.outcomes.push(resolved.outcome);
        // The client's second fork trigger: a resolver repoint means we are not
        // continuing our own session, so we must not write into it.
        const forkThisTurn =
          fork || (resolved.outcome !== 'fresh' && resolved.sessionId !== previousSessionId);
        turn = resolved.resumeAt
          ? this.store.send(resolved.sessionId, { resumeAt: resolved.resumeAt, fork: forkThisTurn })
          : this.store.start(resolved.sessionId);
      }
    }

    const at = new Date(Date.now() + messages.length * 1000);
    await this.saveMessage(target, {
      id: generateUniqueId('msg'),
      role: 'assistant',
      content: { type: 'text', content: `turn ${turn.uuid}` },
      timestamp: at,
      metadata: { claudeAgentMessageUuid: turn.uuid, claudeAgentSessionId: turn.sessionId },
    });

    row.claudeAgentSessionId = turn.sessionId;
    row.claudeAgentResumeAt = undefined;
    await this.writeRow(target, row);

    return turn;
  }

  /**
   * Roll back so that the message at `keepIndex` is the last surviving one.
   * Uses the real `computeClaudeAgentRewindKeeping`, so the row lands on the
   * anchor's stamped session exactly as the UI would put it there.
   */
  async rollbackTo(target: SessionTarget, keepIndex: number): Promise<void> {
    const row = await this.row(target);
    const messages = await this.messages(target);
    const rewind = computeClaudeAgentRewindKeeping(row, messages, keepIndex);

    // `deleteSingleMessage` is parent-agnostic — same table for both kinds.
    for (const m of messages.slice(keepIndex + 1)) {
      await this.storage.deleteSingleMessage(m.id);
    }

    if ('claudeAgentResumeAt' in rewind) row.claudeAgentResumeAt = rewind.claudeAgentResumeAt;
    if ('claudeAgentSessionId' in rewind) row.claudeAgentSessionId = rewind.claudeAgentSessionId;
    await this.writeRow(target, row);
  }

  /** Clone a minion chat through the real production path. */
  async cloneTo(minionChatId: string): Promise<SessionTarget> {
    const { chat } = await cloneMinionChatToChat(this.storage, minionChatId, {
      // Mirrors `inspectProviderMessage`: stated session first, then scan.
      resolveAnchorSession: async (stated, uuid) => {
        if (stated && this.store.uuidsIn(stated).includes(uuid)) return stated;
        return this.store.sessionsHolding(uuid)[0];
      },
    });
    return { kind: 'chat', id: chat.id };
  }

  /**
   * The invariant, asserted after every step of every scenario. Two tiers,
   * and which one applies is itself the measure of this design.
   *
   * **Resolvable.** Every live message stamp's uuid, and every live row's
   * `claudeAgentResumeAt`, exists in *some* live session — the property
   * development.md leaned on to justify GC: "a fork copies all history up to
   * the anchor and the rollback deleted everything after it, so every surviving
   * message's uuid exists in the surviving file." A claim about the uuid, not
   * the stated session.
   *
   * **Direct.** The *stated* session still exists and still holds the uuid, so
   * resolution returns `verified` and no healing rung is reached. Under the old
   * fork-every-rollback scheme this only held for protected references, because
   * a fork's GC left ordinary stamps naming a deleted file. Nothing is deleted
   * now and a fork never mutates its source, so it holds for **every** live
   * stamp — that is the whole point of the change, so it is asserted rather
   * than argued.
   *
   * @param staleStampsExpected drop to the resolvable tier. Only for scenarios
   * that deliberately seed pre-change history, where a stamp names a session an
   * old fork already collected.
   */
  async assertNoDanglingSessionRefs(
    targets: SessionTarget[],
    { staleStampsExpected = false }: { staleStampsExpected?: boolean } = {}
  ): Promise<void> {
    const problems: string[] = [];

    const checkResolvable = (label: string, uuid: string, statedSessionId: string) => {
      if (this.store.sessionsHolding(uuid).length === 0) {
        problems.push(`${label}: uuid ${uuid} (stamped @${statedSessionId}) is in no live session`);
      }
    };
    const checkDirect = (label: string, uuid: string, statedSessionId: string) => {
      if (staleStampsExpected) return;
      if (!this.store.uuidsIn(statedSessionId).includes(uuid)) {
        problems.push(`${label}: stated session ${statedSessionId} no longer holds ${uuid}`);
      }
    };

    for (const target of targets) {
      const row = await this.row(target);
      const label = `${target.kind}:${target.id}`;

      if (row.claudeAgentSessionId && row.claudeAgentResumeAt) {
        checkResolvable(`${label} row`, row.claudeAgentResumeAt, row.claudeAgentSessionId);
        checkDirect(`${label} row`, row.claudeAgentResumeAt, row.claudeAgentSessionId);
      } else if (row.claudeAgentSessionId && !this.store.exists(row.claudeAgentSessionId)) {
        problems.push(`${label} row points at missing session ${row.claudeAgentSessionId}`);
      }

      for (const msg of await this.messages(target)) {
        const uuid = msg.metadata?.claudeAgentMessageUuid;
        const sessionId = msg.metadata?.claudeAgentSessionId;
        if (!uuid || !sessionId) continue;
        checkResolvable(`${label} message ${msg.id}`, uuid, sessionId);
        checkDirect(`${label} message ${msg.id}`, uuid, sessionId);
      }
    }

    if (problems.length > 0) {
      throw new Error(`claude-agent session invariant violated:\n  ${problems.join('\n  ')}`);
    }
  }
}
