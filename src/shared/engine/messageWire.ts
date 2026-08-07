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
 * The same boundary also backfills `renderingContent` for legacy non-user
 * messages persisted before the field existed: a single text group derived
 * from `content.content` (the pure display text), so old chats render
 * their text instead of crashing the assistant bubble.
 *
 * Both fields are computed fresh on every yield and never persisted —
 * `prepareMessageForWire` returns a shallow copy with the fields added so
 * the storage row format is unchanged. The persisted column for
 * assistant messages still carries `fullContent` (the raw provider
 * payload) and `toolCalls` (the cross-model reconstruction the agentic
 * loop already builds), so a future format change in `extractToolUseBlocks`
 * doesn't require a backfill.
 */

import { extractToolUseBlocks } from './lib/apiHelpers';
import type { Message, MessageContent, ToolUseBlock } from '../protocol/types';

function extractWireToolUseBlocks<T>(content: MessageContent<T>): ToolUseBlock[] | undefined {
  if (content.toolUseBlocks) return undefined;

  const apiType = content.modelFamily;
  const fullContent = content.fullContent;
  if (!apiType || fullContent == null) return undefined;

  let blocks: ToolUseBlock[];
  try {
    blocks = extractToolUseBlocks(apiType, fullContent);
  } catch {
    // Provider shape didn't parse — fall back to whatever the persisted
    // `toolCalls` field carries (the frontend's `?? toolCalls` path
    // covers this case). Logging here would be noise; the frontend
    // already handles missing tool blocks gracefully.
    return undefined;
  }
  return blocks.length > 0 ? blocks : undefined;
}

/**
 * Return a shallow copy of `message` with wire-only fields populated:
 * `content.toolUseBlocks` from the provider-specific `fullContent`, and a
 * text-group `content.renderingContent` for legacy non-user messages that
 * predate the field. User messages are excluded from the backfill —
 * `UserMessageBubble` has its own `stripMetadata(content.content)`
 * fallback and a raw backfill would bypass the stripping.
 *
 * Returns the original reference (no copy) when there's nothing to add —
 * keeps the no-op path cheap. Idempotent: already-populated fields are
 * left unchanged.
 */
export function prepareMessageForWire<T>(message: Message<T>): Message<T> {
  const patch: Partial<MessageContent<T>> = {};

  const toolUseBlocks = extractWireToolUseBlocks(message.content);
  if (toolUseBlocks) patch.toolUseBlocks = toolUseBlocks;

  if (message.role !== 'user' && !message.content.renderingContent && message.content.content) {
    patch.renderingContent = [
      { category: 'text', blocks: [{ type: 'text', text: message.content.content }] },
    ];
  }

  if (Object.keys(patch).length === 0) return message;

  return {
    ...message,
    content: { ...message.content, ...patch },
  };
}
