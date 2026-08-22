/**
 * Close a transcript's dangling tool calls with a synthesized tool_result.
 *
 * A minion transcript usually ends mid-turn: the minion called `return`, the
 * loop broke on it, and no result was ever written — because the result *was*
 * the value handed back to the caller. Copied into a regular chat that has no
 * `return` tool, those blocks are unanswered forever, and every provider
 * rejects an assistant turn whose tool calls have no matching results.
 *
 * `return` is not the only case: the minion loop also breaks when `return` is
 * called in parallel with other tools, leaving those siblings equally
 * unresolved. All of them get closed.
 *
 * Pure — no API service, no storage. The block source is the persisted
 * `content.toolCalls`, since `content.toolUseBlocks` is computed-only and
 * `prepareMessageForWire` strips it before storage.
 */

import type {
  APIType,
  Message,
  RenderingBlockGroup,
  ToolResultBlock,
  ToolUseBlock,
} from '../../protocol/types';
import type { ToolResultRenderBlock } from '../../protocol/types/content';
import { generateUniqueId } from '../../protocol/idGenerator';

/**
 * Tool calls at the tail of `messages` that no later message answers.
 *
 * Returns `[]` when the transcript ends cleanly, when the tail assistant is
 * `incomplete`, or when there are no messages. The `incomplete` case is a
 * refusal, not an oversight: an aborted tail is owned by the incomplete-tail
 * lock, and appending a user message would flip `isChatLockedByIncompleteTail`
 * to false, silently unlocking a chat the abort path deliberately locked.
 */
export function unresolvedTailToolUses(messages: Message<unknown>[]): ToolUseBlock[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || last.incomplete === true) return [];

  const blocks = last.content.toolCalls ?? last.content.toolUseBlocks ?? [];
  if (blocks.length === 0) return [];

  // Nothing follows the tail assistant, so every one of its calls is open.
  return [...blocks];
}

/**
 * Build the `role: 'user'` message that answers `blocks`.
 *
 * Model-agnostic by construction: every client reconstructs provider-native
 * blocks from `content.toolResults` when `content.modelFamily` doesn't match
 * its own, so the clone can even switch provider afterwards.
 *
 * `after` is the tail message's timestamp; the closure lands 1ms later. Not
 * `new Date()` — a clone preserves the source's original timestamps and the
 * message query orders by timestamp, so a wall-clock stamp would sort the
 * closure ahead of nothing and behind everything.
 */
export function buildToolResultClosureMessage(
  blocks: ToolUseBlock[],
  modelFamily: APIType | undefined,
  after: Date,
  resultFor: (block: ToolUseBlock) => { content: string; isError?: boolean }
): Message<unknown> {
  const toolResults: ToolResultBlock[] = [];
  const renderBlocks: ToolResultRenderBlock[] = [];

  for (const block of blocks) {
    const { content, isError } = resultFor(block);
    toolResults.push({
      type: 'tool_result',
      tool_use_id: block.id,
      name: block.name,
      content,
      ...(isError ? { is_error: true } : {}),
    });
    renderBlocks.push({
      type: 'tool_result',
      tool_use_id: block.id,
      name: block.name,
      content,
      is_error: isError,
      // No registry: a synthetic result has no tool-specific renderer to run,
      // so the generic icon and passthrough content are the honest rendering.
      icon: isError ? '❌' : '✅',
      renderedContent: content,
    });
  }

  const groups: RenderingBlockGroup[] = [{ category: 'backstage', blocks: renderBlocks }];

  return {
    id: generateUniqueId('msg_user'),
    role: 'user',
    content: {
      type: 'text',
      content: '',
      modelFamily,
      toolResults,
      renderingContent: groups,
    },
    timestamp: new Date(after.getTime() + 1),
  };
}
