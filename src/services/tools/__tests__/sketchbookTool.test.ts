import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { sketchbookTool } from '../sketchbookTool';
import type { ToolContext, ToolOptions, ToolResult } from '../../../types';
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

async function collectToolResult(
  gen: ReturnType<typeof sketchbookTool.execute>
): Promise<ToolResult> {
  if (gen instanceof Promise) return gen;
  let result = await gen.next();
  while (!result.done) result = await gen.next();
  return result.value;
}

async function executeSketchbook(
  content: string,
  context?: ToolContext,
  toolOptions?: ToolOptions,
  name?: string
): Promise<ToolResult> {
  const input: Record<string, unknown> = { content };
  if (name !== undefined) input.name = name;
  return collectToolResult(
    sketchbookTool.execute(
      input,
      toolOptions ?? {},
      context ?? {
        projectId: 'test-project',
        chatId: 'chat-123',
        vfsAdapter: mockAdapter,
        createVfsAdapter: () => createMockAdapter(),
      }
    )
  );
}

describe('sketchbookTool', () => {
  beforeEach(() => {
    mockAdapter = createMockAdapter();
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

    it('has input schema with required content field and optional name', () => {
      const schema = sketchbookTool.inputSchema;
      expect(schema).toEqual({
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: expect.any(String),
          },
          name: {
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
      (mockAdapter.exists as Mock).mockResolvedValue(false);
      (mockAdapter.createFile as Mock).mockResolvedValue(undefined);

      const result = await executeSketchbook('hello world');

      expect(mockAdapter.exists).toHaveBeenCalledWith('/sketchbook/chat-123.md');
      expect(mockAdapter.createFile).toHaveBeenCalledWith('/sketchbook/chat-123.md', 'hello world');
      expect(result.content).toBe('noted.');
      expect(result.isError).toBeFalsy();
    });

    it('appends with newline separator on subsequent writes', async () => {
      (mockAdapter.exists as Mock).mockResolvedValue(true);
      (mockAdapter.readFile as Mock).mockResolvedValue('first entry');
      (mockAdapter.writeFile as Mock).mockResolvedValue(undefined);

      const result = await executeSketchbook('second entry');

      expect(mockAdapter.readFile).toHaveBeenCalledWith('/sketchbook/chat-123.md');
      expect(mockAdapter.writeFile).toHaveBeenCalledWith(
        '/sketchbook/chat-123.md',
        'first entry\n---\nsecond entry'
      );
      expect(result.content).toBe('noted.');
    });

    it('uses _default slug when chatId is undefined', async () => {
      (mockAdapter.exists as Mock).mockResolvedValue(false);
      (mockAdapter.createFile as Mock).mockResolvedValue(undefined);

      const result = await executeSketchbook('note', {
        projectId: 'test-project',
        vfsAdapter: mockAdapter,
        createVfsAdapter: () => createMockAdapter(),
      });

      expect(mockAdapter.exists).toHaveBeenCalledWith('/sketchbook/_default.md');
      expect(mockAdapter.createFile).toHaveBeenCalledWith('/sketchbook/_default.md', 'note');
      expect(result.content).toBe('noted.');
    });

    it('forwards namespace via adapter', async () => {
      const nsAdapter = createMockAdapter();
      (nsAdapter.exists as Mock).mockResolvedValue(true);
      (nsAdapter.readFile as Mock).mockResolvedValue('old');
      (nsAdapter.writeFile as Mock).mockResolvedValue(undefined);

      await executeSketchbook('new', {
        projectId: 'test-project',
        chatId: 'chat-123',
        namespace: '/minions/analyst',
        vfsAdapter: nsAdapter,
        createVfsAdapter: () => createMockAdapter(),
      });

      expect(nsAdapter.exists).toHaveBeenCalledWith('/sketchbook/chat-123.md');
      expect(nsAdapter.readFile).toHaveBeenCalledWith('/sketchbook/chat-123.md');
      expect(nsAdapter.writeFile).toHaveBeenCalledWith('/sketchbook/chat-123.md', 'old\n---\nnew');
    });

    it('returns error on VFS failure', async () => {
      (mockAdapter.exists as Mock).mockRejectedValue(new Error('disk full'));

      const result = await executeSketchbook('oops');

      expect(result.content).toBe('Error, please retry.');
      expect(result.isError).toBe(true);
    });

    it('throws when vfsAdapter is missing', async () => {
      await expect(
        executeSketchbook('note', { projectId: 'test-project' } as ToolContext)
      ).rejects.toThrow('vfsAdapter is required');
    });

    it('handles empty content string', async () => {
      (mockAdapter.exists as Mock).mockResolvedValue(false);
      (mockAdapter.createFile as Mock).mockResolvedValue(undefined);

      const result = await executeSketchbook('');

      expect(mockAdapter.createFile).toHaveBeenCalledWith('/sketchbook/chat-123.md', '');
      expect(result.content).toBe('noted.');
    });

    it('uses name in file path when provided', async () => {
      (mockAdapter.exists as Mock).mockResolvedValue(false);
      (mockAdapter.createFile as Mock).mockResolvedValue(undefined);

      const result = await executeSketchbook('draft', undefined, undefined, 'plan');

      expect(mockAdapter.exists).toHaveBeenCalledWith('/sketchbook/chat-123-plan.md');
      expect(mockAdapter.createFile).toHaveBeenCalledWith('/sketchbook/chat-123-plan.md', 'draft');
      expect(result.content).toBe('noted.');
    });

    it('uses default path when name is not provided', async () => {
      (mockAdapter.exists as Mock).mockResolvedValue(false);
      (mockAdapter.createFile as Mock).mockResolvedValue(undefined);

      const result = await executeSketchbook('note');

      expect(mockAdapter.createFile).toHaveBeenCalledWith('/sketchbook/chat-123.md', 'note');
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

    it('shows name on separate line when provided', () => {
      expect(sketchbookTool.renderInput?.({ content: 'draft', name: 'plan' })).toBe(
        'Name: plan\ndraft'
      );
    });
  });

  describe('noStore option', () => {
    it('skips VFS and returns noted when noStore is true', async () => {
      const result = await executeSketchbook(
        'some notes',
        {
          projectId: 'test-project',
          chatId: 'chat-123',
          vfsAdapter: mockAdapter,
          createVfsAdapter: () => createMockAdapter(),
        },
        { noStore: true }
      );

      expect(mockAdapter.exists).not.toHaveBeenCalled();
      expect(mockAdapter.createFile).not.toHaveBeenCalled();
      expect(mockAdapter.readFile).not.toHaveBeenCalled();
      expect(mockAdapter.writeFile).not.toHaveBeenCalled();
      expect(result.content).toBe('noted.');
      expect(result.isError).toBeFalsy();
    });

    it('does not require projectId when noStore is true', async () => {
      const result = await executeSketchbook(
        'notes',
        { vfsAdapter: mockAdapter, createVfsAdapter: () => createMockAdapter() } as ToolContext,
        { noStore: true }
      );

      expect(result.content).toBe('noted.');
    });

    it('stores normally when noStore is false', async () => {
      (mockAdapter.exists as Mock).mockResolvedValue(false);
      (mockAdapter.createFile as Mock).mockResolvedValue(undefined);

      const result = await executeSketchbook(
        'stored note',
        {
          projectId: 'test-project',
          chatId: 'chat-123',
          vfsAdapter: mockAdapter,
          createVfsAdapter: () => createMockAdapter(),
        },
        { noStore: false }
      );

      expect(mockAdapter.createFile).toHaveBeenCalled();
      expect(result.content).toBe('noted.');
    });
  });

  describe('renderOutput', () => {
    it('always returns noted.', () => {
      expect(sketchbookTool.renderOutput?.('anything')).toBe('noted.');
    });
  });
});
