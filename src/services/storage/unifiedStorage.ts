/**
 * Unified Storage Service
 * Provides high-level API for all data operations
 * Uses platform-specific adapters (IndexedDB, Core Data, SQLite)
 */

import type {
  APIDefinition,
  AttachmentSection,
  Chat,
  Message,
  MessageAttachment,
  Model,
  Project,
} from '../../types';
import { clearAllDrafts } from '../../hooks/useDraftPersistence';
import { generateUniqueId } from '../../utils/idGenerator';
import { encryptionService } from '../encryption/encryptionService';
import { type StorageAdapter, Tables } from './StorageAdapter';
import { getStorageConfig } from './storageConfig';
import { RemoteStorageAdapter } from './adapters/RemoteStorageAdapter';

export class UnifiedStorage {
  private adapter: StorageAdapter;
  private initialized = false;

  constructor(adapter: StorageAdapter) {
    this.adapter = adapter;
  }

  /**
   * Get the storage adapter for direct access (e.g., import/export)
   */
  getAdapter(): StorageAdapter {
    return this.adapter;
  }

  /**
   * Check if storage is empty (no projects, chats, or messages)
   * Used to determine if migration mode should be offered
   */
  async isStorageEmpty(): Promise<boolean> {
    const projectCount = await this.adapter.count(Tables.PROJECTS);
    const chatCount = await this.adapter.count(Tables.CHATS);
    const messageCount = await this.adapter.count(Tables.MESSAGES);

    return projectCount === 0 && chatCount === 0 && messageCount === 0;
  }

  /**
   * Purge all data - delete database and CEK, then re-initialize
   * WARNING: This is irreversible!
   */
  async purgeAllData(): Promise<void> {
    console.debug('[Storage] Purging all data...');

    // Clear all drafts from localStorage first
    clearAllDrafts();
    console.debug('[Storage] Drafts cleared');

    // Clear all database tables
    await this.adapter.clearAll();
    console.debug('[Storage] Database cleared');

    // Clear CEK (localStorage on web)
    await encryptionService.clearCEK();
    console.debug('[Storage] CEK cleared');

    // Reset initialization flag
    this.initialized = false;
    console.debug('[Storage] Reset initialization flag');

    // Re-initialize with fresh data
    await this.initialize();
    console.debug('[Storage] Re-initialized with defaults');
  }

  /**
   * Initialize storage
   * Checks storage config and creates appropriate adapter (local or remote)
   */
  async initialize(): Promise<void> {
    console.debug('[Storage] Starting initialization...');
    if (this.initialized) {
      console.debug('[Storage] Already initialized, skipping');
      return;
    }

    // Initialize encryption service first (generates or loads CEK from localStorage)
    // This must happen before we can derive userId for remote storage
    console.debug('[Storage] Initializing encryption service...');
    await encryptionService.initialize();
    console.debug('[Storage] Encryption service initialized');

    // Check storage configuration and potentially switch adapter
    const config = getStorageConfig();
    console.debug('[Storage] Storage config:', config.type);

    if (config.type === 'remote') {
      // For remote storage, derive userId from CEK and create RemoteStorageAdapter
      console.debug('[Storage] Setting up remote storage adapter...');
      const userId = await encryptionService.deriveUserId();
      this.adapter = new RemoteStorageAdapter(config.baseUrl, userId, config.password);
      console.debug('[Storage] Remote storage adapter created');
    }

    // Initialize adapter (IndexedDB or RemoteStorage)
    console.debug('[Storage] Initializing adapter...');
    await this.adapter.initialize();
    console.debug('[Storage] Adapter initialized');

    // Migrate old memory data to VFS (idempotent, skips if no old data)
    // Use dynamic import to avoid circular dependency: unifiedStorage -> migration -> vfsService -> storage
    console.debug('[Storage] Running VFS migration...');
    const { migrateAllMemories } = await import('../vfs/migration');
    await migrateAllMemories(this.adapter);
    console.debug('[Storage] VFS migration complete');

    // Create default API definitions if needed
    console.debug('[Storage] Initializing default API definitions...');
    await this.initializeDefaults();
    console.debug('[Storage] Default API definitions initialized');

    this.initialized = true;
    console.debug('[Storage] Initialization complete!');
  }

