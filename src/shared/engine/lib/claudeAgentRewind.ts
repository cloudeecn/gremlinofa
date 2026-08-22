/**
 * claude-agent SDK rewind arithmetic, shared by the parent chat and the minion.
 *
 * Rollback for claude-agent is metadata, not message surgery: every assistant
 * message stamps the SDK uuid it produced and the session that owned it, and a
 * rewind repoints the chat/minion row at one of those stamps. The next send
 * passes the pair as `resume` + `resumeSessionAt`, which forks the session.
 *
 * Both sides answer the same question — "which stamp should the next send
 * resume from, and does the session move with it?" — and they used to answer
 * it in two places (`useChat.ts` for chats, `minionTool.ts` for minions, whose
 * comments described themselves as mirroring the other). The scan and the
 * patch live here now so the dual-mode boundary cannot hold two dialects of
 * one rule.
 */

export interface ClaudeAgentStampedMessage {
  role: string;
  metadata?: {
    claudeAgentMessageUuid?: string;
    claudeAgentSessionId?: string;
  };
}

/** An assistant turn the SDK can be resumed to. */
export interface ClaudeAgentRewindAnchor {
  uuid: string;
  /** Owning session, absent on messages written before the stamp existed. */
  sessionId?: string;
}

/**
 * The session/resume fields a rewind writes. `undefined` means "clear" — both
 * call sites route clears through an `unset` list, because the JSON wire drops
 * undefined-valued fields and a `{ x: undefined }` overlay would be a no-op.
 */
export interface ClaudeAgentRewindPatch {
  claudeAgentResumeAt?: string;
  claudeAgentSessionId?: string;
}

/**
 * Walk backwards from `index` (inclusive) for the most recent assistant
 * message carrying an SDK uuid, skipping user turns and unstamped legacy
 * assistants. Returns undefined when the history holds none.
 */
export function findAssistantAnchorAtOrBefore(
  messages: ClaudeAgentStampedMessage[],
  index: number
): ClaudeAgentRewindAnchor | undefined {
  for (let i = Math.min(index, messages.length - 1); i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.metadata?.claudeAgentMessageUuid) {
      return {
        uuid: m.metadata.claudeAgentMessageUuid,
        sessionId: m.metadata.claudeAgentSessionId,
      };
    }
  }
  return undefined;
}

/**
 * Turn an anchor into the row patch.
 *
 * The anchor's stamped session wins when it has one: the anchor may predate a
 * session drop or fork, in which case the row's current session file doesn't
 * contain the uuid at all. Unstamped legacy anchors keep whatever session the
 * row already names and lean on the client's send-time fallback.
 *
 * No anchor means no resumable state, so both fields clear and the next send
 * opens a fresh session with the stored transcript as its only context.
 */
export function rewindPatchFromAnchor(
  anchor: ClaudeAgentRewindAnchor | undefined
): ClaudeAgentRewindPatch {
  if (!anchor) {
    return { claudeAgentSessionId: undefined, claudeAgentResumeAt: undefined };
  }
  return {
    claudeAgentResumeAt: anchor.uuid,
    ...(anchor.sessionId ? { claudeAgentSessionId: anchor.sessionId } : {}),
  };
}

/**
 * Compute the rewind for deleting messages from `cutoffIndex` onward — editing
 * a user message at `cutoffIndex` removes it and everything after, so the next
 * send resumes up to and including the last assistant strictly before it.
 *
 * Returns `{}` for chats with no SDK session — nothing to plumb.
 */
export function computeClaudeAgentRewindBefore(
  chat: { claudeAgentSessionId?: string },
  messages: ClaudeAgentStampedMessage[],
  cutoffIndex: number
): ClaudeAgentRewindPatch {
  if (!chat.claudeAgentSessionId) return {};
  const anchor = findAssistantAnchorAtOrBefore(messages, cutoffIndex - 1);
  if (anchor) {
    console.debug(
      '[claudeAgentRewind] rewind before %d: resumeAt=%s sessionId=%s',
      cutoffIndex,
      anchor.uuid,
      anchor.sessionId ?? '(unstamped)'
    );
  } else {
    console.debug('[claudeAgentRewind] rewind before %d: no prior assistant', cutoffIndex);
  }
  return rewindPatchFromAnchor(anchor);
}

/**
 * Variant for rollback-on-assistant: the message at `targetIndex` is kept and
 * everything after it discarded, so the SDK resumes up to and including it.
 *
 * When the target isn't a stamped assistant, falls back to the "rewind to
 * before" semantics so the session lands on a sane boundary rather than
 * staying stuck on stale state.
 */
export function computeClaudeAgentRewindKeeping(
  chat: { claudeAgentSessionId?: string },
  messages: ClaudeAgentStampedMessage[],
  targetIndex: number
): ClaudeAgentRewindPatch {
  if (!chat.claudeAgentSessionId) return {};
  const target = messages[targetIndex];
  if (target?.role === 'assistant' && target.metadata?.claudeAgentMessageUuid) {
    console.debug(
      '[claudeAgentRewind] rollback keeping %d: resumeAt=%s sessionId=%s',
      targetIndex,
      target.metadata.claudeAgentMessageUuid,
      target.metadata.claudeAgentSessionId ?? '(unstamped)'
    );
    return rewindPatchFromAnchor({
      uuid: target.metadata.claudeAgentMessageUuid,
      sessionId: target.metadata.claudeAgentSessionId,
    });
  }
  return computeClaudeAgentRewindBefore(chat, messages, targetIndex + 1);
}
