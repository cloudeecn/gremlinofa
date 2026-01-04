import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { toolRegistry, executeClientSideTool } from '../clientSideTools';
import { APIType, type ClientSideTool, type ToolResult } from '../../../types';

describe('clientSideTools', () => {
  describe('toolRegistry', () => {
    it('should have ping tool registered by default', () => {
      const tool = toolRegistry.get('ping');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('ping');
    });

    it('should identify ping as a client-side tool', () => {
      expect(toolRegistry.isClientSideTool('ping')).toBe(true);
    });

    it('should not identify unknown tools as client-side', () => {
      expect(toolRegistry.isClientSideTool('unknown_tool')).toBe(false);
    });

    it('should return all registered tools', () => {
      const tools = toolRegistry.getAll();
      expect(tools.length).toBeGreaterThanOrEqual(1);
      expect(tools.some(t => t.name === 'ping')).toBe(true);
    });

    it('should return tool definitions for API', () => {
      const definitions = toolRegistry.getToolDefinitions();
      expect(definitions.length).toBeGreaterThanOrEqual(1);

      const pingDef = definitions.find(d => d.name === 'ping');
      expect(pingDef).toBeDefined();
      expect(pingDef?.description).toContain('test tool calling');
      expect(pingDef?.input_schema).toEqual({
        type: 'object',
        properties: {},
        required: [],
      });
    });

    it('should allow registering custom tools', () => {
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

      toolRegistry.register(customTool);

      expect(toolRegistry.isClientSideTool('test_custom')).toBe(true);
      expect(toolRegistry.get('test_custom')).toBe(customTool);
    });
  });

  describe('executeClientSideTool', () => {
    it('should execute ping tool and return pong', async () => {
      const result = await executeClientSideTool('ping', {});
      expect(result.content).toBe('pong');
      expect(result.isError).toBeUndefined();
    });

    it('should return error for unknown tool', async () => {
      const result = await executeClientSideTool('nonexistent_tool', {});
      expect(result.content).toContain('Unknown tool');
      expect(result.isError).toBe(true);
    });

    it('should handle tool execution errors gracefully', async () => {
      // Register a tool that throws
      const errorTool: ClientSideTool = {
        name: 'error_tool',
        description: 'A tool that throws',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: async (): Promise<ToolResult> => {
          throw new Error('Intentional test error');
        },
      };
      toolRegistry.register(errorTool);

      const result = await executeClientSideTool('error_tool', {});
      expect(result.content).toContain('Tool execution failed');
      expect(result.content).toContain('Intentional test error');
      expect(result.isError).toBe(true);
    });
  });

  describe('ping tool', () => {
    it('should have correct description for tool calling', () => {
      const tool = toolRegistry.get('ping');
      expect(tool?.description).toContain('user explicitly asks');
      expect(tool?.description).toContain('test tool calling');
    });

    it('should have empty input schema', () => {
      const tool = toolRegistry.get('ping');
      expect(tool?.inputSchema.properties).toEqual({});
      expect(tool?.inputSchema.required).toEqual([]);
    });

    it('should execute correctly via direct call', async () => {
      const tool = toolRegistry.get('ping');
      expect(tool).toBeDefined();

      const result = await tool!.execute({});
      expect(result.content).toBe('pong');
    });

    it('should be marked as alwaysEnabled', () => {
      const tool = toolRegistry.get('ping');
      expect(tool?.alwaysEnabled).toBe(true);
    });
  });

  describe('getToolDefinitionsForAPI', () => {
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
      toolRegistry.register(testTool);
    });

    afterEach(() => {
      toolRegistry.unregister('test_api_tool');
      toolRegistry.unregister('tool_with_override');
    });

    it('should always include alwaysEnabled tools (ping)', () => {
      const defs = toolRegistry.getToolDefinitionsForAPI(APIType.ANTHROPIC, []);
      const pingDef = defs.find(d => (d as { name?: string }).name === 'ping');
      expect(pingDef).toBeDefined();
    });

    it('should include explicitly enabled tools', () => {
      const defs = toolRegistry.getToolDefinitionsForAPI(APIType.ANTHROPIC, ['test_api_tool']);
      const testDef = defs.find(d => (d as { name?: string }).name === 'test_api_tool');
      expect(testDef).toBeDefined();
    });

    it('should NOT include non-enabled, non-alwaysEnabled tools', () => {
      const defs = toolRegistry.getToolDefinitionsForAPI(APIType.ANTHROPIC, []);
      const testDef = defs.find(d => (d as { name?: string }).name === 'test_api_tool');
      expect(testDef).toBeUndefined();
    });

    it('should generate Anthropic format correctly', () => {
      const defs = toolRegistry.getToolDefinitionsForAPI(APIType.ANTHROPIC, ['test_api_tool']);
      const testDef = defs.find(d => (d as { name?: string }).name === 'test_api_tool');

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

    it('should generate OpenAI ChatGPT format correctly', () => {
      const defs = toolRegistry.getToolDefinitionsForAPI(APIType.CHATGPT, ['test_api_tool']);
      const testDef = defs.find(
        d => (d as { function?: { name: string } }).function?.name === 'test_api_tool'
      );

      expect(testDef).toEqual({
        type: 'function',
        function: {
          name: 'test_api_tool',
          description: 'A test tool for API format testing',
          parameters: {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
          },
        },
      });
    });

    it('should generate OpenAI Responses API format correctly', () => {
      const defs = toolRegistry.getToolDefinitionsForAPI(APIType.RESPONSES_API, ['test_api_tool']);
      // Responses API uses flat format (name at top level, not nested in "function")
      const testDef = defs.find(d => (d as { name?: string }).name === 'test_api_tool');

      expect(testDef).toEqual({
        type: 'function',
        name: 'test_api_tool',
        description: 'A test tool for API format testing',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
        },
        strict: false,
      });
    });

    it('should use apiOverrides when available', () => {
      const toolWithOverride: ClientSideTool = {
        name: 'tool_with_override',
        description: 'Tool with API override',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: async (): Promise<ToolResult> => ({ content: 'ok' }),
        apiOverrides: {
          [APIType.ANTHROPIC]: {
            name: 'tool_with_override',
            description: 'Custom override description',
            input_schema: { type: 'object' as const, properties: {}, required: [] as string[] },
          },
        },
      };
      toolRegistry.register(toolWithOverride);

      const defs = toolRegistry.getToolDefinitionsForAPI(APIType.ANTHROPIC, ['tool_with_override']);
      const overrideDef = defs.find(d => (d as { name?: string }).name === 'tool_with_override');

      expect(overrideDef).toEqual({
        name: 'tool_with_override',
        description: 'Custom override description',
        input_schema: { type: 'object', properties: {}, required: [] },
      });
    });

    it('should fall back to standard format when no override for API type', () => {
      const toolWithPartialOverride: ClientSideTool = {
        name: 'tool_with_override',
        description: 'Tool with partial override',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: async (): Promise<ToolResult> => ({ content: 'ok' }),
        apiOverrides: {
          [APIType.ANTHROPIC]: {
            name: 'tool_with_override',
            description: 'Anthropic-specific description',
            input_schema: { type: 'object' as const, properties: {}, required: [] as string[] },
          },
        },
      };
      toolRegistry.register(toolWithPartialOverride);

      // Request OpenAI format - should use standard generation (no ChatGPT override defined)
      const defs = toolRegistry.getToolDefinitionsForAPI(APIType.CHATGPT, ['tool_with_override']);
      const toolDef = defs.find(
        d => (d as { function?: { name: string } }).function?.name === 'tool_with_override'
      );

      expect(toolDef).toEqual({
        type: 'function',
        function: {
          name: 'tool_with_override',
          description: 'Tool with partial override',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      });
    });
  });
});
