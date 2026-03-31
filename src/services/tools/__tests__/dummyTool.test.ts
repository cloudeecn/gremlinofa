import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { dummyTool } from '../dummyTool';
import type { ToolContext, ToolResult } from '../../../types';
import type { VfsAdapter } from '../../vfs/vfsAdapter';

function createMockAdapter(): VfsAdapter {
  return {
    readDir: vi.fn(),
    readFile: vi.fn(),
    readFileWithMeta: vi.fn(),
    writeFile: vi.fn(),
    createFile: vi.fn(),
    deleteFile: vi.fn(),
    mkdir: vi.fn(),
    rmdir: vi.fn(),
    rename: vi.fn(),
    exists: vi.fn(),
    isFile: vi.fn(),
    isDirectory: vi.fn(),
    stat: vi.fn(),
    hasVfs: vi.fn(),
    clearVfs: vi.fn(),
    strReplace: vi.fn(),
    insert: vi.fn(),
    appendFile: vi.fn(),
    getFileMeta: vi.fn(),
    getFileId: vi.fn(),
    listVersions: vi.fn(),
    getVersion: vi.fn(),
    dropOldVersions: vi.fn(),
    listOrphans: vi.fn(),
    restoreOrphan: vi.fn(),
    purgeOrphan: vi.fn(),
    copyFile: vi.fn(),
    deletePath: vi.fn(),
    createFileGuarded: vi.fn(),
    ensureDirAndWrite: vi.fn(),
    compactProject: vi.fn(),
  } as VfsAdapter;
}

let mockAdapter: VfsAdapter;

async function collectToolResult(gen: ReturnType<typeof dummyTool.execute>): Promise<ToolResult> {
  if (gen instanceof Promise) return gen;
  let result = await gen.next();
  while (!result.done) result = await gen.next();
  return result.value;
}

describe('dummyTool', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    mockAdapter = createMockAdapter();
    ctx = {
      projectId: 'test-project',
      chatId: 'chat-123',
      vfsAdapter: mockAdapter,
      createVfsAdapter: () => createMockAdapter(),
    };
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
      (mockAdapter.readFile as Mock).mockResolvedValue(
        'return function(m, i) { return undefined; };'
      );

      const result = await collectToolResult(
        dummyTool.execute({ action: 'register', name: 'my-hook' }, {}, ctx)
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('my-hook');
      expect(result.content).toContain('activated');
      expect(result.activeHook).toBe('my-hook');
      expect(mockAdapter.readFile).toHaveBeenCalledWith('/hooks/my-hook.js');
      expect(mockAdapter.writeFile).not.toHaveBeenCalled();
    });

    it('returns error if hook file does not exist', async () => {
      (mockAdapter.readFile as Mock).mockRejectedValue(new Error('not found'));

      const result = await collectToolResult(
        dummyTool.execute({ action: 'register', name: 'missing' }, {}, ctx)
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('not found');
      expect(result.content).toContain('filesystem');
      expect(result.activeHook).toBeUndefined();
    });

    it('returns error if hook file is empty', async () => {
      (mockAdapter.readFile as Mock).mockResolvedValue('');

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
      (mockAdapter.ensureDirAndWrite as Mock).mockResolvedValue(undefined);

      const result = await collectToolResult(dummyTool.execute({ action: 'template' }, {}, ctx));

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('example.js');
      expect(result.content).toContain('hook-chain.example.js');
      expect(result.activeHook).toBeUndefined();
      expect(mockAdapter.ensureDirAndWrite).toHaveBeenCalledTimes(1);
      expect(mockAdapter.ensureDirAndWrite).toHaveBeenCalledWith('/hooks', [
        { name: 'example.js', content: expect.stringContaining('DUMMY System Hook Template') },
        {
          name: 'hook-chain.example.js',
          content: expect.stringContaining('Hook Chain Example'),
        },
      ]);
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
    it('returns error without vfsAdapter', async () => {
      const result = await collectToolResult(
        dummyTool.execute({ action: 'template' }, {}, { projectId: '' } as ToolContext)
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('No VFS adapter available');
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
