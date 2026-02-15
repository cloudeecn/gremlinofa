/**
 * Checkpoint Tool
 *
 * Marks a progress point during long agentic loops. When the AI calls this tool,
 * a checkpoint flag is set. After the current turn ends naturally (end_turn/max_tokens),
 * the system auto-sends a continue message, starting a fresh API call where old
 * thinking blocks get trimmed by thinkingKeepTurns. The checkpoint note stays
 * visible in conversation history as a breadcrumb.
 */

import type { ClientSideTool, ToolResult, ToolStreamEvent } from '../../types';

export const checkpointTool: ClientSideTool = {
  name: 'checkpoint',
  displayName: 'Checkpoint',
  displaySubtitle: 'Auto-continue after turn ends to trim accumulated thinking',
  internal: false,

  description:
    'Mark a progress checkpoint. Use this only when system or user tells you the condition.',

  inputSchema: {
    type: 'object',
    properties: {
      note: {
        type: 'string',
        description: 'Your note to your future self.',
      },
    },
    required: ['note'],
  },

  optionDefinitions: [
    {
      type: 'longtext',
      id: 'continueMessage',
      label: 'Continue Message',
      subtitle: 'Message sent after checkpoint to resume the loop',
      default: 'please continue',
    },
  ],

  iconInput: '📍',
  iconOutput: '✅',

  // eslint-disable-next-line require-yield -- Simple tool: no streaming events
  execute: async function* (input): AsyncGenerator<ToolStreamEvent, ToolResult, void> {
    const note = (input.note as string) ?? '';
    return {
      content: note
        ? `Checkpoint saved: ${note}\nPlease stop and wait for instruction to continue.`
        : `Checkpoint saved. Please stop and wait for instruction to continue.`,
      checkpoint: true,
    };
  },

  renderInput: input => (input.note as string) ?? '',
  renderOutput: output => output,
};
