import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadataTool } from '../metadataTool';
import type { Chat, ToolContext, ToolResult } from '../../../types';

vi.mock('../../storage', () => ({
  storage: {
    getChats: vi.fn(),
    getProject: vi.fn(),
  },
}));

async function collectToolResult(
  gen: ReturnType<typeof metadataTool.execute>
): Promise<ToolResult> {
  if (gen instanceof Promise) return gen;
  let result = await gen.next();
  while (!result.done) result = await gen.next();
  return result.value;
}

async function executeMetadata(
  input: Record<string, unknown>,
  context?: ToolContext
): Promise<ToolResult> {
  return collectToolResult(
    metadataTool.execute(input, {}, context ?? { projectId: 'proj-1', chatId: 'chat-1' })
  );
}

function makeChat(overrides: Partial<Chat> & { id: string; name: string }): Chat {
  return {
    projectId: 'proj-1',
    createdAt: new Date('2025-01-01'),
    lastModifiedAt: new Date('2025-06-15'),
    apiDefinitionId: null,
    modelId: null,
    ...overrides,
  };
}

describe('metadataTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('tool definition', () => {
    it('has correct name and displayName', () => {
      expect(metadataTool.name).toBe('metadata');
      expect(metadataTool.displayName).toBe('Metadata');
    });

    it('is not internal', () => {
      expect(metadataTool.internal).toBeFalsy();
    });

    it('has input schema with required command field', () => {
      const schema = metadataTool.inputSchema;
      expect(schema).toBeDefined();
      const schemaObj = typeof schema === 'function' ? schema({}) : schema;
      expect(schemaObj.required).toContain('command');
    });
  });

  describe('update_chat_metadata', () => {
    it('updates title only', async () => {
      const result = await executeMetadata({
        command: 'update_chat_metadata',
        title: 'My Title',
      });
      expect(result.isError).toBeFalsy();
      expect(result.chatMetadata).toEqual({ name: 'My Title' });
      expect(result.content).toContain('My Title');
    });

    it('updates summary only', async () => {
      const result = await executeMetadata({
        command: 'update_chat_metadata',
        summary: 'A discussion about X',
      });
      expect(result.isError).toBeFalsy();
      expect(result.chatMetadata).toEqual({ summary: 'A discussion about X' });
      expect(result.content).toContain('summary');
    });

    it('updates both title and summary', async () => {
      const result = await executeMetadata({
        command: 'update_chat_metadata',
        title: 'New Title',
        summary: 'New Summary',
      });
      expect(result.isError).toBeFalsy();
      expect(result.chatMetadata).toEqual({ name: 'New Title', summary: 'New Summary' });
      expect(result.content).toContain('New Title');
      expect(result.content).toContain('New Summary');
    });

    it('trims whitespace from title', async () => {
      const result = await executeMetadata({
        command: 'update_chat_metadata',
        title: '  Trimmed  ',
      });
      expect(result.chatMetadata).toEqual({ name: 'Trimmed' });
    });

    it('truncates title exceeding max length', async () => {
      const longTitle = 'A'.repeat(250);
      const result = await executeMetadata({
        command: 'update_chat_metadata',
        title: longTitle,
      });
      expect(result.chatMetadata!.name).toHaveLength(200);
    });

    it('returns error for empty title', async () => {
      const result = await executeMetadata({
        command: 'update_chat_metadata',
        title: '',
      });
      expect(result.isError).toBe(true);
      expect(result.chatMetadata).toBeUndefined();
    });

    it('returns error for whitespace-only title', async () => {
      const result = await executeMetadata({
        command: 'update_chat_metadata',
        title: '   ',
      });
      expect(result.isError).toBe(true);
    });

    it('clears summary with empty string', async () => {
      const result = await executeMetadata({
        command: 'update_chat_metadata',
        summary: '',
      });
      expect(result.chatMetadata).toEqual({ summary: '' });
      expect(result.content).toContain('cleared');
    });

    it('trims whitespace from summary', async () => {
      const result = await executeMetadata({
        command: 'update_chat_metadata',
        summary: '  trimmed  ',
      });
      expect(result.chatMetadata).toEqual({ summary: 'trimmed' });
    });

    it('returns error when neither title nor summary provided', async () => {
      const result = await executeMetadata({ command: 'update_chat_metadata' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('at least one');
    });

    it('does not set summary when only title provided', async () => {
      const result = await executeMetadata({
        command: 'update_chat_metadata',
        title: 'Only Title',
      });
      expect(result.chatMetadata).toEqual({ name: 'Only Title' });
      expect(result.chatMetadata).not.toHaveProperty('summary');
    });

    it('does not set name when only summary provided', async () => {
      const result = await executeMetadata({
        command: 'update_chat_metadata',
        summary: 'Only Summary',
      });
      expect(result.chatMetadata).toEqual({ summary: 'Only Summary' });
      expect(result.chatMetadata).not.toHaveProperty('name');
    });
  });

  describe('list_recent_chats', () => {
    async function mockStorage(
      chats: Chat[],
      timestampMode?: 'utc' | 'local' | 'relative' | 'disabled'
    ) {
      const { storage } = await import('../../storage');
      (storage.getChats as ReturnType<typeof vi.fn>).mockResolvedValue(chats);
      (storage.getProject as ReturnType<typeof vi.fn>).mockResolvedValue(
        timestampMode !== undefined ? { metadataTimestampMode: timestampMode } : {}
      );
    }

    it('lists chats with default count, omits timestamp by default', async () => {
      const chats = [
        makeChat({ id: 'c1', name: 'Chat One', summary: 'About one' }),
        makeChat({ id: 'c2', name: 'Chat Two' }),
      ];
      await mockStorage(chats);

      const result = await executeMetadata({ command: 'list_recent_chats' });
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('Chat One');
      expect(result.content).toContain('About one');
      expect(result.content).toContain('Chat Two');
      expect(result.content).not.toContain('Last modified');
      expect(result.chatMetadata).toBeUndefined();
    });

    it('shows timestamp with utc mode', async () => {
      const chats = [makeChat({ id: 'c1', name: 'Chat One' })];
      await mockStorage(chats, 'utc');

      const result = await executeMetadata({ command: 'list_recent_chats' });
      expect(result.content).toContain('Last modified:');
      expect(result.content).toContain('UTC');
    });

    it('shows timestamp with local mode', async () => {
      const chats = [makeChat({ id: 'c1', name: 'Chat One' })];
      await mockStorage(chats, 'local');

      const result = await executeMetadata({ command: 'list_recent_chats' });
      expect(result.content).toContain('Last modified:');
    });

    it('shows relative timestamp', async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const chats = [makeChat({ id: 'c1', name: 'Chat One', lastModifiedAt: twoHoursAgo })];
      await mockStorage(chats, 'relative');

      const result = await executeMetadata({ command: 'list_recent_chats' });
      expect(result.content).toContain('2 hours ago');
    });

    it('omits timestamp with disabled mode', async () => {
      const chats = [makeChat({ id: 'c1', name: 'Chat One' })];
      await mockStorage(chats, 'disabled');

      const result = await executeMetadata({ command: 'list_recent_chats' });
      expect(result.content).not.toContain('Last modified');
    });

    it('limits to requested count', async () => {
      const chats = Array.from({ length: 20 }, (_, i) =>
        makeChat({ id: `c${i}`, name: `Chat ${i}` })
      );
      await mockStorage(chats);

      const result = await executeMetadata({ command: 'list_recent_chats', count: 3 });
      expect(result.content).toContain('Chat 0');
      expect(result.content).toContain('Chat 2');
      expect(result.content).not.toContain('Chat 3');
    });

    it('clamps count to max 50', async () => {
      const chats = Array.from({ length: 60 }, (_, i) =>
        makeChat({ id: `c${i}`, name: `Chat ${i}` })
      );
      await mockStorage(chats);

      const result = await executeMetadata({ command: 'list_recent_chats', count: 100 });
      expect(result.content).toContain('Recent chats (50)');
    });

    it('clamps count to min 1', async () => {
      const chats = [makeChat({ id: 'c1', name: 'Only Chat' })];
      await mockStorage(chats);

      const result = await executeMetadata({ command: 'list_recent_chats', count: 0 });
      expect(result.content).toContain('Only Chat');
    });

    it('handles empty project', async () => {
      await mockStorage([]);

      const result = await executeMetadata({ command: 'list_recent_chats' });
      expect(result.content).toBe('No chats in this project.');
    });

    it('returns error without projectId', async () => {
      const result = await executeMetadata({ command: 'list_recent_chats' }, { projectId: '' });
      expect(result.isError).toBe(true);
    });
  });

  describe('renderInput', () => {
    it('renders update_chat_metadata with title only', () => {
      const rendered = metadataTool.renderInput!({
        command: 'update_chat_metadata',
        title: 'Hi',
      });
      expect(rendered).toBe('update_chat_metadata: title="Hi"');
    });

    it('renders update_chat_metadata with summary only', () => {
      const rendered = metadataTool.renderInput!({
        command: 'update_chat_metadata',
        summary: 'Short',
      });
      expect(rendered).toBe('update_chat_metadata: summary="Short"');
    });

    it('renders update_chat_metadata with both', () => {
      const rendered = metadataTool.renderInput!({
        command: 'update_chat_metadata',
        title: 'Hi',
        summary: 'Short',
      });
      expect(rendered).toBe('update_chat_metadata: title="Hi", summary="Short"');
    });

    it('renders update_chat_metadata summary clear', () => {
      const rendered = metadataTool.renderInput!({
        command: 'update_chat_metadata',
        summary: '',
      });
      expect(rendered).toBe('update_chat_metadata: summary=(clear)');
    });

    it('renders list_recent_chats with default count', () => {
      const rendered = metadataTool.renderInput!({ command: 'list_recent_chats' });
      expect(rendered).toBe('list_recent_chats (10)');
    });

    it('renders list_recent_chats with custom count', () => {
      const rendered = metadataTool.renderInput!({ command: 'list_recent_chats', count: 5 });
      expect(rendered).toBe('list_recent_chats (5)');
    });

    it('truncates long summary in render', () => {
      const longSummary = 'X'.repeat(100);
      const rendered = metadataTool.renderInput!({
        command: 'update_chat_metadata',
        summary: longSummary,
      });
      expect(rendered).toContain('…');
      expect(rendered.length).toBeLessThan(120);
    });
  });

  describe('unknown command', () => {
    it('returns error for unknown command', async () => {
      const result = await executeMetadata({ command: 'unknown_command' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Unknown command');
    });
  });
});
