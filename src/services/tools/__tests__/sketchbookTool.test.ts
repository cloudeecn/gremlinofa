import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { sketchbookTool } from '../sketchbookTool';
import * as vfs from '../../vfs/vfsService';
import type { ToolContext, ToolResult } from '../../../types';

vi.mock('../../vfs/vfsService', async importOriginal => {
  const actual = await importOriginal<typeof import('../../vfs/vfsService')>();
  return {
    ...actual,
    exists: vi.fn(),
    readFile: vi.fn(),
    createFile: vi.fn(),
    updateFile: vi.fn(),
  };
});

async function collectToolResult(
  gen: ReturnType<typeof sketchbookTool.execute>
): Promise<ToolResult> {
  if (gen instanceof Promise) return gen;
  let result = await gen.next();
  while (!result.done) result = await gen.next();
  return result.value;
}

async function executeSketchbook(content: string, context?: ToolContext): Promise<ToolResult> {
  return collectToolResult(
    sketchbookTool.execute(
      { content },
      {},
      context ?? { projectId: 'test-project', chatId: 'chat-123' }
    )
  );
}

describe('sketchbookTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('tool definition', () => {
    it('has correct name and displayName', () => {
      expect(sketchbookTool.name).toBe('sketchbook');
      expect(sketchbookTool.displayName).toBe('Sketchbook');
    });

    it('is not internal', () => {
      expect(sketchbookTool.internal).toBeFalsy();
    });

    it('has correct icons', () => {
      expect(sketchbookTool.iconInput).toBe('📓');
      expect(sketchbookTool.iconOutput).toBe('📓');
    });

    it('has input schema with required content field', () => {
      const schema = sketchbookTool.inputSchema;
      expect(schema).toEqual({
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: expect.any(String),
          },
        },
        required: ['content'],
      });
    });
  });

  describe('execute', () => {
    it('creates new file on first write', async () => {
      (vfs.exists as Mock).mockResolvedValue(false);
      (vfs.createFile as Mock).mockResolvedValue(undefined);

      const result = await executeSketchbook('hello world');

      expect(vfs.exists).toHaveBeenCalledWith('test-project', '/sketchbook/chat-123.md', undefined);
      expect(vfs.createFile).toHaveBeenCalledWith(
        'test-project',
        '/sketchbook/chat-123.md',
        'hello world',
        undefined
      );
      expect(result.content).toBe('noted.');
      expect(result.isError).toBeFalsy();
    });

    it('appends with newline separator on subsequent writes', async () => {
      (vfs.exists as Mock).mockResolvedValue(true);
      (vfs.readFile as Mock).mockResolvedValue('first entry');
      (vfs.updateFile as Mock).mockResolvedValue(undefined);

      const result = await executeSketchbook('second entry');

      expect(vfs.readFile).toHaveBeenCalledWith(
        'test-project',
        '/sketchbook/chat-123.md',
        undefined
      );
      expect(vfs.updateFile).toHaveBeenCalledWith(
        'test-project',
        '/sketchbook/chat-123.md',
        'first entry\n---\nsecond entry',
        undefined
      );
      expect(result.content).toBe('noted.');
    });

    it('uses _default slug when chatId is undefined', async () => {
      (vfs.exists as Mock).mockResolvedValue(false);
      (vfs.createFile as Mock).mockResolvedValue(undefined);

      const result = await executeSketchbook('note', { projectId: 'test-project' });

      expect(vfs.exists).toHaveBeenCalledWith('test-project', '/sketchbook/_default.md', undefined);
      expect(vfs.createFile).toHaveBeenCalledWith(
        'test-project',
        '/sketchbook/_default.md',
        'note',
        undefined
      );
      expect(result.content).toBe('noted.');
    });

    it('forwards namespace to all VFS calls', async () => {
      (vfs.exists as Mock).mockResolvedValue(true);
      (vfs.readFile as Mock).mockResolvedValue('old');
      (vfs.updateFile as Mock).mockResolvedValue(undefined);

      await executeSketchbook('new', {
        projectId: 'test-project',
        chatId: 'chat-123',
        namespace: '/minions/analyst',
      });

      expect(vfs.exists).toHaveBeenCalledWith(
        'test-project',
        '/sketchbook/chat-123.md',
        '/minions/analyst'
      );
      expect(vfs.readFile).toHaveBeenCalledWith(
        'test-project',
        '/sketchbook/chat-123.md',
        '/minions/analyst'
      );
      expect(vfs.updateFile).toHaveBeenCalledWith(
        'test-project',
        '/sketchbook/chat-123.md',
        'old\n---\nnew',
        '/minions/analyst'
      );
    });

    it('returns error on VFS failure', async () => {
      (vfs.exists as Mock).mockRejectedValue(new Error('disk full'));

      const result = await executeSketchbook('oops');

      expect(result.content).toBe('Error, please retry.');
      expect(result.isError).toBe(true);
    });

    it('throws when projectId is missing', async () => {
      await expect(executeSketchbook('note', {} as ToolContext)).rejects.toThrow(
        'projectId is required'
      );
    });

    it('handles empty content string', async () => {
      (vfs.exists as Mock).mockResolvedValue(false);
      (vfs.createFile as Mock).mockResolvedValue(undefined);

      const result = await executeSketchbook('');

      expect(vfs.createFile).toHaveBeenCalledWith(
        'test-project',
        '/sketchbook/chat-123.md',
        '',
        undefined
      );
      expect(result.content).toBe('noted.');
    });
  });

  describe('renderInput', () => {
    it('returns content string', () => {
      expect(sketchbookTool.renderInput?.({ content: 'my notes' })).toBe('my notes');
    });

    it('returns empty string for missing content', () => {
      expect(sketchbookTool.renderInput?.({})).toBe('');
    });
  });

  describe('renderOutput', () => {
    it('always returns noted.', () => {
      expect(sketchbookTool.renderOutput?.('anything')).toBe('noted.');
    });
  });
});
