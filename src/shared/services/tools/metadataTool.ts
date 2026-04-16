/**
 * Metadata Tool
 *
 * Gives the LLM control over chat-level metadata: title, summary,
 * and the ability to list recent chats in the current project.
 */

import type {
  ClientSideTool,
  ToolContext,
  ToolOptions,
  ToolResult,
  ToolStreamEvent,
} from '../../protocol/types';

const MAX_TITLE_LENGTH = 200;
const DEFAULT_LIST_COUNT = 10;
const MAX_LIST_COUNT = 50;

const dateFormatOptions: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  timeZoneName: 'short',
};

function formatDate(
  date: Date,
  mode: 'utc' | 'local' | 'relative' | 'disabled' | undefined
): string | null {
  switch (mode) {
    case 'utc':
      return new Intl.DateTimeFormat('en-US', { ...dateFormatOptions, timeZone: 'UTC' }).format(
        date
      );
    case 'local':
      return new Intl.DateTimeFormat('en-US', dateFormatOptions).format(date);
    case 'relative': {
      const diffMs = Date.now() - date.getTime();
      const absDiff = Math.abs(diffMs);
      const minutes = Math.floor(absDiff / 60_000);
      if (minutes < 1) return 'just now';
      if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
      const days = Math.floor(hours / 24);
      return `${days} day${days !== 1 ? 's' : ''} ago`;
    }
    case 'disabled':
    case undefined:
      return null;
  }
}

// eslint-disable-next-line require-yield -- Simple tool: no streaming events
async function* executeMetadata(
  input: Record<string, unknown>,
  _toolOptions?: ToolOptions,
  context?: ToolContext
): AsyncGenerator<ToolStreamEvent, ToolResult, void> {
  const command = input.command as string;

  switch (command) {
    case 'update_chat_metadata': {
      const rawTitle = input.title as string | undefined;
      const rawSummary = input.summary as string | undefined;

      if (rawTitle === undefined && rawSummary === undefined) {
        return { content: 'Error: at least one of title or summary is required.', isError: true };
      }

      const chatMetadata: { name?: string; summary?: string } = {};
      const updates: string[] = [];

      if (rawTitle !== undefined) {
        const title = rawTitle.trim();
        if (!title) {
          return { content: 'Error: title cannot be empty.', isError: true };
        }
        chatMetadata.name = title.slice(0, MAX_TITLE_LENGTH);
        updates.push(`title → "${chatMetadata.name}"`);
      }

      if (rawSummary !== undefined) {
        const summary = rawSummary.trim();
        chatMetadata.summary = summary;
        updates.push(summary ? `summary → "${summary}"` : 'summary cleared');
      }

      return {
        content: `Chat metadata updated: ${updates.join(', ')}`,
        chatMetadata,
      };
    }

    case 'list_recent_chats': {
      if (!context?.projectId) {
        return { content: 'Error: projectId is required.', isError: true };
      }
      const rawCount = (input.count as number | undefined) ?? DEFAULT_LIST_COUNT;
      const count = Math.max(1, Math.min(MAX_LIST_COUNT, Math.floor(rawCount)));

      const [chats, project] = await Promise.all([
        context.storage.getChats(context.projectId),
        context.storage.getProject(context.projectId),
      ]);
      const recent = chats.slice(0, count);

      if (recent.length === 0) {
        return { content: 'No chats in this project.' };
      }

      const timestampMode = project?.metadataTimestampMode;
      const lines = recent.map(chat => {
        const parts = [`- ${chat.name}`];
        if (chat.summary) parts.push(`  Summary: ${chat.summary}`);
        const formatted = formatDate(chat.lastModifiedAt, timestampMode);
        if (formatted) parts.push(`  Last modified: ${formatted}`);
        return parts.join('\n');
      });

      return { content: `Recent chats (${recent.length}):\n${lines.join('\n')}` };
    }

    default:
      return { content: `Unknown command: ${command}`, isError: true };
  }
}

function renderMetadataInput(input: Record<string, unknown>): string {
  const command = input.command as string;
  switch (command) {
    case 'update_chat_metadata': {
      const parts: string[] = [];
      if (input.title !== undefined) parts.push(`title="${input.title}"`);
      if (input.summary !== undefined) {
        const summary = input.summary as string;
        if (summary) {
          parts.push(`summary="${summary.length > 80 ? summary.slice(0, 80) + '…' : summary}"`);
        } else {
          parts.push('summary=(clear)');
        }
      }
      return `update_chat_metadata: ${parts.join(', ')}`;
    }
    case 'list_recent_chats':
      return `list_recent_chats (${(input.count as number) ?? DEFAULT_LIST_COUNT})`;
    default:
      return command ?? 'metadata';
  }
}

export const metadataTool: ClientSideTool = {
  name: 'metadata',
  displayName: 'Metadata',
  displaySubtitle: 'Set chat title/summary, list recent chats',

  description:
    'Manage chat metadata. Commands: update_chat_metadata (set title and/or summary for the current chat — only provided fields are updated, empty string clears the field), list_recent_chats (list titles and summaries of recent chats in this project).',

  iconInput: '🏷️',

  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        enum: ['update_chat_metadata', 'list_recent_chats'],
        description: 'The metadata command to execute',
      },
      title: {
        type: 'string',
        description: 'New chat title (for update_chat_metadata, cannot be empty)',
      },
      summary: {
        type: 'string',
        description: 'Chat summary text (for update_chat_metadata, empty string to clear)',
      },
      count: {
        type: 'number',
        description: 'Number of recent chats to list (for list_recent_chats, default 10, max 50)',
      },
    },
    required: ['command'],
  },

  renderInput: renderMetadataInput,

  execute: executeMetadata,
};
