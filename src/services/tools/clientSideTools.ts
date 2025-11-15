import type { ClientSideTool, ToolResult } from '../../types';

/**
 * Registry for client-side tools that run locally instead of on the API server.
 * These tools are executed when Claude calls them, with results sent back in the conversation.
 */
class ClientSideToolRegistry {
  private tools = new Map<string, ClientSideTool>();

  register(tool: ClientSideTool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): ClientSideTool | undefined {
    return this.tools.get(name);
  }

  isClientSideTool(name: string): boolean {
    return this.tools.has(name);
  }

  getAll(): ClientSideTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool definitions formatted for the Anthropic API.
   * Only includes tools that should be sent to the API.
   */
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    input_schema: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  }> {
    return this.getAll().map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }
}

/**
 * Ping tool - simple test fixture to validate client-side tool infrastructure.
 * User says "test tool calling" → Claude calls ping → client responds pong → Claude reports success.
 */
const pingTool: ClientSideTool = {
  name: 'ping',
  description: 'Use this tool when the user explicitly asks to test tool calling',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  execute: async (): Promise<ToolResult> => {
    return { content: 'pong' };
  },
};

// Create and export singleton registry
export const toolRegistry = new ClientSideToolRegistry();

// Register built-in tools
toolRegistry.register(pingTool);

/**
 * Execute a client-side tool by name.
 * Returns the tool result or an error if the tool is not found.
 */
export async function executeClientSideTool(
  toolName: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const tool = toolRegistry.get(toolName);

  if (!tool) {
    return {
      content: `Unknown tool: ${toolName}`,
      isError: true,
    };
  }

  try {
    return await tool.execute(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: `Tool execution failed: ${message}`,
      isError: true,
    };
  }
}
