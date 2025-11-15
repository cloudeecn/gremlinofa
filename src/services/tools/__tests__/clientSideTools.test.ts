import { describe, it, expect } from 'vitest';
import { toolRegistry, executeClientSideTool } from '../clientSideTools';
import type { ClientSideTool, ToolResult } from '../../../types';

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
  });
});
