import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { returnTool } from '../returnTool';
import { toolRegistry } from '../clientSideTools';
import type { ToolResult, ToolExecuteReturn } from '../../../types';

/** Consume an async generator to get the final ToolResult */
async function collectToolResult(gen: ToolExecuteReturn): Promise<ToolResult> {
  if (gen instanceof Promise) return gen;
  let result = await gen.next();
  while (!result.done) result = await gen.next();
  return result.value;
}

describe('returnTool', () => {
  describe('tool definition', () => {
    it('should have correct name', () => {
      expect(returnTool.name).toBe('return');
    });

    it('should be marked as internal', () => {
      expect(returnTool.internal).toBe(true);
    });

    it('should have correct icons', () => {
      expect(returnTool.iconInput).toBe('↩️');
      expect(returnTool.iconOutput).toBe('✅');
    });

    it('should have default description when deferReturn is not set', () => {
      const desc = (returnTool.description as (opts: Record<string, unknown>) => string)({});
      expect(desc).toContain('ends your current turn');
      expect(desc).not.toContain('stored');
    });

    it('should have deferred description when deferReturn is true', () => {
      const desc = (returnTool.description as (opts: Record<string, unknown>) => string)({
        deferReturn: true,
      });
      expect(desc).toContain('Store a result');
      expect(desc).toContain('continues after this call');
      expect(desc).toContain('last result wins');
    });

    it('should have correct input schema', () => {
      expect(returnTool.inputSchema).toEqual({
        type: 'object',
        properties: {
          result: {
            type: 'string',
            description: 'The result to return',
          },
        },
        required: ['result'],
      });
    });
  });

  describe('execute', () => {
    it('should return breakLoop with returnValue', async () => {
      const result = await collectToolResult(
        returnTool.execute({ result: 'task completed successfully' })
      );

      expect(result).toEqual({
        content: 'task completed successfully',
        breakLoop: {
          returnValue: 'task completed successfully',
        },
      });
    });

    it('should handle empty string result', async () => {
      const result = await collectToolResult(returnTool.execute({ result: '' }));

      expect(result).toEqual({
        content: '',
        breakLoop: {
          returnValue: '',
        },
      });
    });

    it('should handle missing result as empty string', async () => {
      const result = await collectToolResult(returnTool.execute({}));

      expect(result).toEqual({
        content: '',
        breakLoop: {
          returnValue: '',
        },
      });
    });

    it('should handle multiline result', async () => {
      const multilineResult = 'Line 1\nLine 2\nLine 3';
      const result = await collectToolResult(returnTool.execute({ result: multilineResult }));

      expect(result.content).toBe(multilineResult);
      expect(result.breakLoop?.returnValue).toBe(multilineResult);
    });
  });

  describe('renderInput', () => {
    it('should return the result string directly', () => {
      expect(returnTool.renderInput!({ result: 'test value' })).toBe('test value');
    });

    it('should handle empty result', () => {
      expect(returnTool.renderInput!({ result: '' })).toBe('');
    });

    it('should handle missing result', () => {
      expect(returnTool.renderInput!({})).toBe('');
    });
  });

  describe('renderOutput', () => {
    it('should return output unchanged', () => {
      expect(returnTool.renderOutput!('test output')).toBe('test output');
    });
  });
});

describe('toolRegistry internal tool filtering', () => {
  beforeEach(() => {
    toolRegistry._resetForTests();
    toolRegistry.registerAll([returnTool]);
  });

  afterEach(() => {
    toolRegistry._resetForTests();
  });

  it('should include return tool in getAllTools', () => {
    const allTools = toolRegistry.getAllTools();
    expect(allTools.some(t => t.name === 'return')).toBe(true);
  });

  it('should exclude return tool from getVisibleTools', () => {
    const visibleTools = toolRegistry.getVisibleTools();
    expect(visibleTools.some(t => t.name === 'return')).toBe(false);
  });

  it('should allow execution when enabled', async () => {
    const { executeToolSimple } = await import('../clientSideTools');
    const result = await executeToolSimple(
      'return',
      { result: 'test' },
      ['return'],
      {},
      { projectId: 'test-project' }
    );

    expect(result.content).toBe('test');
    expect(result.breakLoop).toBeDefined();
    expect(result.breakLoop?.returnValue).toBe('test');
  });
});
