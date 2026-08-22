/**
 * When a claude-agent send must branch into a new SDK session.
 *
 * The rule is `isRewind && protectedIds.includes(anchorSessionId)`: fork
 * exactly when a rewind would truncate a session file another record also
 * resumes through. Everything else — every plain continuation, and every
 * rollback inside a session nobody else reads — continues in place, so a
 * session id changes exactly when the *chat lineage* branches.
 *
 * ## Why this shape
 *
 * The provider offers two separate options, and we used to conflate them:
 * `resumeSessionAt` truncates ("only resume messages up to and including this
 * UUID"), `forkSession` renames ("fork to a new session ID rather than
 * continuing the previous session"). Setting both on every rewound send used
 * the branch primitive to obtain truncation, which churned the session id on
 * every rollback — invalidating the `claudeAgentSessionId` stamp on every
 * surviving message, and making the send-time resolver's mtime scan
 * load-bearing for ordinary operation rather than a legacy repair.
 *
 * Worse, the churn was destructive: the old id was then garbage-collected.
 * That was justified by a **single-chat** invariant — a fork copies history up
 * to the anchor and the rollback deleted everything after it, so every
 * surviving uuid lives in the surviving file. Cloning a minion chat breaks it
 * outright: the clone keeps messages the source's fork truncated away, so
 * either side's GC silently destroys the other's context, with no error, just
 * a resolver that quietly downgrades to an earlier anchor. GC is gone, and
 * `claudeAgentProtectedSessionIds` now gates mutation instead of deletion —
 * one field, meaning "sessions this record may resume but must never rewind".
 *
 * ## Why both halves of the predicate are load-bearing
 *
 * - Without the sharing check, every ordinary rollback forks (the old
 *   shortcut).
 * - Without the rewind check, a minion continuing after a clone forks on every
 *   turn, since its own session sits in its own protect list. That fork is
 *   pointless: appending leaves the clone's anchor intact, and only a rewind
 *   can truncate it away.
 *
 * The predicate has to be the protect list, not
 * `anchor.sessionId !== row.claudeAgentSessionId`: a clone that has not sent
 * yet has those equal and would append straight into the minion's file.
 */

/**
 * True when this send must branch into a new SDK session instead of
 * continuing the one on the row.
 *
 * `claudeAgentResumeAt` is the rewind signal — a rollback, an edit or a minion
 * retry wrote it via `rewindPatchFromAnchor`, or `cloneMinionChat` seeded it on
 * a fresh clone. The tip anchor the client synthesizes for a plain continuation
 * never reaches here, which is the whole reason this decision is made engine-
 * side and passed down as a flag: at the call site `resumeSessionAt` is always
 * set, so anchor presence can no longer distinguish a rewind from a
 * continuation.
 *
 * The row's session id is the anchor's owner without a lookup:
 * `rewindPatchFromAnchor` writes `claudeAgentSessionId` and
 * `claudeAgentResumeAt` from the same message stamp.
 */
export function shouldForkSession(row: {
  claudeAgentSessionId?: string;
  claudeAgentResumeAt?: string;
  claudeAgentProtectedSessionIds?: string[];
}): boolean {
  if (!row.claudeAgentResumeAt || !row.claudeAgentSessionId) return false;
  return !!row.claudeAgentProtectedSessionIds?.includes(row.claudeAgentSessionId);
}