  /**
   * Encrypt data
   */
  async encrypt(data: unknown): Promise<string> {
    const json = JSON.stringify(data);
    return encryptionService.encrypt(json);
  }

  /**
   * Decrypt data
   */
  async decrypt<T>(encrypted: string): Promise<T> {
    const json = await encryptionService.decrypt(encrypted);
    return JSON.parse(json);
  }

  // ===== API Definitions =====

  async getAPIDefinitions(): Promise<APIDefinition[]> {
    const records = await this.adapter.query(Tables.API_DEFINITIONS, {
      orderBy: 'timestamp',
      orderDirection: 'desc',
    });

    const definitions: APIDefinition[] = [];
    for (const record of records) {
      try {
        const def = await this.decrypt<APIDefinition>(record.encryptedData);
        definitions.push({
          ...def,
          createdAt: new Date(def.createdAt),
          updatedAt: new Date(def.updatedAt),
        });
      } catch (error) {
        console.error('Failed to decrypt API definition:', error);
      }
    }

    return definitions;
  }

  async getAPIDefinition(id: string): Promise<APIDefinition | null> {
    const record = await this.adapter.get(Tables.API_DEFINITIONS, id);
    if (!record) return null;

    try {
      const def = await this.decrypt<APIDefinition>(record.encryptedData);
      return {
        ...def,
        createdAt: new Date(def.createdAt),
        updatedAt: new Date(def.updatedAt),
      };
    } catch (error) {
      console.error('Failed to decrypt API definition:', error);
      return null;
    }
  }

  async saveAPIDefinition(definition: APIDefinition): Promise<void> {
    const data = {
      ...definition,
      createdAt: definition.createdAt.toISOString(),
      updatedAt: definition.updatedAt.toISOString(),
    };

    const encrypted = await this.encrypt(data);
    await this.adapter.save(Tables.API_DEFINITIONS, definition.id, encrypted, {
      timestamp: definition.updatedAt.toISOString(),
    });
  }

  async deleteAPIDefinition(id: string): Promise<void> {
    await this.adapter.delete(Tables.API_DEFINITIONS, id);
    // Also delete associated models cache
    await this.adapter.delete(Tables.MODELS_CACHE, id);
  }

  // ===== Models Cache =====

  async getModels(apiDefinitionId: string): Promise<Model[]> {
    const record = await this.adapter.get(Tables.MODELS_CACHE, apiDefinitionId);
    if (!record) return [];

    try {
      const data = await this.decrypt<{ models: Model[] }>(record.encryptedData);
      return data.models || [];
    } catch (error) {
      console.error('Failed to decrypt models:', error);
      return [];
    }
  }

  async saveModels(apiDefinitionId: string, models: Model[]): Promise<void> {
    const data = { models };
    const encrypted = await this.encrypt(data);
    const cachedAt = new Date().toISOString();

    await this.adapter.save(Tables.MODELS_CACHE, apiDefinitionId, encrypted, {
      timestamp: cachedAt,
    });
  }

  async deleteModels(apiDefinitionId: string): Promise<void> {
    await this.adapter.delete(Tables.MODELS_CACHE, apiDefinitionId);
  }

  // ===== Projects =====

  async getProjects(): Promise<Project[]> {
    const records = await this.adapter.query(Tables.PROJECTS, {
      orderBy: 'timestamp',
      orderDirection: 'desc',
    });

    const projects: Project[] = [];
    for (const record of records) {
      try {
        const proj = await this.decrypt<Project>(record.encryptedData);
        projects.push({
          ...proj,
          createdAt: new Date(proj.createdAt),
          lastUsedAt: new Date(proj.lastUsedAt),
        });
      } catch (error) {
        console.error('Failed to decrypt project:', error);
      }
    }

    return projects;
  }

  async getProject(id: string): Promise<Project | null> {
    const record = await this.adapter.get(Tables.PROJECTS, id);
    if (!record) return null;

    try {
      const proj = await this.decrypt<Project>(record.encryptedData);
      return {
        ...proj,
        createdAt: new Date(proj.createdAt),
        lastUsedAt: new Date(proj.lastUsedAt),
      };
    } catch (error) {
      console.error('Failed to decrypt project:', error);
      return null;
    }
  }

