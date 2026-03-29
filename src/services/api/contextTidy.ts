/**
 * Context Tidy — shared utilities for message pruning.
 *
 * Provides boundary detection and model-agnostic message filtering.
 * Each API client owns its own `tidyMessages()` function that uses
 * these helpers for the pieces that are provider-independent.
 *
 * Operates on copies — stored messages are never mutated.
 */

import type { Message, ToolUseBlock, ToolResultBlock } from '../../types';

/** Scan newest→oldest for a message with the given ID. Returns -1 if not found. */
export function findCheckpointIndex(
  messages: Message<unknown>[],
  checkpointMessageId: string | undefined
): number {
  if (!checkpointMessageId) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].id === checkpointMessageId) return i;
  }
  return -1;
}

/** Find the last user message that is plain text (not tool results). Returns -1 if none. */
export function findThinkingBoundary(messages: Message<unknown>[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && !messages[i].content.toolResults?.length) return i;
  }
  return -1;
}

/**
 * Model-agnostic message tidy for messages from a different provider.
 *
 * In checkpoint mode (isCheckpointMessage=false, but within checkpoint range):
 * filters toolCalls by tidyToolNames, toolResults by removedToolUseIds.
 *
 * Always drops messages with no text content and no remaining tool blocks.
 *
 * @returns null if the message should be dropped, otherwise the (possibly filtered) message
 *          and any tool_use IDs that were removed.
 */
export function tidyAgnosticMessage(
  msg: Message<unknown>,
  tidyToolNames: Set<string>,
  removedToolUseIds: Set<string>,
  isCheckpointMessage: boolean
): { message: Message<unknown> | null; newRemovedIds: string[] } {
  if (isCheckpointMessage) return { message: msg, newRemovedIds: [] };

  const toolCalls = msg.content.toolCalls as ToolUseBlock[] | undefined;
  const toolResults = msg.content.toolResults as ToolResultBlock[] | undefined;

  if (!toolCalls?.length && !toolResults?.length) {
    const hasText = msg.content.content.trim().length > 0;
    return { message: hasText ? msg : null, newRemovedIds: [] };
  }

  const newRemovedIds: string[] = [];

  // Filter assistant toolCalls by tidyToolNames, collect removed IDs
  let keptToolCalls: ToolUseBlock[] | undefined;
  if (toolCalls?.length) {
    keptToolCalls = [];
    for (const tc of toolCalls) {
      if (tidyToolNames.has(tc.name)) {
        removedToolUseIds.add(tc.id);
        newRemovedIds.push(tc.id);
      } else {
        keptToolCalls.push(tc);
      }
    }
    if (keptToolCalls.length === 0) keptToolCalls = undefined;
  }

  // Filter user toolResults by removedToolUseIds
  let keptToolResults: ToolResultBlock[] | undefined;
  if (toolResults?.length) {
    keptToolResults = toolResults.filter(tr => !removedToolUseIds.has(tr.tool_use_id));
    if (keptToolResults.length === 0) keptToolResults = undefined;
  }

  const hasText = msg.content.content.trim().length > 0;
  const hasRemainingTools = (keptToolCalls?.length ?? 0) + (keptToolResults?.length ?? 0) > 0;
  if (!hasText && !hasRemainingTools) return { message: null, newRemovedIds };

  return {
    message: {
      ...msg,
      content: { ...msg.content, toolCalls: keptToolCalls, toolResults: keptToolResults },
    },
    newRemovedIds,
  };
}
