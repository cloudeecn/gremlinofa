import type Anthropic from '@anthropic-ai/sdk';
import type { ChatCompletionTool } from 'openai/resources/index.mjs';
import type OpenAI from 'openai';
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
   * Get tools that should be included based on enabledToolNames.
   * Includes alwaysEnabled tools + explicitly enabled tools.
   */
  private getEnabledTools(enabledToolNames: string[]): ClientSideTool[] {
    const enabledSet = new Set(enabledToolNames);
    return this.getAll().filter(tool => tool.alwaysEnabled || enabledSet.has(tool.name));
  }

  /**
   * Get tool definitions for a specific API type.
   * Includes alwaysEnabled tools + explicitly enabled tools.
   * Returns API-specific format (uses apiOverrides when available).
   */
  getToolDefinitionsForAPI(
    apiType: typeof APIType.ANTHROPIC,
    enabledToolNames: string[]
  ): Anthropic.Beta.BetaToolUnion[];
  getToolDefinitionsForAPI(
    apiType: typeof APIType.CHATGPT,
    enabledToolNames: string[]
  ): ChatCompletionTool[];
  getToolDefinitionsForAPI(
    apiType: typeof APIType.RESPONSES_API,
    enabledToolNames: string[]
  ): OpenAI.Responses.Tool[];
  getToolDefinitionsForAPI(
    apiType: typeof APIType.WEBLLM,
    enabledToolNames: string[]
  ): Anthropic.Beta.BetaToolUnion[];
  getToolDefinitionsForAPI(
    apiType: APIType,
    enabledToolNames: string[]
  ): Anthropic.Beta.BetaToolUnion[] | ChatCompletionTool[] | OpenAI.Responses.Tool[] {
    const tools = this.getEnabledTools(enabledToolNames);

    switch (apiType) {
      case APIType.ANTHROPIC: {
        const mapper = (tool: ClientSideTool): Anthropic.Beta.BetaToolUnion => {
          const override = tool.apiOverrides?.[APIType.ANTHROPIC];
          if (override) return override;
          return {
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          };
        };
        return tools.map(mapper);
      }

      case APIType.CHATGPT: {
        const mapper = (tool: ClientSideTool): ChatCompletionTool => {
          const override = tool.apiOverrides?.[APIType.CHATGPT];
          if (override) return override;
          return {
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          };
        };
        return tools.map(mapper);
      }

      case APIType.RESPONSES_API: {
        const mapper = (tool: ClientSideTool): OpenAI.Responses.Tool => {
          const override = tool.apiOverrides?.[APIType.RESPONSES_API];
          if (override) return override;
          // Responses API uses flat structure (no nested "function" object)
          return {
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: false,
          };
        };
        return tools.map(mapper);
      }

      case APIType.WEBLLM: {
        // WebLLM doesn't support tools yet - use Anthropic format as fallback
        return tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        }));
      }
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