  async saveProject(project: Project): Promise<void> {
    const data = {
      ...project,
      createdAt: project.createdAt.toISOString(),
      lastUsedAt: project.lastUsedAt.toISOString(),
    };

    const encrypted = await this.encrypt(data);
    await this.adapter.save(Tables.PROJECTS, project.id, encrypted, {
      timestamp: project.lastUsedAt.toISOString(),
    });
  }

  async deleteProject(id: string): Promise<void> {
    // Delete all chats in project (which will cascade to messages)
    const chats = await this.getChats(id);
    for (const chat of chats) {
      await this.deleteChat(chat.id);
    }

    // Delete VFS data for this project
    await this.deleteVfsData(id);

    // Delete project
    await this.adapter.delete(Tables.PROJECTS, id);
  }

  /**
   * Delete all VFS data for a project (vfs_meta, vfs_files, vfs_versions)
   * Called during project deletion to clean up the virtual filesystem
   */
  private async deleteVfsData(projectId: string): Promise<void> {
    // Delete VFS metadata (tree structure)
    const metaId = `vfs_meta_${projectId}`;
    await this.adapter.delete(Tables.VFS_META, metaId);

    // Get all vfs_files for this project to find their versions
    const files: { id: string }[] = [];
    let afterId: string | undefined;
    while (true) {
      const page = await this.adapter.exportPaginated(Tables.VFS_FILES, afterId, [
        'id',
        'parentId',
      ]);
      for (const row of page.rows) {
        if (row.parentId === projectId && row.id) {
          files.push({ id: row.id });
        }
      }
      if (!page.hasMore) break;
      afterId = page.rows[page.rows.length - 1]?.id;
    }

    // Delete all versions for each file, then delete the file
    for (const file of files) {
      await this.adapter.deleteMany(Tables.VFS_VERSIONS, { parentId: file.id });
      await this.adapter.delete(Tables.VFS_FILES, file.id);
    }
  }

  // ===== Chats =====

  async getChats(projectId: string): Promise<Chat[]> {
    const records = await this.adapter.query(Tables.CHATS, {
      parentId: projectId,
      orderBy: 'timestamp',
      orderDirection: 'desc',
    });

    const chats: Chat[] = [];
    for (const record of records) {
      try {
        const chat = await this.decrypt<Chat>(record.encryptedData);
        chats.push({
          ...chat,
          createdAt: new Date(chat.createdAt),
          lastModifiedAt: new Date(chat.lastModifiedAt),
        });
      } catch (error) {
        console.error('Failed to decrypt chat:', error);
      }
    }

    return chats;
  }

  async getChat(id: string): Promise<Chat | null> {
    const record = await this.adapter.get(Tables.CHATS, id);
    if (!record) return null;

    try {
      const chat = await this.decrypt<Chat>(record.encryptedData);

      return {
        ...chat,
        createdAt: new Date(chat.createdAt),
        lastModifiedAt: new Date(chat.lastModifiedAt),
      };
    } catch (error) {
      console.error('Failed to decrypt chat:', error);
      return null;
    }
  }

  async saveChat(chat: Chat): Promise<void> {
    const data = {
      ...chat,
      createdAt: chat.createdAt.toISOString(),
      lastModifiedAt: chat.lastModifiedAt.toISOString(),
    };

    const encrypted = await this.encrypt(data);
    await this.adapter.save(Tables.CHATS, chat.id, encrypted, {
      timestamp: chat.lastModifiedAt.toISOString(),
      parentId: chat.projectId,
    });
  }

  async deleteChat(id: string): Promise<void> {
    // Get all messages first to delete their attachments
    const messages = await this.getMessages(id);
    for (const msg of messages) {
      await this.deleteAttachments(msg.id);
    }

    // Delete all messages in chat
    await this.adapter.deleteMany(Tables.MESSAGES, { parentId: id });

    // Delete chat
    await this.adapter.delete(Tables.CHATS, id);
  }

