import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkpointTool } from '../checkpointTool';
import { toolRegistry } from '../clientSideTools';
import type { ToolResult, ToolExecuteReturn } from '../../../types';

/** Consume an async generator to get the final ToolResult */
async function collectToolResult(gen: ToolExecuteReturn): Promise<ToolResult> {
  if (gen instanceof Promise) return gen;
  let result = await gen.next();
  while (!result.done) result = await gen.next();
  return result.value;
}

describe('checkpointTool', () => {
  describe('tool definition', () => {
    it('should have correct name', () => {
      expect(checkpointTool.name).toBe('checkpoint');
    });

    it('should not be internal (visible in ProjectSettings)', () => {
      expect(checkpointTool.internal).toBeFalsy();
    });

    it('should have correct icons', () => {
      expect(checkpointTool.iconInput).toBe('📍');
      expect(checkpointTool.iconOutput).toBe('✅');
    });

    it('should require note input', () => {
      const schema =
        typeof checkpointTool.inputSchema === 'function'
          ? checkpointTool.inputSchema({})
          : checkpointTool.inputSchema;
      expect(schema.required).toContain('note');
      expect(schema.properties).toHaveProperty('note');
    });

    it('should have continueMessage option definition', () => {
      expect(checkpointTool.optionDefinitions).toBeDefined();
      const continueOpt = checkpointTool.optionDefinitions!.find(o => o.id === 'continueMessage');
      expect(continueOpt).toBeDefined();
      expect(continueOpt!.type).toBe('longtext');
      expect((continueOpt as { default: string }).default).toBe('please continue');
    });

    it('should have 6 swipe boolean options defaulting to true', () => {
      const swipeIds = [
        'swipeFilesystem',
        'swipeMemory',
        'swipeJavascript',
        'swipeMinion',
        'swipeSketchbook',
        'swipeCheckpoint',
      ];
      for (const id of swipeIds) {
        const opt = checkpointTool.optionDefinitions!.find(o => o.id === id);
        expect(opt, `option ${id} should exist`).toBeDefined();
        expect(opt!.type).toBe('boolean');
        expect((opt as { default: boolean }).default).toBe(true);
      }
    });
  });

  describe('execute', () => {
    it('should return checkpoint flag', async () => {
      const result = await collectToolResult(checkpointTool.execute({ note: 'finished phase 1' }));

      expect(result.checkpoint).toBe(true);
      expect(result.content).toContain('Checkpoint');
    });

    it('should not set breakLoop', async () => {
      const result = await collectToolResult(checkpointTool.execute({ note: 'progress note' }));

      expect(result.breakLoop).toBeUndefined();
    });

    it('should not set isError', async () => {
      const result = await collectToolResult(checkpointTool.execute({ note: 'progress note' }));

      expect(result.isError).toBeUndefined();
    });

    it('should handle empty note', async () => {
      const result = await collectToolResult(checkpointTool.execute({ note: '' }));

      expect(result.checkpoint).toBe(true);
      expect(result.content).toContain('Checkpoint');
    });

    it('should handle missing note', async () => {
      const result = await collectToolResult(checkpointTool.execute({}));

      expect(result.checkpoint).toBe(true);
    });
  });

  describe('renderInput', () => {
    it('should return the note string', () => {
      expect(checkpointTool.renderInput!({ note: 'my progress' })).toBe('my progress');
    });

    it('should handle missing note', () => {
      expect(checkpointTool.renderInput!({})).toBe('');
    });
  });

  describe('renderOutput', () => {
    it('should return output unchanged', () => {
      expect(checkpointTool.renderOutput!('checkpoint saved')).toBe('checkpoint saved');
    });
  });
});

describe('checkpoint tool registry', () => {
  beforeEach(() => {
    toolRegistry._resetForTests();
    toolRegistry.registerAll([checkpointTool]);
  });

  afterEach(() => {
    toolRegistry._resetForTests();
  });

  it('should be visible in getVisibleTools (not internal)', () => {
    const visibleTools = toolRegistry.getVisibleTools();
    expect(visibleTools.some(t => t.name === 'checkpoint')).toBe(true);
  });

  it('should be executable when enabled', async () => {
    const { executeToolSimple } = await import('../clientSideTools');
    const result = await executeToolSimple(
      'checkpoint',
      { note: 'test checkpoint' },
      ['checkpoint'],
      {},
      { projectId: 'test-project' }
    );

    expect(result.checkpoint).toBe(true);
    expect(result.content).toContain('Checkpoint');
  });
});
