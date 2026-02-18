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
      type: 'number',
      id: 'keepSegments',
      label: 'Keep Segments',
      subtitle: 'Previous checkpoint segments to preserve (-1 = keep all, 0 = tidy all)',
      default: 0,
      min: -1,
    },
    {
      type: 'longtext',
      id: 'continueMessage',
      label: 'Continue Message',
      subtitle: 'Message sent after checkpoint to resume the loop',
      default: 'please continue',
    },
    {
      type: 'boolean',
      id: 'tidyFilesystem',
      label: 'Tidy Filesystem',
      subtitle: 'Remove filesystem tool blocks before checkpoint',
      default: true,
    },
    {
      type: 'boolean',
      id: 'tidyMemory',
      label: 'Tidy Memory',
      subtitle: 'Remove memory tool blocks before checkpoint',
      default: true,
    },
    {
      type: 'boolean',
      id: 'tidyJavascript',
      label: 'Tidy JavaScript',
      subtitle: 'Remove JavaScript tool blocks before checkpoint',
      default: true,
    },
    {
      type: 'boolean',
      id: 'tidyMinion',
      label: 'Tidy Minion',
      subtitle: 'Remove minion tool blocks before checkpoint',
      default: true,
    },
    {
      type: 'boolean',
      id: 'tidySketchbook',
      label: 'Tidy Sketchbook',
      subtitle: 'Remove sketchbook tool blocks before checkpoint',
      default: true,
    },
    {
      type: 'boolean',
      id: 'tidyCheckpoint',
      label: 'Tidy Checkpoint',
      subtitle: 'Remove checkpoint tool blocks before checkpoint',
      default: true,
    },
  ],

  iconInput: '📍',
  iconOutput: '✅',

  // eslint-disable-next-line require-yield -- Simple tool: no streaming events
  execute: async function* (_input): AsyncGenerator<ToolStreamEvent, ToolResult, void> {
    return {
      content: 'Checkpoint saved. Please stop. User will call you back to continue.',
      checkpoint: true,
    };
  },

  renderInput: input => (input.note as string) ?? '',
  renderOutput: output => output,
};
