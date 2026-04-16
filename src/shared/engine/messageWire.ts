/**
 * Backend → frontend message envelope shaping.
 *
 * Phase 1.8 leak fix: the frontend used to call `extractToolUseBlocks`
 * (which dispatches on `apiType` against the provider-specific
 * `fullContent` shape) on every render to detect unresolved tool calls.
 * That gave the React render path a hard dependency on the API client
 * shapes, leaking provider knowledge into `useChat`.
 *
 * The fix is to pre-extract `toolUseBlocks` backend-side at every point a
 * message crosses the protocol boundary. The frontend then reads
 * `message.content.toolUseBlocks ?? message.content.toolCalls ?? []`
 * with no awareness of provider shapes.
 *
 * `toolUseBlocks` is computed fresh on every yield and never persisted —
 * `prepareMessageForWire` returns a shallow copy with the field added so
 * the storage row format is unchanged. The persisted column for
 * assistant messages still carries `fullContent` (the raw provider
 * payload) and `toolCalls` (the cross-model reconstruction the agentic
 * loop already builds), so a future format change in `extractToolUseBlocks`
 * doesn't require a backfill.
 */

import { extractToolUseBlocks } from './lib/apiHelpers';
import type { Message, ToolUseBlock } from '../protocol/types';

/**
 * Return a shallow copy of `message` with `content.toolUseBlocks` populated
 * from the provider-specific `fullContent`. Returns the original reference
 * (no copy) when there's nothing to extract — keeps the no-op path cheap.
 *
 * Idempotent: if `content.toolUseBlocks` is already populated, the message
 * is returned unchanged.
 */
export function prepareMessageForWire<T>(message: Message<T>): Message<T> {
  if (message.content.toolUseBlocks) return message;

  const apiType = message.content.modelFamily;
  const fullContent = message.content.fullContent;
  if (!apiType || fullContent == null) return message;

  let blocks: ToolUseBlock[];
  try {
    blocks = extractToolUseBlocks(apiType, fullContent);
  } catch {
    // Provider shape didn't parse — fall back to whatever the persisted
    // `toolCalls` field carries (the frontend's `?? toolCalls` path
    // covers this case). Logging here would be noise; the frontend
    // already handles missing tool blocks gracefully.
    return message;
  }
  if (blocks.length === 0) return message;

  return {
    ...message,
    content: { ...message.content, toolUseBlocks: blocks },
  };
}
