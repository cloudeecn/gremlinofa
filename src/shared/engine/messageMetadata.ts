/**
 * Server-side helpers for assembling user messages with metadata.
 *
 * Extracted from `useChat.ts`. PR 9 introduces this module so the backend's
 * `ChatRunner` can synthesize user messages without depending on React.
 * PR 10 will switch `useChat.ts` to import from here, deleting the
 * duplicate.
 *
 * Behavior is identical to the React-side helpers — three modes:
 *
 *   - `false / undefined` → return the message text unchanged
 *   - `'template'` → render the project's Mustache template
 *   - `true` → wrap the message in an XML metadata block whose contents
 *     depend on the per-project metadata flags
 */

import Mustache from 'mustache';
import type { Chat, Project } from '../protocol/types';

/** Format current timestamp in the local timezone. */
export function formatTimestampLocal(): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    timeZoneName: 'short',
  }).format(new Date());
}

/** Format current timestamp in UTC. */
export function formatTimestampUtc(): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    timeZoneName: 'short',
    timeZone: 'UTC',
  }).format(new Date());
}

/** Format the elapsed time since the chat started, in seconds. */
export function formatTimestampRelative(firstMessageTimestamp?: Date): string {
  const now = new Date();
  const chatStart = firstMessageTimestamp ?? now;
  const secondsSinceChatStart = Math.floor((now.getTime() - chatStart.getTime()) / 1000);
  return `${secondsSinceChatStart} seconds since chat start`;
}

/**
 * Generate message content based on the project's metadata mode. Returns
 * the formatted text. Behavior matches `useChat.ts`'s helper of the same
 * name verbatim.
 */
export function generateMessageWithMetadata(
  messageText: string,
  project: Project,
  chat: Chat,
  modelId: string,
  firstMessageTimestamp?: Date
): string {
  // Mode: disabled - return plain message
  if (!project.sendMessageMetadata) {
    return messageText;
  }

  // Mode: template - use Mustache rendering
  if (project.sendMessageMetadata === 'template') {
    const template = project.metadataTemplate || '{{userMessage}}';
    const view = {
      userMessage: messageText,
      timestamp: formatTimestampLocal(),
      timestampUtc: formatTimestampUtc(),
      timestampRelative: formatTimestampRelative(firstMessageTimestamp),
      modelName: modelId,
      contextWindowUsage: chat.contextWindowUsage ? `${chat.contextWindowUsage} tokens` : '',
      currentCost: chat.totalCost !== undefined ? `$${chat.totalCost.toFixed(3)}` : '',
      hasContextWindowUsage: !!chat.contextWindowUsage,
      hasCurrentCost: chat.totalCost !== undefined && chat.totalCost > 0,
    };
    return Mustache.render(template, view);
  }

  // Mode: true (metadata XML format)
  const metadataParts: string[] = [];

  if (project.metadataTimestampMode && project.metadataTimestampMode !== 'disabled') {
    if (project.metadataTimestampMode === 'relative') {
      metadataParts.push(
        `<timestamp>${formatTimestampRelative(firstMessageTimestamp)}</timestamp>`
      );
    } else if (project.metadataTimestampMode === 'utc') {
      metadataParts.push(`<timestamp>${formatTimestampUtc()}</timestamp>`);
    } else {
      metadataParts.push(`<timestamp>${formatTimestampLocal()}</timestamp>`);
    }
  }

  if (project.metadataIncludeModelName && modelId) {
    metadataParts.push(`<model>${modelId}</model>`);
  }

  if (project.metadataIncludeContextWindow && chat.contextWindowUsage) {
    metadataParts.push(
      `<context_window_usage>${chat.contextWindowUsage} tokens</context_window_usage>`
    );
  }

  if (project.metadataIncludeCost && chat.totalCost !== undefined) {
    metadataParts.push(`<current_cost>$${chat.totalCost.toFixed(3)}</current_cost>`);
  }

  if (metadataParts.length === 0) {
    return messageText;
  }

  return `<metadata>\n${metadataParts.join('\n')}\n</metadata>\n\n${messageText}`;
}
