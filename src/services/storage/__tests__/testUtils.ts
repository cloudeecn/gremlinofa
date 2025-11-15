/**
 * Test utilities for storage tests
 */

import { vi } from 'vitest';
import type {
  APIDefinition,
  Chat,
  Message,
  MessageAttachment,
  MessageContent,
  Project,
} from '../../../types';
import { APIType, MessageRole } from '../../../types';

/**
 * Factory functions for creating test data
 */

export function createTestAPIDefinition(overrides: Partial<APIDefinition> = {}): APIDefinition {
  return {
    id: 'test-api-def-1',
    name: 'Test API',
    apiType: APIType.ANTHROPIC,
    baseUrl: '',
    apiKey: 'test-api-key',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function createTestProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'test-project-1',
    name: 'Test Project',
    icon: '📁',
    apiDefinitionId: 'test-api-def-1',
    modelId: 'test-model',
    systemPrompt: '',
    preFillResponse: '',
    enableReasoning: false,
    reasoningBudgetTokens: 2048,
    webSearchEnabled: false,
    temperature: 0.4,
    maxOutputTokens: 2048,
    metadataTimestampMode: 'utc',
    metadataIncludeContextWindow: false,
    metadataIncludeCost: false,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    lastUsedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function createTestChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'test-chat-1',
    projectId: 'test-project-1',
    name: 'Test Chat',
    apiDefinitionId: null,
    modelId: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    lastModifiedAt: new Date('2024-01-01T00:00:00Z'),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCost: 0,
    sinkInputTokens: 0,
    sinkOutputTokens: 0,
    sinkReasoningTokens: 0,
    sinkCacheCreationTokens: 0,
    sinkCacheReadTokens: 0,
    sinkCost: 0,
    ...overrides,
  };
}

export function createTestMessage(overrides: Partial<Message<any>> = {}): Message<any> {
  const content: MessageContent<any> = {
    type: 'text',
    content: 'Test message',
  };

  return {
    id: 'test-message-1',
    role: MessageRole.USER,
    content,
    timestamp: new Date('2024-01-01T00:00:00Z'),
    metadata: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      messageCost: 0,
    },
    ...overrides,
  };
}

export function createTestAttachment(
  overrides: Partial<MessageAttachment> = {}
): MessageAttachment {
  return {
    id: 'test-attachment-1',
    type: 'image',
    mimeType: 'image/jpeg',
    data: 'base64encodeddata',
    ...overrides,
  };
}

/**
 * Create a mock storage adapter
 */
