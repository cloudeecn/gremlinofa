/**
 * Return Tool
 *
 * Allows agents to explicitly return a result and break the agentic loop.
 * Used by minion sub-agents to signal task completion with a specific value.
 *
 * This tool is internal - it's not shown in the main chat's tool list,
 * but is automatically available to minion agents.
 */

import type { ClientSideTool, ToolResult, ToolStreamEvent } from '../../types';

export const returnTool: ClientSideTool = {
  name: 'return',
  displayName: 'Return',
  displaySubtitle: 'Return a result and stop execution',
  internal: true, // Not shown in ProjectSettings UI - only available to minion agents

  description:
    'Return a result from the current task and stop execution. IMPORTANT: Do not call this tool in parallel with other tools — it suspends the agentic loop, so results from other parallel tools will not be reported back.',

  inputSchema: {
    type: 'object',
    properties: {
      result: {
        type: 'string',
        description: 'The result to return',
      },
    },
    required: ['result'],
  },

  iconInput: '↩️',
  iconOutput: '✅',

  // eslint-disable-next-line require-yield -- Simple tool: generator for interface compatibility, no streaming events
  execute: async function* (input): AsyncGenerator<ToolStreamEvent, ToolResult, void> {
    const result = (input.result as string) ?? '';

    return {
      content: result,
      breakLoop: {
        returnValue: result,
      },
    };
  },

  renderInput: input => (input.result as string) ?? '',
  renderOutput: output => output,
};
