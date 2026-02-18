/**
 * Return Tool
 *
 * Allows agents to explicitly return a result and break the agentic loop.
 * Used by minion sub-agents to signal task completion with a specific value.
 *
 * This tool is internal - it's not shown in the main chat's tool list,
 * but is automatically available to minion agents.
 */

import type { ClientSideTool, ToolOptions, ToolResult, ToolStreamEvent } from '../../types';

export const returnTool: ClientSideTool = {
  name: 'return',
  displayName: 'Return',
  displaySubtitle: 'Return a result and stop execution',
  internal: true, // Not shown in ProjectSettings UI - only available to minion agents

  description: (opts: ToolOptions) =>
    opts.deferReturn
      ? 'Store a result to return to the caller. Execution continues after this call — you can perform cleanup or follow-up work. The stored result will be delivered when you finish.'
      : 'Signal task completion by returning a result to the caller. This ends your current turn — no further tool calls will run. Use this when you have a final answer or deliverable ready. The caller may continue the conversation later.',

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
