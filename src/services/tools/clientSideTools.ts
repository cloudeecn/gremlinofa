import { APIType, type ClientSideTool, type ToolResult } from '../../types';

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
   * @deprecated Use getToolDefinitionsForAPI() for API-specific formats
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

  /**
   * Get tool definitions for a specific API type.
   * Includes alwaysEnabled tools + explicitly enabled tools.
   * Returns API-specific format (uses apiOverrides when available).
   */
  getToolDefinitionsForAPI(
    apiType: APIType,
    enabledToolNames: string[]
  ): Array<Record<string, unknown>> {
    const enabledSet = new Set(enabledToolNames);
    const definitions: Array<Record<string, unknown>> = [];

    for (const tool of this.tools.values()) {
      // Skip if not always enabled and not in enabled list
      if (!tool.alwaysEnabled && !enabledSet.has(tool.name)) {
        continue;
      }

      // Use override if available for this API type
      const override = tool.apiOverrides?.[apiType];
      if (override) {
        definitions.push(override);
        continue;
      }

      // Generate standard format based on API type
      definitions.push(this.generateStandardDefinition(apiType, tool));
    }

    return definitions;
  }

  /**
   * Generate standard tool definition for an API type (no override).
   */
  private generateStandardDefinition(
    apiType: APIType,
    tool: ClientSideTool
  ): Record<string, unknown> {
    switch (apiType) {
      case APIType.ANTHROPIC:
        return {
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        };

      case APIType.CHATGPT:
        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        };

      case APIType.RESPONSES_API:
        // Responses API uses flat structure (no nested "function" object)
        return {
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        };

      // WebLLM and Bedrock don't support tools yet - use Anthropic format as fallback
      case APIType.AMAZON_BEDROCK:
      case APIType.WEBLLM:
        return {
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        };
    }
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
  alwaysEnabled: true,
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