  async moveChat(chatId: string, targetProjectId: string): Promise<void> {
    const chat = await this.getChat(chatId);
    if (!chat) return;

    chat.projectId = targetProjectId;
    chat.lastModifiedAt = new Date();
    await this.saveChat(chat);
  }

  async cloneChat(
    chatId: string,
    targetProjectId: string,
    upToMessageId?: string,
    forkMessageContent?: string
  ): Promise<Chat | null> {
    const sourceChat = await this.getChat(chatId);
    if (!sourceChat) return null;

    // Copy messages first to calculate context window
    const messages = await this.getMessages(chatId);
    const messagesToCopy = upToMessageId
      ? messages.slice(
          0,
          messages.findIndex(m => m.id === upToMessageId)
        )
      : messages;

    // Recalculate context window usage from copied messages
    let contextWindowUsage = 0;
    for (let i = messagesToCopy.length - 1; i >= 0; i--) {
      const msg = messagesToCopy[i];
      if (msg.role === 'assistant' && msg.metadata?.contextWindowUsage !== undefined) {
        contextWindowUsage = msg.metadata.contextWindowUsage;
        break;
      }
    }

    // Create new chat with copied totals and recalculated context window
    const newChat: Chat = {
      ...sourceChat,
      id: generateUniqueId('chat'),
      projectId: targetProjectId,
      createdAt: new Date(),
      lastModifiedAt: new Date(),
      // Copy totals as-is (cumulative, never decrease)
      totalInputTokens: sourceChat.totalInputTokens,
      totalOutputTokens: sourceChat.totalOutputTokens,
      totalReasoningTokens: sourceChat.totalReasoningTokens,
      totalCacheCreationTokens: sourceChat.totalCacheCreationTokens,
      totalCacheReadTokens: sourceChat.totalCacheReadTokens,
      totalCost: sourceChat.totalCost,
      // Recalculate context window from copied messages
      contextWindowUsage: contextWindowUsage,
      // DO NOT copy deprecated sink costs
      sinkInputTokens: undefined,
      sinkOutputTokens: undefined,
      sinkReasoningTokens: undefined,
      sinkCacheCreationTokens: undefined,
      sinkCacheReadTokens: undefined,
      sinkCost: undefined,
      // Set fork tracking fields
      isForked: true,
      forkedFromChatId: chatId,
      forkedFromMessageId: upToMessageId, // Original message ID where fork occurred (undefined if copying all)
      // Add pending state for fork message
      pendingState: forkMessageContent
        ? {
            type: 'forkMessage',
            content: {
              message: forkMessageContent,
            },
          }
        : undefined,
    };

    await this.saveChat(newChat);

    // Copy messages and their attachments
    let lastNewMessageId: string | undefined;
    for (const msg of messagesToCopy) {
      const newMsgId = generateUniqueId('msg');
      const newMsg: Message<unknown> = {
        ...msg,
        id: newMsgId,
      };
      await this.saveMessage(newChat.id, newMsg);
      lastNewMessageId = newMsgId;

      // Copy attachments if the message has any
      if (msg.content.attachmentIds?.length) {
        const attachments = await this.getAttachments(msg.id);
        for (const attachment of attachments) {
          const newAttachment: MessageAttachment = {
            ...attachment,
            id: generateUniqueId('att'),
          };
          await this.saveAttachment(newMsgId, newAttachment);
        }

        // Update the message's attachmentIds with new IDs
        const newAttachments = await this.getAttachments(newMsgId);
        newMsg.content.attachmentIds = newAttachments.map(att => att.id);
        await this.saveMessage(newChat.id, newMsg);
      }
    }

    // Update the chat with the last copied message ID
    if (lastNewMessageId) {
      newChat.forkedAtMessageId = lastNewMessageId;
      await this.saveChat(newChat);
    }

    return newChat;
  }

  // ===== Messages =====

  async getMessages(chatId: string): Promise<Message<unknown>[]> {
    const records = await this.adapter.query(Tables.MESSAGES, {
      parentId: chatId,
      orderBy: 'timestamp',
      orderDirection: 'asc',
    });

    const messages: Message<unknown>[] = [];
    for (const record of records) {
      try {
        // Automatically detects and decompresses if "GZ" prefix present
        const decrypted = await encryptionService.decryptWithDecompression(record.encryptedData);
        const msg = JSON.parse(decrypted);
        messages.push({
          ...msg,
          timestamp: new Date(msg.timestamp),
        });
      } catch (error) {
        console.error('Failed to decrypt/decompress message:', error);
      }
    }

    return messages;
  }

