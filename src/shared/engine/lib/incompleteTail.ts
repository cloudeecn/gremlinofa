/**
 * Incomplete-tail lock for hard-aborted chats.
 *
 * When the agentic loop is hard-aborted mid-stream, it synthesizes a
 * display-only partial assistant message marked `incomplete: true` so the
 * user can still see what the model produced. The chat is then locked from
 * continuation: no new sends, resends, retries, or auto-resume can run until
 * the user resolves the tail (delete the incomplete message, or roll back to
 * an earlier checkpoint).
 *
 * Every loop-start path on the backend must call
 * `assertChatNotLockedByIncompleteTail()` first. The frontend reads the
 * predicate from the same module so the boundary lint stays clean
 * (frontend code can import from `src/lib/**` but not `src/services/**`).
 */

import type { Message } from '../../protocol/types';

export const CHAT_INCOMPLETE_TAIL_ERROR_CODE = 'CHAT_INCOMPLETE_TAIL';

/**
 * Error thrown by `assertChatNotLockedByIncompleteTail` when the last
 * message is an incomplete (aborted) assistant message. Carries a stable
 * `code` so backend RPC handlers can map it to the protocol-level
 * `CHAT_INCOMPLETE_TAIL` error envelope without string-matching.
 */
export class ChatIncompleteTailError extends Error {
  readonly code = CHAT_INCOMPLETE_TAIL_ERROR_CODE;
  constructor(
    message = 'The last assistant message was aborted. Resolve the incomplete tail before continuing.'
  ) {
    super(message);
    this.name = 'ChatIncompleteTailError';
  }
}

/**
 * Returns true iff the chat's last message is a partial assistant message
 * synthesized by the abort path. Cheap predicate version — useful for
 * frontend hooks that want to derive a boolean for `disabled` state without
 * paying the cost of catching an exception.
 */
export function isChatLockedByIncompleteTail(messages: Message<unknown>[]): boolean {
  if (messages.length === 0) return false;
  const last = messages[messages.length - 1];
  return last.role === 'assistant' && last.incomplete === true;
}

/**
 * Throws `ChatIncompleteTailError` if the chat's last message is an
 * incomplete assistant message. Every loop-start path must call this before
 * mutating chat state.
 */
export function assertChatNotLockedByIncompleteTail(messages: Message<unknown>[]): void {
  if (isChatLockedByIncompleteTail(messages)) {
    throw new ChatIncompleteTailError();
  }
}
