import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { dummyTool } from '../dummyTool';
import * as vfs from '../../vfs';
import type { ToolContext, ToolResult } from '../../../types';

vi.mock('../../vfs', async importOriginal => {
  const actual = await importOriginal<typeof import('../../vfs')>();
  return {
    ...actual,
    isDirectory: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    ensureDirAndWrite: vi.fn(),
  };
});

async function collectToolResult(gen: ReturnType<typeof dummyTool.execute>): Promise<ToolResult> {
  if (gen instanceof Promise) return gen;
  let result = await gen.next();
  while (!result.done) result = await gen.next();
  return result.value;
}

const ctx: ToolContext = { projectId: 'test-project', chatId: 'chat-123' };

describe('dummyTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('tool definition', () => {
    it('has correct name', () => {
      expect(dummyTool.name).toBe('dummy');
    });

    it('has displayName and displaySubtitle', () => {
      expect(dummyTool.displayName).toBe('DUMMY System');
      expect(dummyTool.displaySubtitle).toBeDefined();
    });

    it('is not internal', () => {
      expect(dummyTool.internal).toBeFalsy();
    });

    it('requires action in input schema', () => {
      const schema =
        typeof dummyTool.inputSchema === 'function'
          ? dummyTool.inputSchema({})
          : dummyTool.inputSchema;
      expect(schema.required).toContain('action');
    });

    it('does not have code in input schema', () => {
      const schema =
        typeof dummyTool.inputSchema === 'function'
          ? dummyTool.inputSchema({})
          : dummyTool.inputSchema;
      expect(schema.properties).not.toHaveProperty('code');
    });

    it('has optionDefinitions with hookContextDepth', () => {
      expect(dummyTool.optionDefinitions).toBeDefined();
      const depthOpt = dummyTool.optionDefinitions!.find(o => o.id === 'hookContextDepth');
      expect(depthOpt).toBeDefined();
      expect(depthOpt!.type).toBe('number');
      expect((depthOpt as { default: number }).default).toBe(0);
    });
  });

  describe('register action', () => {
    it('returns activeHook signal with hook name', async () => {
      (vfs.readFile as Mock).mockResolvedValue('return function(m, i) { return undefined; };');

      const result = await collectToolResult(
        dummyTool.execute({ action: 'register', name: 'my-hook' }, {}, ctx)
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('my-hook');
      expect(result.content).toContain('activated');
      expect(result.activeHook).toBe('my-hook');
      expect(vfs.readFile).toHaveBeenCalledWith('test-project', '/hooks/my-hook.js', undefined);
      expect(vfs.writeFile).not.toHaveBeenCalled();
    });

    it('returns error if hook file does not exist', async () => {
      (vfs.readFile as Mock).mockRejectedValue(new Error('not found'));

      const result = await collectToolResult(
        dummyTool.execute({ action: 'register', name: 'missing' }, {}, ctx)
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('not found');
      expect(result.content).toContain('filesystem');
      expect(result.activeHook).toBeUndefined();
    });

    it('returns error if hook file is empty', async () => {
      (vfs.readFile as Mock).mockResolvedValue('');

      const result = await collectToolResult(
        dummyTool.execute({ action: 'register', name: 'empty' }, {}, ctx)
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('not found');
      expect(result.activeHook).toBeUndefined();
    });

    it('returns error if name is missing', async () => {
      const result = await collectToolResult(dummyTool.execute({ action: 'register' }, {}, ctx));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('name');
      expect(result.activeHook).toBeUndefined();
    });
  });

  describe('unregister action', () => {
    it('returns activeHook null signal', async () => {
      const result = await collectToolResult(dummyTool.execute({ action: 'unregister' }, {}, ctx));

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('deactivated');
      expect(result.activeHook).toBeNull();
    });
  });

  describe('template action', () => {
    it('generates example hook files', async () => {
      (vfs.ensureDirAndWrite as Mock).mockResolvedValue(undefined);

      const result = await collectToolResult(dummyTool.execute({ action: 'template' }, {}, ctx));

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('example.js');
      expect(result.content).toContain('hook-chain.example.js');
      expect(result.activeHook).toBeUndefined();
      expect(vfs.ensureDirAndWrite).toHaveBeenCalledTimes(1);
      expect(vfs.ensureDirAndWrite).toHaveBeenCalledWith(
        'test-project',
        '/hooks',
        [
          { name: 'example.js', content: expect.stringContaining('DUMMY System Hook Template') },
          {
            name: 'hook-chain.example.js',
            content: expect.stringContaining('Hook Chain Example'),
          },
        ],
        undefined
      );
    });
  });

  describe('invalid action', () => {
    it('returns error for unknown action', async () => {
      const result = await collectToolResult(dummyTool.execute({ action: 'invalid' }, {}, ctx));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('Unknown action');
    });
  });

  describe('no project context', () => {
    it('returns error without projectId', async () => {
      const result = await collectToolResult(
        dummyTool.execute({ action: 'template' }, {}, { projectId: '' })
      );

      expect(result.isError).toBe(true);
    });
  });

  describe('renderInput', () => {
    it('shows activate and name for register', () => {
      expect(dummyTool.renderInput!({ action: 'register', name: 'my-hook' })).toBe(
        'activate: my-hook'
      );
    });

    it('shows action name for other actions', () => {
      expect(dummyTool.renderInput!({ action: 'unregister' })).toBe('unregister');
      expect(dummyTool.renderInput!({ action: 'template' })).toBe('template');
    });
  });
});