  async saveMessage(chatId: string, message: Message<unknown>): Promise<void> {
    const data = {
      ...message,
      timestamp: message.timestamp.toISOString(),
    };

    // Use compression for all new messages
    const encrypted = await encryptionService.encryptWithCompression(JSON.stringify(data), true);
    await this.adapter.save(Tables.MESSAGES, message.id, encrypted, {
      timestamp: message.timestamp.toISOString(),
      parentId: chatId,
    });

    // Update chat's lastModifiedAt
    const chat = await this.getChat(chatId);
    if (chat) {
      chat.lastModifiedAt = new Date();
      await this.saveChat(chat);
    }
  }

  async deleteMessagesAfter(chatId: string, messageId: string): Promise<void> {
    const messages = await this.getMessages(chatId);
    const index = messages.findIndex(m => m.id === messageId);

    if (index === -1) return;

    // Delete messages after the specified message
    const toDelete = messages.slice(index + 1);
    for (const msg of toDelete) {
      await this.adapter.delete(Tables.MESSAGES, msg.id);
    }
  }

  async deleteMessageAndAfter(chatId: string, messageId: string): Promise<void> {
    const messages = await this.getMessages(chatId);
    const index = messages.findIndex(m => m.id === messageId);

    if (index === -1) return;

    // Delete messages and their attachments (no sink cost updates - deprecated)
    const toDelete = messages.slice(index);
    for (const msg of toDelete) {
      await this.deleteAttachments(msg.id);
      await this.adapter.delete(Tables.MESSAGES, msg.id);
    }
  }

  async getMessageCount(chatId: string): Promise<number> {
    return this.adapter.count(Tables.MESSAGES, { parentId: chatId });
  }

  /**
   * Compress all uncompressed messages
   * Progress callback: (processed: number, total: number, chatName?: string) => void
   */
  async compressAllMessages(
    onProgress?: (processed: number, total: number, chatName?: string) => void
  ): Promise<{ total: number; compressed: number; skipped: number; errors: number }> {
    console.debug('[Storage] Starting bulk message compression...');

    let totalMessages = 0;
    let compressedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    // Get all chats
    const allProjects = await this.getProjects();
    const allChats: Chat[] = [];

    for (const project of allProjects) {
      const chats = await this.getChats(project.id);
      allChats.push(...chats);
    }

    console.debug(`[Storage] Found ${allChats.length} chats to process`);

    // Process each chat
    for (const chat of allChats) {
      console.debug(`[Storage] Processing chat: ${chat.name}`);

      // Get all messages in chat (this will decompress them)
      const messages = await this.getMessages(chat.id);

      totalMessages += messages.length;

      // Process each message
      for (const message of messages) {
        try {
          // Get the raw encrypted data to check if already compressed
          const record = await this.adapter.get(Tables.MESSAGES, message.id);
          if (!record) {
            console.debug(`[Storage] Message ${message.id} not found, skipping`);
            errorCount++;
            continue;
          }

          // Try to decrypt as bytes to check for GZ prefix
          // We use a try-catch to handle the private method access safely
          let isCompressed = false;
          try {
            // Use type assertion to access private method
            const encryptionSvc = encryptionService as unknown as {
              decryptToBytes: (ciphertext: string) => Promise<Uint8Array>;
            };
            if (typeof encryptionSvc.decryptToBytes === 'function') {
              const decryptedBytes = await encryptionSvc.decryptToBytes(record.encryptedData);
              isCompressed =
                decryptedBytes.length >= 2 && decryptedBytes[0] === 71 && decryptedBytes[1] === 90;
            }
          } catch (_err) {
            // If we can't check, assume not compressed and try to compress
            console.debug(`[Storage] Could not check compression status, will attempt compress`);
          }

          if (isCompressed) {
            // Already compressed, skip
            skippedCount++;
            console.debug(`[Storage] Message ${message.id} already compressed, skipping`);
          } else {
            // Not compressed - re-save with compression
            // Use adapter.save() directly to avoid updating chat.lastModifiedAt
            const data = {
              ...message,
              timestamp: message.timestamp.toISOString(),
            };
            const encrypted = await encryptionService.encryptWithCompression(
              JSON.stringify(data),
              true
            );
            await this.adapter.save(Tables.MESSAGES, message.id, encrypted, {
              timestamp: message.timestamp.toISOString(),
              parentId: chat.id,
            });

            compressedCount++;
            console.debug(`[Storage] Compressed message ${message.id}`);
          }

          // Report progress
          if (onProgress) {
            onProgress(compressedCount + skippedCount + errorCount, totalMessages, chat.name);
          }
        } catch (error) {
          console.error(`[Storage] Error processing message ${message.id}:`, error);
          errorCount++;

          if (onProgress) {
            onProgress(compressedCount + skippedCount + errorCount, totalMessages, chat.name);
          }
        }
      }
    }

    console.debug('[Storage] Bulk compression complete:', {
      total: totalMessages,
      compressed: compressedCount,
      skipped: skippedCount,
      errors: errorCount,
    });

    return {
      total: totalMessages,
      compressed: compressedCount,
      skipped: skippedCount,
      errors: errorCount,
    };
  }

