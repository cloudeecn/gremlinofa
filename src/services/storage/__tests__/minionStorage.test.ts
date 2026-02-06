/**
 * Unit tests for MinionChat storage operations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UnifiedStorage } from '../unifiedStorage';
import type { MinionChat } from '../../../types';
import {
  createMockAdapter,
  createMockEncryptionService,
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
    encryptWithCompression: vi.fn(),
    decryptWithDecompression: vi.fn(),
    getCEK: vi.fn(),
    clearCEK: vi.fn(),
  },
}));

function createTestMinionChat(overrides: Partial<MinionChat> = {}): MinionChat {
  return {
    id: 'minion-chat-1',
    parentChatId: 'test-chat-1',
    projectId: 'test-project-1',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    lastModifiedAt: new Date('2024-01-01T00:00:00Z'),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    ...overrides,
  };
}

describe('UnifiedStorage - Minion Chats', () => {
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

  describe('Minion Chat CRUD', () => {
    beforeEach(async () => {
      await storage.initialize();
      // Set up parent project and chat
      const project = createTestProject();
      const chat = createTestChat();
      await storage.saveProject(project);
      await storage.saveChat(chat);
    });

    it('should save a minion chat', async () => {
      const minionChat = createTestMinionChat();

      await storage.saveMinionChat(minionChat);

      expect(adapter.save).toHaveBeenCalledWith(
        'minion_chats',
        minionChat.id,
        expect.stringContaining('encrypted:'),
        expect.objectContaining({
          timestamp: expect.any(String),
          parentId: minionChat.parentChatId,
        })
      );
    });

    it('should get a minion chat by ID', async () => {
      const minionChat = createTestMinionChat();
      await storage.saveMinionChat(minionChat);

      const result = await storage.getMinionChat(minionChat.id);

      expect(result).toMatchObject({
        id: minionChat.id,
        parentChatId: minionChat.parentChatId,
        projectId: minionChat.projectId,
      });
    });

    it('should return null for non-existent minion chat', async () => {
      const result = await storage.getMinionChat('non-existent');

      expect(result).toBeNull();
    });

    it('should get all minion chats for a parent chat', async () => {
      const minionChat1 = createTestMinionChat({
        id: 'minion-1',
        lastModifiedAt: new Date('2024-01-01'),
      });
      const minionChat2 = createTestMinionChat({
        id: 'minion-2',
        lastModifiedAt: new Date('2024-01-02'),
      });

      await storage.saveMinionChat(minionChat1);
      await storage.saveMinionChat(minionChat2);

      const result = await storage.getMinionChats('test-chat-1');

      expect(result.length).toBe(2);
      // Should be ordered by lastModifiedAt descending
      expect(result[0].id).toBe('minion-2');
      expect(result[1].id).toBe('minion-1');
    });

    it('should return empty array when no minion chats exist', async () => {
      const result = await storage.getMinionChats('test-chat-1');

      expect(result).toEqual([]);
    });

    it('should delete a minion chat and its messages', async () => {
      const minionChat = createTestMinionChat();
      await storage.saveMinionChat(minionChat);

      // Save a message to the minion chat
      const message = createTestMessage({ id: 'minion-msg-1' });
      await storage.saveMinionMessage(minionChat.id, message);

      await storage.deleteMinionChat(minionChat.id);

      expect(adapter.deleteMany).toHaveBeenCalledWith('messages', { parentId: minionChat.id });
      expect(adapter.delete).toHaveBeenCalledWith('minion_chats', minionChat.id);
    });

    it('should convert dates to/from ISO strings correctly', async () => {
      const minionChat = createTestMinionChat({
        createdAt: new Date('2024-06-15T10:30:00Z'),
        lastModifiedAt: new Date('2024-06-15T12:45:00Z'),
      });
      await storage.saveMinionChat(minionChat);

      const result = await storage.getMinionChat(minionChat.id);

      expect(result?.createdAt).toBeInstanceOf(Date);
      expect(result?.lastModifiedAt).toBeInstanceOf(Date);
      expect(result?.createdAt.toISOString()).toBe('2024-06-15T10:30:00.000Z');
      expect(result?.lastModifiedAt.toISOString()).toBe('2024-06-15T12:45:00.000Z');
    });
  });

  describe('Minion Messages', () => {
    beforeEach(async () => {
      await storage.initialize();
      const project = createTestProject();
      const chat = createTestChat();
      const minionChat = createTestMinionChat();
      await storage.saveProject(project);
      await storage.saveChat(chat);
      await storage.saveMinionChat(minionChat);
    });

    it('should save a message to a minion chat', async () => {
      const message = createTestMessage({ id: 'minion-msg-1' });

      await storage.saveMinionMessage('minion-chat-1', message);

      // Messages use compression
      expect(adapter.save).toHaveBeenCalledWith(
        'messages',
        message.id,
        expect.stringContaining('compressed:'),
        expect.objectContaining({
          timestamp: expect.any(String),
          parentId: 'minion-chat-1',
        })
      );
    });

    it('should get messages for a minion chat', async () => {
      const msg1 = createTestMessage({ id: 'minion-msg-1' });
      const msg2 = createTestMessage({ id: 'minion-msg-2' });

      await storage.saveMinionMessage('minion-chat-1', msg1);
      await storage.saveMinionMessage('minion-chat-1', msg2);

      const result = await storage.getMinionMessages('minion-chat-1');

      expect(result.length).toBe(2);
    });

    it('should update minion chat lastModifiedAt when saving message', async () => {
      const message = createTestMessage({ id: 'minion-msg-1' });
      const originalMinionChat = await storage.getMinionChat('minion-chat-1');
      const originalTimestamp = originalMinionChat?.lastModifiedAt;

      // Small delay to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));

      await storage.saveMinionMessage('minion-chat-1', message);

      const updatedMinionChat = await storage.getMinionChat('minion-chat-1');
      expect(updatedMinionChat?.lastModifiedAt.getTime()).toBeGreaterThan(
        originalTimestamp?.getTime() || 0
      );
    });
  });

  describe('Cascade Deletion', () => {
    beforeEach(async () => {
      await storage.initialize();
      const project = createTestProject();
      const chat = createTestChat();
      await storage.saveProject(project);
      await storage.saveChat(chat);
    });

    it('should cascade delete minion chats when parent chat is deleted', async () => {
      // Create minion chats
      const minionChat1 = createTestMinionChat({ id: 'minion-1' });
      const minionChat2 = createTestMinionChat({ id: 'minion-2' });
      await storage.saveMinionChat(minionChat1);
      await storage.saveMinionChat(minionChat2);

      // Save messages to minion chats
      await storage.saveMinionMessage('minion-1', createTestMessage({ id: 'msg-m1' }));
      await storage.saveMinionMessage('minion-2', createTestMessage({ id: 'msg-m2' }));

      // Delete parent chat
      await storage.deleteChat('test-chat-1');

      // Verify minion chats and their messages were deleted
      expect(adapter.deleteMany).toHaveBeenCalledWith('messages', { parentId: 'minion-1' });
      expect(adapter.deleteMany).toHaveBeenCalledWith('messages', { parentId: 'minion-2' });
      expect(adapter.delete).toHaveBeenCalledWith('minion_chats', 'minion-1');
      expect(adapter.delete).toHaveBeenCalledWith('minion_chats', 'minion-2');
    });

    it('should cascade delete minion chats when project is deleted', async () => {
      // Create minion chat
      const minionChat = createTestMinionChat();
      await storage.saveMinionChat(minionChat);
      await storage.saveMinionMessage(minionChat.id, createTestMessage({ id: 'msg-m1' }));

      // Delete project (which deletes chat, which deletes minion chats)
      await storage.deleteProject('test-project-1');

      // Verify everything was deleted
      expect(adapter.delete).toHaveBeenCalledWith('minion_chats', minionChat.id);
      expect(adapter.delete).toHaveBeenCalledWith('chats', 'test-chat-1');
      expect(adapter.delete).toHaveBeenCalledWith('projects', 'test-project-1');
    });
  });

  describe('Token Tracking', () => {
    beforeEach(async () => {
      await storage.initialize();
      const project = createTestProject();
      const chat = createTestChat();
      await storage.saveProject(project);
      await storage.saveChat(chat);
    });

    it('should preserve token totals on minion chat', async () => {
      const minionChat = createTestMinionChat({
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalReasoningTokens: 200,
        totalCacheCreationTokens: 100,
        totalCacheReadTokens: 50,
        totalCost: 0.05,
        contextWindowUsage: 1500,
        costUnreliable: false,
      });

      await storage.saveMinionChat(minionChat);
      const result = await storage.getMinionChat(minionChat.id);

      expect(result?.totalInputTokens).toBe(1000);
      expect(result?.totalOutputTokens).toBe(500);
      expect(result?.totalReasoningTokens).toBe(200);
      expect(result?.totalCacheCreationTokens).toBe(100);
      expect(result?.totalCacheReadTokens).toBe(50);
      expect(result?.totalCost).toBe(0.05);
      expect(result?.contextWindowUsage).toBe(1500);
      expect(result?.costUnreliable).toBe(false);
    });
  });
});
