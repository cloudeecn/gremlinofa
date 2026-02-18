/**
 * Context Tidy — selective message trimming for checkpoint-based context management.
 *
 * When a checkpoint exists, messages older than the checkpoint get their thinking blocks
 * removed and (optionally) tool_use/tool_result blocks stripped. Reduces context window
 * usage without losing the conversation flow.
 *
 * Operates on copies — stored messages are never mutated.
 */

import type { APIType, Message } from '../../types';

/**
 * Provider-specific block filter callback.
 *
 * Receives the raw fullContent (array for most providers, object for OpenAI completions).
 * Returns filtered content and any tool IDs that were removed.
 *
 * Return `null` for filtered to signal the message should be dropped entirely.
 */
export type FilterBlocksFn = (
  fullContent: unknown,
  removedToolNames: Set<string>,
  isCheckpointMessage: boolean,
  removedToolUseIds: Set<string>
) => { filtered: unknown | null; newRemovedIds: string[] };

/**
 * Apply context tidy to a message array.
 *
 * Finds the checkpoint message, then processes all messages at or before it:
 * - Thinking/reasoning blocks always removed
 * - Tool blocks removed per tidyToolNames configuration
 * - Messages with null/empty fullContent after filtering are dropped
 *
 * The checkpoint message itself only gets thinking blocks removed.
 * Messages newer than checkpoint are untouched.
 *
 * @param messages - Full message array (will not be mutated)
 * @param checkpointMessageId - ID of the checkpoint assistant message
 * @param tidyToolNames - Tool names whose blocks should be removed
 * @param modelFamily - API type to match (skip messages from other providers)
 * @param filterBlocks - Provider-specific block filter callback
 * @returns New message array with context tidy applied
 */
export function applyContextTidy(
  messages: Message<unknown>[],
  checkpointMessageId: string | undefined,
  tidyToolNames: Set<string> | undefined,
  modelFamily: APIType,
  filterBlocks: FilterBlocksFn
): Message<unknown>[] {
  if (!checkpointMessageId) return messages;

  // Find the checkpoint message (scan newest→oldest)
  let checkpointIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].id === checkpointMessageId) {
      checkpointIdx = i;
      break;
    }
  }

  if (checkpointIdx === -1) return messages;

  const toolNames = tidyToolNames ?? new Set<string>();
  const removedToolUseIds = new Set<string>();
  const result: Message<unknown>[] = [];

  // Process messages oldest→newest so assistant tool_use IDs are collected
  // before filtering the subsequent user tool_result message
  for (let i = 0; i <= checkpointIdx; i++) {
    const msg = messages[i];
    const isCheckpoint = i === checkpointIdx;

    // Skip messages with mismatched modelFamily or missing fullContent
    if (msg.content.modelFamily !== modelFamily || msg.content.fullContent == null) {
      result.push(msg);
      continue;
    }

    const { filtered, newRemovedIds } = filterBlocks(
      msg.content.fullContent,
      toolNames,
      isCheckpoint,
      removedToolUseIds
    );

    // Accumulate removed tool_use IDs for subsequent tool_result matching
    for (const id of newRemovedIds) {
      removedToolUseIds.add(id);
    }

    // Drop messages where fullContent was nullified or emptied
    if (filtered == null) continue;
    if (Array.isArray(filtered) && filtered.length === 0) continue;

    // Shallow copy with filtered fullContent
    result.push({
      ...msg,
      content: {
        ...msg.content,
        fullContent: filtered,
      },
    });
  }

  // Messages after checkpoint are untouched
  for (let i = checkpointIdx + 1; i < messages.length; i++) {
    result.push(messages[i]);
  }

  return result;
}