  // ===== Attachments =====

  async saveAttachment(messageId: string, attachment: MessageAttachment): Promise<void> {
    const encrypted = await this.encrypt(attachment);
    await this.adapter.save(Tables.ATTACHMENTS, attachment.id, encrypted, {
      timestamp: new Date().toISOString(),
      parentId: messageId,
    });
  }

  async getAttachments(messageId: string): Promise<MessageAttachment[]> {
    const records = await this.adapter.query(Tables.ATTACHMENTS, {
      parentId: messageId,
      orderBy: 'timestamp',
      orderDirection: 'asc',
    });

    const attachments: MessageAttachment[] = [];
    for (const record of records) {
      try {
        const attachment = await this.decrypt<MessageAttachment>(record.encryptedData);
        attachments.push(attachment);
      } catch (error) {
        console.error('Failed to decrypt attachment:', error);
      }
    }

    return attachments;
  }

  async deleteAttachments(messageId: string): Promise<void> {
    await this.adapter.deleteMany(Tables.ATTACHMENTS, { parentId: messageId });
  }

  /**
   * Get all attachment sections grouped by chat
   * Uses optimized batch operations: attachment -> message -> chat -> project
   * No attachment/message decryption needed (uses metadata columns)
   * Sorted by chat timestamp descending (most recent first)
   */
  async getAllAttachmentSections(): Promise<AttachmentSection[]> {
    // Step 1: Get all attachments (id, parentId=messageId, timestamp) - no decryption
    const attachmentRows: Array<{ id: string; parentId: string; timestamp: string }> = [];
    let afterId: string | undefined;
    while (true) {
      const page = await this.adapter.exportPaginated(Tables.ATTACHMENTS, afterId, [
        'id',
        'parentId',
        'timestamp',
      ]);
      for (const row of page.rows) {
        if (row.id && row.parentId && row.timestamp) {
          attachmentRows.push({
            id: row.id,
            parentId: row.parentId,
            timestamp: row.timestamp,
          });
        }
      }
      if (!page.hasMore) break;
      afterId = page.rows[page.rows.length - 1]?.id;
    }

    if (attachmentRows.length === 0) {
      return [];
    }

    // Step 2: Get unique messageIds and fetch messages (id, parentId=chatId, timestamp)
    const uniqueMessageIds = [...new Set(attachmentRows.map(a => a.parentId))];
    const messagesResult = await this.adapter.batchGet(Tables.MESSAGES, uniqueMessageIds, [
      'id',
      'parentId',
      'timestamp',
    ]);

    // Build messageId -> { chatId, timestamp } map
    const messageMap = new Map<string, { chatId: string; timestamp: Date }>();
    for (const row of messagesResult.rows) {
      if (row.id && row.parentId && row.timestamp) {
        messageMap.set(row.id, {
          chatId: row.parentId,
          timestamp: new Date(row.timestamp),
        });
      }
    }

    // Step 3: Get unique chatIds and fetch chats (need to decrypt for name)
    const uniqueChatIds = [...new Set([...messageMap.values()].map(m => m.chatId))];
    const chatsResult = await this.adapter.batchGet(Tables.CHATS, uniqueChatIds, [
      'id',
      'parentId',
      'encryptedData',
      'timestamp',
    ]);

    // Build chatId -> { projectId, name, timestamp } map
    const chatMap = new Map<string, { projectId: string; name: string; timestamp: Date }>();
    for (const row of chatsResult.rows) {
      if (row.id && row.parentId && row.encryptedData) {
        try {
          const chat = await this.decrypt<Chat>(row.encryptedData);
          chatMap.set(row.id, {
            projectId: row.parentId,
            name: chat.name,
            timestamp: new Date(chat.lastModifiedAt),
          });
        } catch (error) {
          console.error('Failed to decrypt chat:', error);
        }
      }
    }

    // Step 4: Get unique projectIds and fetch projects (need to decrypt for name/icon)
    const uniqueProjectIds = [...new Set([...chatMap.values()].map(c => c.projectId))];
    const projectsResult = await this.adapter.batchGet(Tables.PROJECTS, uniqueProjectIds, [
      'id',
      'encryptedData',
    ]);

    // Build projectId -> { name, icon } map
    const projectMap = new Map<string, { name: string; icon: string }>();
    for (const row of projectsResult.rows) {
      if (row.id && row.encryptedData) {
        try {
          const project = await this.decrypt<Project>(row.encryptedData);
          projectMap.set(row.id, {
            name: project.name,
            icon: project.icon || '📁',
          });
        } catch (error) {
          console.error('Failed to decrypt project:', error);
        }
      }
    }

    // Step 5: Build sections grouped by chat
    const sectionMap = new Map<string, AttachmentSection>();

    for (const att of attachmentRows) {
      const messageInfo = messageMap.get(att.parentId);
      if (!messageInfo) continue;

      const chatInfo = chatMap.get(messageInfo.chatId);
      if (!chatInfo) continue;

      const projectInfo = projectMap.get(chatInfo.projectId);
      if (!projectInfo) continue;

      let section = sectionMap.get(messageInfo.chatId);
      if (!section) {
        section = {
          chatId: messageInfo.chatId,
          chatName: chatInfo.name,
          chatTimestamp: chatInfo.timestamp,
          projectId: chatInfo.projectId,
          projectName: projectInfo.name,
          projectIcon: projectInfo.icon,
          attachments: [],
        };
        sectionMap.set(messageInfo.chatId, section);
      }

      section.attachments.push({
        id: att.id,
        messageId: att.parentId,
        timestamp: messageInfo.timestamp,
      });
    }

    // Convert to array and sort by chat timestamp descending
    const sections = [...sectionMap.values()];
    sections.sort((a, b) => b.chatTimestamp.getTime() - a.chatTimestamp.getTime());

    return sections;
  }

