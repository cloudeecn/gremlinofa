import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { toolRegistry, executeToolSimple } from '../clientSideTools';
import { type ClientSideTool, type ToolResult, type SystemPromptContext } from '../../../types';

describe('clientSideTools', () => {
  afterEach(() => {
    toolRegistry._resetForTests();
  });

  describe('toolRegistry', () => {
    it('should not identify unknown tools as registered', () => {
      expect(toolRegistry.has('unknown_tool')).toBe(false);
    });

    it('should allow registering tools via registerAll', () => {
      const customTool: ClientSideTool = {
        name: 'test_custom',
        description: 'A test custom tool',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
        execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
          return { content: `Echo: ${input.message}` };
        },
      };

      toolRegistry.registerAll([customTool]);

      expect(toolRegistry.has('test_custom')).toBe(true);
      expect(toolRegistry.get('test_custom')).toBe(customTool);
    });
  });

  describe('executeToolSimple', () => {
    const context = { projectId: 'test-project' };

    it('should return error for unknown tool', async () => {
      const result = await executeToolSimple('nonexistent_tool', {}, [], {}, context);
      expect(result.content).toContain('Unknown tool');
      expect(result.isError).toBe(true);
    });

    it('should return error for disabled tool', async () => {
      const tool: ClientSideTool = {
        name: 'disabled_tool',
        description: 'A disabled tool',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: async (): Promise<ToolResult> => ({ content: 'ok' }),
      };
      toolRegistry.registerAll([tool]);

      // Tool exists but not in enabledToolNames
      const result = await executeToolSimple('disabled_tool', {}, [], {}, context);
      expect(result.content).toContain('Unknown tool');
      expect(result.isError).toBe(true);
    });

    it('should handle tool execution errors gracefully', async () => {
      const errorTool: ClientSideTool = {
        name: 'error_tool',
        description: 'A tool that throws',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: async (): Promise<ToolResult> => {
          throw new Error('Intentional test error');
        },
      };
      toolRegistry.registerAll([errorTool]);

      const result = await executeToolSimple('error_tool', {}, ['error_tool'], {}, context);
      expect(result.content).toContain('Tool execution failed');
      expect(result.content).toContain('Intentional test error');
      expect(result.isError).toBe(true);
    });

    it('should pass toolOptions and context to execute', async () => {
      let receivedOpts: unknown;
      let receivedCtx: unknown;
      const tool: ClientSideTool = {
        name: 'echo_tool',
        description: 'Echoes input',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: async (_input, opts, ctx): Promise<ToolResult> => {
          receivedOpts = opts;
          receivedCtx = ctx;
          return { content: 'ok' };
        },
      };
      toolRegistry.registerAll([tool]);

      await executeToolSimple(
        'echo_tool',
        { data: 'test' },
        ['echo_tool'],
        { echo_tool: { optA: true } },
        { projectId: 'proj-123', chatId: 'chat-456' }
      );

      expect(receivedOpts).toEqual({ optA: true });
      expect(receivedCtx).toEqual({ projectId: 'proj-123', chatId: 'chat-456' });
    });
  });

  describe('getToolDefinitions', () => {
    const testTool: ClientSideTool = {
      name: 'test_api_tool',
      description: 'A test tool for API format testing',
      inputSchema: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input'],
      },
      execute: async (): Promise<ToolResult> => ({ content: 'ok' }),
    };

    beforeEach(() => {
      toolRegistry.registerAll([testTool]);
    });

    it('should return empty array when no tools are enabled', () => {
      const defs = toolRegistry.getToolDefinitions([], {});
      expect(defs).toEqual([]);
    });

    it('should include explicitly enabled tools', () => {
      const defs = toolRegistry.getToolDefinitions(['test_api_tool'], {});
      const testDef = defs.find(d => d.name === 'test_api_tool');
      expect(testDef).toBeDefined();
    });

    it('should NOT include non-enabled tools', () => {
      const defs = toolRegistry.getToolDefinitions([], {});
      const testDef = defs.find(d => d.name === 'test_api_tool');
      expect(testDef).toBeUndefined();
    });

    it('should return standard format (Anthropic-aligned)', () => {
      const defs = toolRegistry.getToolDefinitions(['test_api_tool'], {});
      const testDef = defs.find(d => d.name === 'test_api_tool');

      expect(testDef).toEqual({
        name: 'test_api_tool',
        description: 'A test tool for API format testing',
        input_schema: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
        },
      });
    });
  });

  describe('getToolOverride', () => {
    it('should return override when getApiOverride returns a value for the API type', () => {
      const toolWithOverride: ClientSideTool = {
        name: 'tool_with_override',
        description: 'Tool with API override',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: async (): Promise<ToolResult> => ({ content: 'ok' }),
        getApiOverride: apiType => {
          if (apiType === 'anthropic') {
            return {
              name: 'tool_with_override',
              description: 'Custom override description',
              input_schema: { type: 'object' as const, properties: {}, required: [] as string[] },
            };
          }
          return undefined;
        },
      };
      toolRegistry.registerAll([toolWithOverride]);

      const override = toolRegistry.getToolOverride('tool_with_override', 'anthropic', {});

      expect(override).toEqual({
        name: 'tool_with_override',
        description: 'Custom override description',
        input_schema: { type: 'object', properties: {}, required: [] },
      });
    });

    it('should return undefined when getApiOverride returns undefined', () => {
      const toolWithPartialOverride: ClientSideTool = {
        name: 'tool_partial',
        description: 'Tool with partial override',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: async (): Promise<ToolResult> => ({ content: 'ok' }),
        getApiOverride: apiType => {
          if (apiType === 'anthropic') {
            return {
              name: 'tool_partial',
              description: 'Anthropic-specific description',
              input_schema: { type: 'object' as const, properties: {}, required: [] as string[] },
            };
          }
          return undefined;
        },
      };
      toolRegistry.registerAll([toolWithPartialOverride]);

      // Request chatgpt - override should be undefined
      const override = toolRegistry.getToolOverride('tool_partial', 'chatgpt', {});
      expect(override).toBeUndefined();
    });

    it('should return undefined when tool has no getApiOverride', () => {
      const toolWithoutOverride: ClientSideTool = {
        name: 'tool_no_override',
        description: 'Tool without API override',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: async (): Promise<ToolResult> => ({ content: 'ok' }),
      };
      toolRegistry.registerAll([toolWithoutOverride]);

      const override = toolRegistry.getToolOverride('tool_no_override', 'anthropic', {});
      expect(override).toBeUndefined();
    });

    it('should return undefined for unknown tool', () => {
      const override = toolRegistry.getToolOverride('unknown_tool', 'anthropic', {});
      expect(override).toBeUndefined();
    });
  });

  describe('getSystemPrompts', () => {
    const context: SystemPromptContext = {
      projectId: 'test-project',
      apiDefinitionId: 'api-123',
      modelId: 'model-456',
      apiType: 'chatgpt',
    };

    const toolWithPrompt: ClientSideTool = {
      name: 'tool_with_prompt',
      description: 'A tool with system prompt',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async (): Promise<ToolResult> => ({ content: 'ok' }),
      systemPrompt: 'You have access to tool_with_prompt for testing.',
    };

    const toolWithPromptAndOverride: ClientSideTool = {
      name: 'tool_with_prompt_override',
      description: 'A tool with prompt and Anthropic override',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async (): Promise<ToolResult> => ({ content: 'ok' }),
      systemPrompt: 'This prompt should be skipped for Anthropic.',
      getApiOverride: apiType => {
        if (apiType === 'anthropic') {
          return {
            name: 'tool_with_prompt_override',
            description: 'Custom Anthropic definition',
            input_schema: { type: 'object' as const, properties: {}, required: [] as string[] },
          };
        }
        return undefined;
      },
    };

    const toolWithoutPrompt: ClientSideTool = {
      name: 'tool_no_prompt',
      description: 'A tool without system prompt',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async (): Promise<ToolResult> => ({ content: 'ok' }),
    };

    beforeEach(() => {
      toolRegistry.registerAll([toolWithPrompt, toolWithPromptAndOverride, toolWithoutPrompt]);
    });

    it('should return system prompts for enabled tools', async () => {
      const prompts = await toolRegistry.getSystemPrompts(
        'chatgpt',
        ['tool_with_prompt'],
        context,
        {}
      );
      expect(prompts).toEqual(['You have access to tool_with_prompt for testing.']);
    });

    it('should skip tools without systemPrompt defined', async () => {
      const prompts = await toolRegistry.getSystemPrompts(
        'chatgpt',
        ['tool_no_prompt'],
        context,
        {}
      );
      expect(prompts).toEqual([]);
    });

    it('should skip tools that use getApiOverride for the current API type', async () => {
      const anthropicContext = { ...context, apiType: 'anthropic' as const };
      const prompts = await toolRegistry.getSystemPrompts(
        'anthropic',
        ['tool_with_prompt_override'],
        anthropicContext,
        {}
      );
      expect(prompts).toEqual([]);
    });

    it('should include prompt when getApiOverride returns undefined', async () => {
      const prompts = await toolRegistry.getSystemPrompts(
        'chatgpt',
        ['tool_with_prompt_override'],
        context,
        {}
      );
      expect(prompts).toEqual(['This prompt should be skipped for Anthropic.']);
    });

    it('should return multiple prompts for multiple enabled tools', async () => {
      const prompts = await toolRegistry.getSystemPrompts(
        'chatgpt',
        ['tool_with_prompt', 'tool_with_prompt_override'],
        context,
        {}
      );
      expect(prompts).toHaveLength(2);
      expect(prompts).toContain('You have access to tool_with_prompt for testing.');
      expect(prompts).toContain('This prompt should be skipped for Anthropic.');
    });

    it('should return empty array when no tools are enabled', async () => {
      const prompts = await toolRegistry.getSystemPrompts('chatgpt', [], context, {});
      expect(prompts).toEqual([]);
    });
  });
});