export function createMockAdapter() {
  const storage: Record<string, Record<string, any>> = {
    api_definitions: {},
    models_cache: {},
    projects: {},
    chats: {},
    messages: {},
    app_metadata: {},
  };

  return {
    initialize: vi.fn().mockResolvedValue(undefined),

    save: vi
      .fn()
      .mockImplementation(
        (table: string, id: string, encryptedData: string, metadata: any = {}) => {
          if (!storage[table]) {
            storage[table] = {};
          }
          storage[table][id] = {
            id,
            encryptedData,
            ...metadata,
          };
          return Promise.resolve();
        }
      ),

    get: vi.fn().mockImplementation((table: string, id: string) => {
      const record = storage[table]?.[id];
      if (!record) return Promise.resolve(null);

      return Promise.resolve({
        encryptedData: record.encryptedData,
        unencryptedData: record.unencryptedData,
      });
    }),

    query: vi.fn().mockImplementation((table: string, options: any = {}) => {
      if (!storage[table]) {
        storage[table] = {};
      }
      let records = Object.values(storage[table]);

      if (options.parentId) {
        records = records.filter((r: any) => r.parentId === options.parentId);
      }

      if (options.beforeTimestamp) {
        const beforeDate = new Date(options.beforeTimestamp);
        records = records.filter((r: any) => {
          if (!r.timestamp) return false;
          return new Date(r.timestamp) < beforeDate;
        });
      }

      if (options.orderDirection === 'asc') {
        records.sort((a: any, b: any) => {
          const aTime = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const bTime = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return aTime - bTime;
        });
      } else if (options.orderDirection === 'desc') {
        records.sort((a: any, b: any) => {
          const aTime = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const bTime = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return bTime - aTime;
        });
      }

      if (options.limit) {
        records = records.slice(0, options.limit);
      }

      return Promise.resolve(
        records.map((r: any) => ({
          encryptedData: r.encryptedData,
          unencryptedData: r.unencryptedData,
        }))
      );
    }),

    getAllRecords: vi.fn().mockImplementation((table: string) => {
      if (!storage[table]) {
        storage[table] = {};
      }
      return Promise.resolve(Object.values(storage[table]));
    }),

    delete: vi.fn().mockImplementation((table: string, id: string) => {
      if (storage[table]) {
        delete storage[table][id];
      }
      return Promise.resolve();
    }),

    deleteMany: vi.fn().mockImplementation((table: string, options: any = {}) => {
      if (options.parentId && storage[table]) {
        Object.keys(storage[table]).forEach(id => {
          if (storage[table][id].parentId === options.parentId) {
            delete storage[table][id];
          }
        });
      }
      return Promise.resolve();
    }),

    count: vi.fn().mockImplementation((table: string, options: any = {}) => {
      if (!storage[table]) {
        storage[table] = {};
      }
      let records = Object.values(storage[table]);
      if (options.parentId) {
        records = records.filter((r: any) => r.parentId === options.parentId);
      }
      return Promise.resolve(records.length);
    }),

    clear: vi.fn().mockImplementation(() => {
      Object.keys(storage).forEach(table => {
        storage[table] = {};
      });
      return Promise.resolve();
    }),

    clearAll: vi.fn().mockImplementation(() => {
      Object.keys(storage).forEach(table => {
        storage[table] = {};
      });
      return Promise.resolve();
    }),

    exportPaginated: vi.fn().mockImplementation((table: string, _afterId?: string) => {
      if (!storage[table]) {
        storage[table] = {};
      }
      const records = Object.values(storage[table]);
      return Promise.resolve({
        rows: records.map((r: any) => ({
          id: r.id,
          encryptedData: r.encryptedData,
          timestamp: r.timestamp,
          parentId: r.parentId,
          unencryptedData: r.unencryptedData,
        })),
        hasMore: false,
      });
    }),

    batchSave: vi.fn().mockImplementation((table: string, rows: any[], skipExisting: boolean) => {
      if (!storage[table]) {
        storage[table] = {};
      }
      let saved = 0;
      let skipped = 0;
      for (const row of rows) {
        if (skipExisting && storage[table][row.id]) {
          skipped++;
        } else {
          storage[table][row.id] = {
            id: row.id,
            encryptedData: row.encryptedData,
            timestamp: row.timestamp,
            parentId: row.parentId,
            unencryptedData: row.unencryptedData,
          };
          saved++;
        }
      }
      return Promise.resolve({ saved, skipped });
    }),

    batchGet: vi.fn().mockImplementation((table: string, ids: string[], _columns?: string[]) => {
      if (!storage[table]) {
        storage[table] = {};
      }
      const rows = ids
        .filter(id => storage[table][id])
        .map(id => {
          const r = storage[table][id];
          return {
            id: r.id,
            encryptedData: r.encryptedData,
            timestamp: r.timestamp,
            parentId: r.parentId,
            unencryptedData: r.unencryptedData,
          };
        });
      return Promise.resolve({ rows });
    }),

    // Expose internal storage for testing
    _getStorage: () => storage,
  };
}

/**
 * Create a mock encryption service
 */
export function createMockEncryptionService() {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    isInitialized: vi.fn().mockReturnValue(true),
    encrypt: vi.fn().mockImplementation((data: string) => Promise.resolve(`encrypted:${data}`)),
    decrypt: vi.fn().mockImplementation((data: string) => {
      if (!data || typeof data !== 'string') {
        throw new Error('Invalid encrypted data: data is not a string');
      }
      if (data.startsWith('encrypted:')) {
        return Promise.resolve(data.replace('encrypted:', ''));
      }
      throw new Error('Invalid encrypted data');
    }),
    encryptWithCompression: vi
      .fn()
      .mockImplementation((data: string) => Promise.resolve(`compressed:${data}`)),
    decryptWithDecompression: vi.fn().mockImplementation((data: string) => {
      if (!data || typeof data !== 'string') {
        throw new Error('Invalid encrypted data: data is not a string');
      }
      if (data.startsWith('compressed:')) {
        return Promise.resolve(data.replace('compressed:', ''));
      }
      if (data.startsWith('encrypted:')) {
        return Promise.resolve(data.replace('encrypted:', ''));
      }
      throw new Error('Invalid encrypted data');
    }),
    getCEK: vi.fn().mockReturnValue('abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst'),
    clearCEK: vi.fn().mockResolvedValue(undefined),
    importCEK: vi.fn().mockResolvedValue(true),
    hasCEK: vi.fn().mockReturnValue(true),
    deriveUserId: vi
      .fn()
      .mockResolvedValue('a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd'),
  };
}