  /**
   * Delete a single attachment by ID
   * Returns the messageId it belonged to (for updating message's attachmentIds)
   */
  async deleteAttachment(attachmentId: string): Promise<string | null> {
    // Find the attachment to get its parent messageId
    const projects = await this.getProjects();

    for (const project of projects) {
      const chats = await this.getChats(project.id);

      for (const chat of chats) {
        const messages = await this.getMessages(chat.id);

        for (const msg of messages) {
          if (msg.content.attachmentIds?.includes(attachmentId)) {
            // Found the message - delete the attachment
            await this.adapter.delete(Tables.ATTACHMENTS, attachmentId);
            return msg.id;
          }
        }
      }
    }

    return null;
  }

  /**
   * Delete attachments older than specified number of days
   * Returns count of deleted attachments and affected message IDs
   */
  async deleteAttachmentsOlderThan(
    days: number
  ): Promise<{ deleted: number; updatedMessageIds: string[] }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const sections = await this.getAllAttachmentSections();
    const attachmentsToDelete: { id: string; messageId: string }[] = [];

    for (const section of sections) {
      for (const att of section.attachments) {
        if (att.timestamp < cutoffDate) {
          attachmentsToDelete.push({ id: att.id, messageId: att.messageId });
        }
      }
    }

    // Group by messageId to track which messages need updating
    const messageIdSet = new Set<string>();
    for (const att of attachmentsToDelete) {
      await this.adapter.delete(Tables.ATTACHMENTS, att.id);
      messageIdSet.add(att.messageId);
    }

