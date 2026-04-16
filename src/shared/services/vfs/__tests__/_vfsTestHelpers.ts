/**
 * Shared in-memory storage + encryption stubs for VFS tests.
 *
 * Phase 4 follow-up: the previous incarnation of these tests mocked the
 * `services/storage` and `services/encryption/encryptionService` modules
 * via `vi.mock` and reached for the deleted `storage` / `encryptionService`
 * singletons through them. With those gone, each test constructs a
 * `vfsService` directly via `createVfsService(stubStorage, stubEncryption)`
 * and the helpers below provide the in-memory backing the original mocks
 * used to expose. The returned `mockStorage` Map is shared with the
 * caller so tests can clear it in `beforeEach` and inspect rows.
 */

import { vi } from 'vitest';

export function buildStubVfsDeps() {
  const mockStorage = new Map<string, Map<string, { encryptedData: string; parentId?: string }>>();

  const stubStorage = {
    getAdapter: () => ({
      get: vi.fn(async (table: string, id: string) => {
        return mockStorage.get(table)?.get(id) || null;
      }),
      save: vi.fn(
        async (
          table: string,
          id: string,
          encryptedData: string,
          metadata: { parentId?: string }
        ) => {
          if (!mockStorage.has(table)) mockStorage.set(table, new Map());
          mockStorage.get(table)!.set(id, { encryptedData, parentId: metadata.parentId });
        }
      ),
      delete: vi.fn(async (table: string, id: string) => {
        mockStorage.get(table)?.delete(id);
      }),
      deleteMany: vi.fn(async (table: string, filters: { parentId?: string }) => {
        const tableMap = mockStorage.get(table);
        if (!tableMap || !filters.parentId) return;
        for (const [id, record] of tableMap.entries()) {
          if (record.parentId === filters.parentId) tableMap.delete(id);
        }
      }),
    }),
  };

  const stubEncryption = {
    encryptWithCompression: vi.fn(async (data: string) => `encrypted:${data}`),
    decryptWithDecompression: vi.fn(async (data: string) => {
      if (data.startsWith('encrypted:')) return data.slice(10);
      throw new Error('Invalid encrypted data');
    }),
  };

  return { stubStorage, stubEncryption, mockStorage };
}
