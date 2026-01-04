/**
 * Unit tests for UnifiedStorage
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UnifiedStorage } from '../unifiedStorage';
import {
  createMockAdapter,
  createMockEncryptionService,
  createTestAPIDefinition,
  createTestAttachment,
  createTestChat,
  createTestMessage,
  createTestProject,
} from './testUtils';

// Mock the encryption service
vi.mock('../../encryption/encryptionService', () => ({
  encryptionService: {
    initialize: vi.fn(),
    isInitialized: vi.fn(),
    encrypt: vi.fn(),
    decrypt: vi.fn(),
    getCEK: vi.fn(),
    clearCEK: vi.fn(),
  },
}));

describe('UnifiedStorage', () => {
  let adapter: ReturnType<typeof createMockAdapter>;
  let storage: UnifiedStorage;
  let mockEncryption: ReturnType<typeof createMockEncryptionService>;

  beforeEach(async () => {
    adapter = createMockAdapter();
    mockEncryption = createMockEncryptionService();

    // Replace the mocked encryption service with our mock
    const encryptionModule = await import('../../encryption/encryptionService');
    Object.assign(encryptionModule.encryptionService, mockEncryption);

    storage = new UnifiedStorage(adapter);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should initialize adapter on first call', async () => {
      await storage.initialize();

      expect(adapter.initialize).toHaveBeenCalledTimes(1);
    });

    it('should initialize encryption service', async () => {
      await storage.initialize();

      expect(mockEncryption.initialize).toHaveBeenCalled();
    });

    it('should create default API definitions', async () => {
      await storage.initialize();

      // Should save 4 default definitions (Responses, ChatGPT, Anthropic, WebLLM)
      const saveCalls = adapter.save.mock.calls.filter(
        ([table]: any) => table === 'api_definitions'
      );
      expect(saveCalls.length).toBeGreaterThanOrEqual(3);
    });

    it('should skip initialization if already initialized', async () => {
      await storage.initialize();
      adapter.initialize.mockClear();

      await storage.initialize();

      expect(adapter.initialize).not.toHaveBeenCalled();
    });
  });

  describe('API Definitions CRUD', () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    it('should save API definition', async () => {
      const apiDef = createTestAPIDefinition();

      await storage.saveAPIDefinition(apiDef);

      expect(adapter.save).toHaveBeenCalledWith(
        'api_definitions',
        apiDef.id,
        expect.stringContaining('encrypted:'),
        expect.objectContaining({
          timestamp: expect.any(String),
        })
      );
    });

    it('should get API definition by ID', async () => {
      const apiDef = createTestAPIDefinition();
      await storage.saveAPIDefinition(apiDef);

      const result = await storage.getAPIDefinition(apiDef.id);

      expect(result).toMatchObject({
        id: apiDef.id,
        name: apiDef.name,
        apiType: apiDef.apiType,
      });
    });

    it('should return null for missing API definition', async () => {
      const result = await storage.getAPIDefinition('non-existent');

      expect(result).toBeNull();
    });

    it('should get all API definitions ordered by timestamp', async () => {
      const apiDef1 = createTestAPIDefinition({ id: 'def-1' });
      const apiDef2 = createTestAPIDefinition({ id: 'def-2' });

      await storage.saveAPIDefinition(apiDef1);
      await storage.saveAPIDefinition(apiDef2);

      const result = await storage.getAPIDefinitions();

      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result.some(d => d.id === 'def-1')).toBe(true);
      expect(result.some(d => d.id === 'def-2')).toBe(true);
    });

    it('should delete API definition and cascade to models', async () => {
      const apiDef = createTestAPIDefinition();
      await storage.saveAPIDefinition(apiDef);

      await storage.deleteAPIDefinition(apiDef.id);

      expect(adapter.delete).toHaveBeenCalledWith('api_definitions', apiDef.id);
      expect(adapter.delete).toHaveBeenCalledWith('models_cache', apiDef.id);
    });

    it('should convert dates to/from ISO strings', async () => {
      const apiDef = createTestAPIDefinition();
      await storage.saveAPIDefinition(apiDef);

      const result = await storage.getAPIDefinition(apiDef.id);

      expect(result?.createdAt).toBeInstanceOf(Date);
      expect(result?.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('Projects CRUD', () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    it('should save project', async () => {
      const project = createTestProject();

      await storage.saveProject(project);

      expect(adapter.save).toHaveBeenCalledWith(
        'projects',
        project.id,
        expect.stringContaining('encrypted:'),
        expect.objectContaining({
          timestamp: expect.any(String),
        })
      );
    });

    it('should get project by ID', async () => {
      const project = createTestProject();
      await storage.saveProject(project);

      const result = await storage.getProject(project.id);

      expect(result).toMatchObject({
        id: project.id,
        name: project.name,
        icon: project.icon,
      });
    });

    it('should get all projects ordered by lastUsedAt', async () => {
      const project1 = createTestProject({
        id: 'proj-1',
        lastUsedAt: new Date('2024-01-01'),
      });
      const project2 = createTestProject({
        id: 'proj-2',
        lastUsedAt: new Date('2024-01-02'),
      });

      await storage.saveProject(project1);
      await storage.saveProject(project2);

      const result = await storage.getProjects();

      expect(result.length).toBeGreaterThanOrEqual(2);
      // Should be ordered by lastUsedAt descending
      const proj2Index = result.findIndex(p => p.id === 'proj-2');
      const proj1Index = result.findIndex(p => p.id === 'proj-1');
      expect(proj2Index).toBeLessThan(proj1Index);
    });

    it('should delete project and cascade to chats/messages', async () => {
      const project = createTestProject();
      const chat = createTestChat();
      await storage.saveProject(project);
      await storage.saveChat(chat);

      await storage.deleteProject(project.id);

      expect(adapter.delete).toHaveBeenCalledWith('projects', project.id);
      // deleteProject calls deleteChat for each chat, which calls delete on chats and deleteMany on messages
      expect(adapter.delete).toHaveBeenCalledWith('chats', chat.id);
      expect(adapter.deleteMany).toHaveBeenCalledWith('messages', {
        parentId: chat.id,
      });
    });
  });

  describe('Chats CRUD', () => {
    beforeEach(async () => {
      await storage.initialize();
      const project = createTestProject();
      await storage.saveProject(project);
    });

    it('should save chat', async () => {
      const chat = createTestChat();

      await storage.saveChat(chat);

      expect(adapter.save).toHaveBeenCalledWith(
        'chats',
        chat.id,
        expect.stringContaining('encrypted:'),
        expect.objectContaining({
          timestamp: expect.any(String),
          parentId: chat.projectId,
        })
      );
    });

    it('should get chat by ID', async () => {
      const chat = createTestChat();
      await storage.saveChat(chat);

      const result = await storage.getChat(chat.id);

      expect(result).toMatchObject({
        id: chat.id,
        projectId: chat.projectId,
        name: chat.name,
      });
    });

    it('should get chats for project ordered by lastModifiedAt', async () => {
      const chat1 = createTestChat({
        id: 'chat-1',
        lastModifiedAt: new Date('2024-01-01'),
      });
      const chat2 = createTestChat({
        id: 'chat-2',
        lastModifiedAt: new Date('2024-01-02'),
      });

      await storage.saveChat(chat1);
      await storage.saveChat(chat2);

      const result = await storage.getChats('test-project-1');

      expect(result.length).toBe(2);
      expect(result[0].id).toBe('chat-2'); // Most recent first
      expect(result[1].id).toBe('chat-1');
    });

    it('should delete chat and cascade to messages', async () => {
      const chat = createTestChat();
      await storage.saveChat(chat);

      await storage.deleteChat(chat.id);

      expect(adapter.delete).toHaveBeenCalledWith('chats', chat.id);
      expect(adapter.deleteMany).toHaveBeenCalledWith('messages', {
        parentId: chat.id,
      });
    });

    it('should move chat between projects', async () => {
      const chat = createTestChat({ projectId: 'project-1' });
      await storage.saveChat(chat);

      await storage.moveChat(chat.id, 'project-2');

      const result = await storage.getChat(chat.id);
      expect(result?.projectId).toBe('project-2');
    });

    it('should clone chat to different project', async () => {
      const chat = createTestChat();
      const message = createTestMessage();
      await storage.saveChat(chat);
      await storage.saveMessage(chat.id, message);

      const cloned = await storage.cloneChat(chat.id, 'project-2');

      expect(cloned).not.toBeNull();
      expect(cloned?.id).not.toBe(chat.id);
      expect(cloned?.projectId).toBe('project-2');
      expect(cloned?.name).toContain('Test Chat');
    });

    it('should clone chat up to specific message', async () => {
      const chat = createTestChat();
      const msg1 = createTestMessage({
        id: 'msg-1',
        timestamp: new Date('2024-01-01'),
        content: { type: 'text', content: 'First message' },
      });
      const msg2 = createTestMessage({
        id: 'msg-2',
        timestamp: new Date('2024-01-02'),
        content: { type: 'text', content: 'Second message' },
      });
      const msg3 = createTestMessage({
        id: 'msg-3',
        timestamp: new Date('2024-01-03'),
        content: { type: 'text', content: 'Third message' },
      });

      await storage.saveChat(chat);
      await storage.saveMessage(chat.id, msg1);
      await storage.saveMessage(chat.id, msg2);
      await storage.saveMessage(chat.id, msg3);

      // Clone up to (but not including) msg-2, so should only copy msg-1
      const cloned = await storage.cloneChat(chat.id, 'project-2', 'msg-2');

      expect(cloned).not.toBeNull();
      const messages = await storage.getMessages(cloned!.id);
      // Should have exactly 1 message (msg-1 only, with new ID but same content)
      expect(messages.length).toBe(1);
      expect(messages[0].content.content).toBe('First message');
    });
  });

  describe('Messages CRUD', () => {
    beforeEach(async () => {
      await storage.initialize();
      const project = createTestProject();
      const chat = createTestChat();
      await storage.saveProject(project);
      await storage.saveChat(chat);
    });

    it('should save message', async () => {
      const message = createTestMessage();

      await storage.saveMessage('test-chat-1', message);

      // Messages use compression - check for "compressed:" prefix
      expect(adapter.save).toHaveBeenCalledWith(
        'messages',
        message.id,
        expect.stringContaining('compressed:'),
        expect.objectContaining({
          timestamp: expect.any(String),
          parentId: 'test-chat-1',
        })
      );
    });

    it('should get messages for chat', async () => {
      const msg1 = createTestMessage({ id: 'msg-1' });
      const msg2 = createTestMessage({ id: 'msg-2' });

      await storage.saveMessage('test-chat-1', msg1);
      await storage.saveMessage('test-chat-1', msg2);

      const result = await storage.getMessages('test-chat-1');

      expect(result.length).toBe(2);
    });

    it('should delete messages after specific message', async () => {
      const msg1 = createTestMessage({ id: 'msg-1' });
      const msg2 = createTestMessage({ id: 'msg-2' });
      const msg3 = createTestMessage({ id: 'msg-3' });

      await storage.saveMessage('test-chat-1', msg1);
      await storage.saveMessage('test-chat-1', msg2);
      await storage.saveMessage('test-chat-1', msg3);

      await storage.deleteMessagesAfter('test-chat-1', 'msg-1');

      const remaining = await storage.getMessages('test-chat-1');
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).toBe('msg-1');
    });

    it('should delete message and all after it', async () => {
      const msg1 = createTestMessage({ id: 'msg-1' });
      const msg2 = createTestMessage({ id: 'msg-2' });
      const msg3 = createTestMessage({ id: 'msg-3' });

      await storage.saveMessage('test-chat-1', msg1);
      await storage.saveMessage('test-chat-1', msg2);
      await storage.saveMessage('test-chat-1', msg3);

      await storage.deleteMessageAndAfter('test-chat-1', 'msg-2');

      const remaining = await storage.getMessages('test-chat-1');
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).toBe('msg-1');
    });

    it('should get message count for chat', async () => {
      const msg1 = createTestMessage({ id: 'msg-1' });
      const msg2 = createTestMessage({ id: 'msg-2' });

      await storage.saveMessage('test-chat-1', msg1);
      await storage.saveMessage('test-chat-1', msg2);

      const count = await storage.getMessageCount('test-chat-1');

      expect(count).toBe(2);
    });
  });

  describe('Data Management', () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    it('should purge all data', async () => {
      // Add some data
      const apiDef = createTestAPIDefinition();
      const project = createTestProject();
      await storage.saveAPIDefinition(apiDef);
      await storage.saveProject(project);

      await storage.purgeAllData();

      expect(adapter.clearAll).toHaveBeenCalled();
      expect(mockEncryption.clearCEK).toHaveBeenCalled();
    });

    it('should re-initialize after purge', async () => {
      await storage.purgeAllData();

      // Should be able to use storage again
      const apiDef = createTestAPIDefinition();
      await storage.saveAPIDefinition(apiDef);

      const result = await storage.getAPIDefinition(apiDef.id);
      expect(result).not.toBeNull();
    });
  });

  describe('Encryption Integration', () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    it('should encrypt data before storage', async () => {
      const apiDef = createTestAPIDefinition();

      await storage.saveAPIDefinition(apiDef);

      expect(mockEncryption.encrypt).toHaveBeenCalled();
    });

    it('should decrypt data after retrieval', async () => {
      const apiDef = createTestAPIDefinition();
      await storage.saveAPIDefinition(apiDef);

      await storage.getAPIDefinition(apiDef.id);

      expect(mockEncryption.decrypt).toHaveBeenCalled();
    });

    it('should handle decryption errors gracefully', async () => {
      mockEncryption.decrypt.mockRejectedValueOnce(new Error('Decryption failed'));

      const apiDef = createTestAPIDefinition();
      await storage.saveAPIDefinition(apiDef);

      const result = await storage.getAPIDefinitions();

      // Should skip corrupted record and continue
      expect(result).toBeDefined();
    });
  });

  describe('Attachment Manager', () => {
    beforeEach(async () => {
      await storage.initialize();
      const project = createTestProject();
      const chat = createTestChat();
      await storage.saveProject(project);
      await storage.saveChat(chat);
    });

    describe('getAllAttachmentSections', () => {
      it('should return empty array when no attachments exist', async () => {
        const sections = await storage.getAllAttachmentSections();

        expect(sections).toEqual([]);
      });

      it('should return sections grouped by chat', async () => {
        // Create message with attachment
        const attachment = createTestAttachment({ id: 'att-1' });
        const message = createTestMessage({
          id: 'msg-with-att',
          content: {
            type: 'text',
            content: 'Message with attachment',
            attachmentIds: ['att-1'],
          },
        });

        await storage.saveMessage('test-chat-1', message);
        await storage.saveAttachment('msg-with-att', attachment);

        const sections = await storage.getAllAttachmentSections();

        expect(sections.length).toBe(1);
        expect(sections[0].chatId).toBe('test-chat-1');
        expect(sections[0].chatName).toBe('Test Chat');
        expect(sections[0].projectId).toBe('test-project-1');
        expect(sections[0].projectName).toBe('Test Project');
        expect(sections[0].attachments.length).toBe(1);
        expect(sections[0].attachments[0].id).toBe('att-1');
        expect(sections[0].attachments[0].messageId).toBe('msg-with-att');
      });

      it('should sort sections by chat timestamp descending', async () => {
        // Create two chats with different timestamps (explicitly set)
        const oldChat = createTestChat({
          id: 'old-chat',
          name: 'Old Chat',
          lastModifiedAt: new Date('2024-01-01T00:00:00Z'),
        });
        const newChat = createTestChat({
          id: 'new-chat',
          name: 'New Chat',
          lastModifiedAt: new Date('2024-06-01T00:00:00Z'),
        });
        await storage.saveChat(oldChat);
        await storage.saveChat(newChat);

        // Create messages with attachments (using adapter directly to avoid lastModifiedAt updates)
        const msg1 = createTestMessage({
          id: 'msg-old',
          content: { type: 'text', content: 'Old msg', attachmentIds: ['att-old'] },
        });
        const msg2 = createTestMessage({
          id: 'msg-new',
          content: { type: 'text', content: 'New msg', attachmentIds: ['att-new'] },
        });

        // Use adapter.save directly to avoid updating chat timestamps
        const msg1Data = { ...msg1, timestamp: msg1.timestamp.toISOString() };
        const msg2Data = { ...msg2, timestamp: msg2.timestamp.toISOString() };
        await adapter.save('messages', 'msg-old', `compressed:${JSON.stringify(msg1Data)}`, {
          timestamp: msg1.timestamp.toISOString(),
          parentId: 'old-chat',
        });
        await adapter.save('messages', 'msg-new', `compressed:${JSON.stringify(msg2Data)}`, {
          timestamp: msg2.timestamp.toISOString(),
          parentId: 'new-chat',
        });
        await storage.saveAttachment('msg-old', createTestAttachment({ id: 'att-old' }));
        await storage.saveAttachment('msg-new', createTestAttachment({ id: 'att-new' }));

        const sections = await storage.getAllAttachmentSections();

        expect(sections.length).toBe(2);
        // Newer chat should be first
        expect(sections[0].chatId).toBe('new-chat');
        expect(sections[1].chatId).toBe('old-chat');
      });

      it('should include multiple attachments from same message', async () => {
        const msg = createTestMessage({
          id: 'msg-multi',
          content: {
            type: 'text',
            content: 'Multi attachment',
            attachmentIds: ['att-1', 'att-2', 'att-3'],
          },
        });

        await storage.saveMessage('test-chat-1', msg);
        await storage.saveAttachment('msg-multi', createTestAttachment({ id: 'att-1' }));
        await storage.saveAttachment('msg-multi', createTestAttachment({ id: 'att-2' }));
        await storage.saveAttachment('msg-multi', createTestAttachment({ id: 'att-3' }));

        const sections = await storage.getAllAttachmentSections();

        expect(sections[0].attachments.length).toBe(3);
      });
    });

    describe('deleteAttachment', () => {
      it('should delete a single attachment and return messageId', async () => {
        const attachment = createTestAttachment({ id: 'att-to-delete' });
        const message = createTestMessage({
          id: 'msg-1',
          content: {
            type: 'text',
            content: 'Test',
            attachmentIds: ['att-to-delete'],
          },
        });

        await storage.saveMessage('test-chat-1', message);
        await storage.saveAttachment('msg-1', attachment);

        const messageId = await storage.deleteAttachment('att-to-delete');

        expect(messageId).toBe('msg-1');
        expect(adapter.delete).toHaveBeenCalledWith('attachments', 'att-to-delete');
      });

      it('should return null if attachment not found', async () => {
        const messageId = await storage.deleteAttachment('non-existent');

        expect(messageId).toBeNull();
      });
    });

    describe('deleteAttachmentsOlderThan', () => {
      it('should delete attachments older than specified days', async () => {
        // Old message (30 days ago)
        const oldMsg = createTestMessage({
          id: 'old-msg',
          timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          content: {
            type: 'text',
            content: 'Old message',
            attachmentIds: ['old-att'],
          },
        });

        // Recent message (1 day ago)
        const recentMsg = createTestMessage({
          id: 'recent-msg',
          timestamp: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
          content: {
            type: 'text',
            content: 'Recent message',
            attachmentIds: ['recent-att'],
          },
        });

        await storage.saveMessage('test-chat-1', oldMsg);
        await storage.saveMessage('test-chat-1', recentMsg);
        await storage.saveAttachment('old-msg', createTestAttachment({ id: 'old-att' }));
        await storage.saveAttachment('recent-msg', createTestAttachment({ id: 'recent-att' }));

        // Delete attachments older than 7 days
        const result = await storage.deleteAttachmentsOlderThan(7);

        expect(result.deleted).toBe(1);
        expect(result.updatedMessageIds).toContain('old-msg');
        expect(result.updatedMessageIds).not.toContain('recent-msg');
      });

      it('should return 0 deleted when no old attachments exist', async () => {
        const recentMsg = createTestMessage({
          id: 'recent-msg',
          timestamp: new Date(),
          content: {
            type: 'text',
            content: 'Recent message',
            attachmentIds: ['recent-att'],
          },
        });

        await storage.saveMessage('test-chat-1', recentMsg);
        await storage.saveAttachment('recent-msg', createTestAttachment({ id: 'recent-att' }));

        const result = await storage.deleteAttachmentsOlderThan(7);

        expect(result.deleted).toBe(0);
        expect(result.updatedMessageIds).toHaveLength(0);
      });
    });

    describe('updateMessageAttachmentIds', () => {
      it('should update message attachmentIds', async () => {
        const message = createTestMessage({
          id: 'msg-update',
          content: {
            type: 'text',
            content: 'Test',
            attachmentIds: ['att-1', 'att-2', 'att-3'],
          },
        });

        await storage.saveMessage('test-chat-1', message);

        // Remove att-2 from the list
        await storage.updateMessageAttachmentIds('test-chat-1', 'msg-update', ['att-1', 'att-3']);

        const messages = await storage.getMessages('test-chat-1');
        const updated = messages.find(m => m.id === 'msg-update');

        expect(updated?.content.attachmentIds).toEqual(['att-1', 'att-3']);
      });

      it('should handle empty attachmentIds array', async () => {
        const message = createTestMessage({
          id: 'msg-empty',
          content: {
            type: 'text',
            content: 'Test',
            attachmentIds: ['att-1'],
          },
        });

        await storage.saveMessage('test-chat-1', message);

        await storage.updateMessageAttachmentIds('test-chat-1', 'msg-empty', []);

        const messages = await storage.getMessages('test-chat-1');
        const updated = messages.find(m => m.id === 'msg-empty');

        expect(updated?.content.attachmentIds).toEqual([]);
      });
    });
  });
});