    return {
      deleted: attachmentsToDelete.length,
      updatedMessageIds: Array.from(messageIdSet),
    };
  }

  /**
   * Update a message's attachmentIds after attachment deletion
   */
  async updateMessageAttachmentIds(
    chatId: string,
    messageId: string,
    newAttachmentIds: string[]
  ): Promise<void> {
    const messages = await this.getMessages(chatId);
    const message = messages.find(m => m.id === messageId);

    if (message) {
      // Preserve originalAttachmentCount for old messages that don't have it
      // This ensures system notes work correctly after attachment deletion
      if (
        message.content.originalAttachmentCount === undefined &&
        message.content.attachmentIds?.length
      ) {
        message.content.originalAttachmentCount = message.content.attachmentIds.length;
      }
      message.content.attachmentIds = newAttachmentIds;
      // Use adapter directly to avoid updating chat's lastModifiedAt
      const data = {
        ...message,
        timestamp: message.timestamp.toISOString(),
      };
      const encrypted = await encryptionService.encryptWithCompression(JSON.stringify(data), true);
      await this.adapter.save(Tables.MESSAGES, message.id, encrypted, {
        timestamp: message.timestamp.toISOString(),
        parentId: chatId,
      });
    }
  }

  // ===== Metadata =====

  async getMetadata(key: string): Promise<string | null> {
    // Metadata is stored in unencryptedData field (not encrypted)
    const record = await this.adapter.get(Tables.METADATA, key);
    if (!record || !record.unencryptedData) return null;

    try {
      const data = JSON.parse(record.unencryptedData);
      return data.value || null;
    } catch {
      // Fallback - try the encryptedData field for legacy compatibility
      return record.encryptedData || null;
    }
  }

  async setMetadata(key: string, value: string): Promise<void> {
    // Store metadata in unencryptedData field (plaintext, not encrypted)
    const data = JSON.stringify({ value });
    // Use placeholder for encryptedData since SQLite requires NOT NULL
    await this.adapter.save(Tables.METADATA, key, '__METADATA__', {
      unencryptedData: data,
    });
  }

  // ===== Initialization =====

  async initializeDefaults(): Promise<void> {
    console.debug('[Storage] initializeDefaults: Getting existing definitions...');
    const apiTypes = [
      { apiType: 'responses_api', name: 'OpenAI Responses', baseUrl: '' },
      {
        apiType: 'responses_api',
        name: 'xAI Responses',
        baseUrl: 'https://api.x.ai/v1',
      },
      { apiType: 'anthropic', name: 'Anthropic Official', baseUrl: '' },
      { apiType: 'webllm', name: 'WebLLM (Local)', baseUrl: '' },
    ] as const;

    const existing = await this.getAPIDefinitions();
    console.debug(`[Storage] initializeDefaults: Found ${existing.length} existing definitions`);

    for (const { apiType, name, baseUrl } of apiTypes) {
      const exists = existing.find(def => def.name === name && def.isDefault);

      if (!exists) {
        console.debug(`[Storage] initializeDefaults: Creating default definition: ${name}`);
        const defaultDef: APIDefinition = {
          id: `api_default_${apiType}_${name.toLowerCase().replace(/\s+/g, '_')}`,
          apiType,
          name,
          baseUrl,
          apiKey: '',
          isDefault: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await this.saveAPIDefinition(defaultDef);
        console.debug(`[Storage] initializeDefaults: Saved ${name}`);
      } else {
        console.debug(`[Storage] initializeDefaults: ${name} already exists, skipping`);
      }
    }

    // Verify what was saved
    const finalCount = await this.getAPIDefinitions();
    console.debug(
      `[Storage] initializeDefaults: Complete! Total definitions: ${finalCount.length}`
    );
  }
}
