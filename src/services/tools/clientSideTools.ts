import type {
  APIType,
  ClientSideTool,
  StandardToolDefinition,
  SystemPromptContext,
  ToolContext,
  ToolInputSchema,
  ToolOptions,
  ToolResult,
} from '../../types';

/**
 * Resolve description from tool - handles both static string and function.
 */
function resolveDescription(tool: ClientSideTool, options: ToolOptions): string {
  return typeof tool.description === 'function' ? tool.description(options) : tool.description;
}

/**
 * Resolve inputSchema from tool - handles both static object and function.
 */
function resolveInputSchema(tool: ClientSideTool, options: ToolOptions): ToolInputSchema {
  return typeof tool.inputSchema === 'function' ? tool.inputSchema(options) : tool.inputSchema;
}

/**
 * Registry for client-side tools that run locally instead of on the API server.
 * These tools are executed when Claude calls them, with results sent back in the conversation.
 */
class ClientSideToolRegistry {
  private tools = new Map<string, ClientSideTool>();

  /**
   * Register all tools at app startup.
   * This is the primary registration method - tools are statically defined.
   */
  registerAll(tools: ClientSideTool[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Get a tool by name (from all registered tools).
   */
  get(name: string): ClientSideTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if tool exists in registry.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get all registered tools (for ProjectSettings UI).
   */
  getAllTools(): ClientSideTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get system prompts from enabled tools that don't use getApiOverride for the given API type.
   * Returns array of non-empty system prompts to be appended to the project's system prompt.
   * Handles both static strings and async functions.
   *
   * @param apiType - The API type
   * @param enabledToolNames - List of enabled tool names
   * @param context - System prompt context
   * @param toolOptions - Per-tool options
   */
  async getSystemPrompts(
    apiType: APIType,
    enabledToolNames: string[],
    context: SystemPromptContext,
    toolOptions: Record<string, ToolOptions>
  ): Promise<string[]> {
    const toolsToCheck = this.getAllTools().filter(t => enabledToolNames.includes(t.name));
    const prompts: string[] = [];

    for (const tool of toolsToCheck) {
      // Get tool-specific options
      const opts = toolOptions[tool.name] ?? {};

      // Skip if tool uses getApiOverride for this API type (provider handles prompts)
      if (tool.getApiOverride) {
        const override = tool.getApiOverride(apiType, opts);
        if (override) continue;
      }

      // Skip if no systemPrompt defined
      if (!tool.systemPrompt) continue;

      // Resolve system prompt
      const promptDef = tool.systemPrompt;
      if (typeof promptDef === 'function') {
        const result = await promptDef(context, opts);
        if (result) prompts.push(result);
      } else {
        prompts.push(promptDef);
      }
    }

    return prompts;
  }

  /**
   * Get standard tool definitions for enabled tools.
   * Returns API-agnostic format; clients translate to their provider-specific format.
   *
   * @param enabledToolNames - List of enabled tool names
   * @param toolOptions - Per-tool options
   */
  getToolDefinitions(
    enabledToolNames: string[],
    toolOptions: Record<string, ToolOptions>
  ): StandardToolDefinition[] {
    const enabledTools = this.getAllTools().filter(t => enabledToolNames.includes(t.name));

    return enabledTools.map(tool => {
      const opts = toolOptions[tool.name] ?? {};
      return {
        name: tool.name,
        description: resolveDescription(tool, opts),
        input_schema: resolveInputSchema(tool, opts),
      };
    });
  }

  /**
   * Get provider-specific override for a tool, if one exists.
   * Returns undefined if no override exists (client should use standard definition).
   *
   * @param toolName - Name of the tool
   * @param apiType - The API type
   * @param toolOptions - Per-tool options
   */
  getToolOverride(
    toolName: string,
    apiType: APIType,
    toolOptions: ToolOptions
  ): unknown | undefined {
    const tool = this.tools.get(toolName);
    if (!tool?.getApiOverride) return undefined;
    return tool.getApiOverride(apiType, toolOptions);
  }

  /**
   * Reset registry to empty state. For tests only.
   */
  _resetForTests(): void {
    this.tools.clear();
  }
}

// Create and export singleton registry
export const toolRegistry = new ClientSideToolRegistry();

/**
 * Execute a client-side tool by name.
 *
 * - Checks if tool is in enabledToolNames (disabled tools return "Unknown tool" error)
 * - Passes toolOptions and context to execute()
 *
 * @param toolName - Name of the tool to execute
 * @param input - Tool input parameters
 * @param enabledToolNames - List of enabled tool names
 * @param toolOptions - Per-tool options
 * @param context - Execution context
 */
export async function executeClientSideTool(
  toolName: string,
  input: Record<string, unknown>,
  enabledToolNames: string[],
  toolOptions: Record<string, ToolOptions>,
  context: ToolContext
): Promise<ToolResult> {
  // Check if tool is enabled
  if (!enabledToolNames.includes(toolName)) {
    return {
      content: `Unknown tool: ${toolName}`,
      isError: true,
    };
  }

  const tool = toolRegistry.get(toolName);

  if (!tool) {
    return {
      content: `Unknown tool: ${toolName}`,
      isError: true,
    };
  }

  try {
    const opts = toolOptions[toolName] ?? {};
    return await tool.execute(input, opts, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: `Tool execution failed: ${message}`,
      isError: true,
    };
  }
}
