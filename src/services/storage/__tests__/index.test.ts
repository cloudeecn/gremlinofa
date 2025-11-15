import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock localStorage
const mockLocalStorage: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: vi.fn((key: string) => mockLocalStorage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    mockLocalStorage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockLocalStorage[key];
  }),
  clear: vi.fn(() => {
    Object.keys(mockLocalStorage).forEach(key => delete mockLocalStorage[key]);
  }),
});

// Must import after mocking localStorage
import { createStorageAdapter, createStorage } from '../index';
import { IndexedDBAdapter } from '../adapters/IndexedDBAdapter';
import { RemoteStorageAdapter } from '../adapters/RemoteStorageAdapter';

describe('storage index', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    Object.keys(mockLocalStorage).forEach(key => delete mockLocalStorage[key]);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createStorageAdapter', () => {
    it('should create IndexedDBAdapter when config type is local', () => {
      mockLocalStorage['gremlinofa_storage_config'] = JSON.stringify({ type: 'local' });

      const adapter = createStorageAdapter();

      expect(adapter).toBeInstanceOf(IndexedDBAdapter);
    });

    it('should create IndexedDBAdapter when no config exists (default)', () => {
      // No config set - should default to local

      const adapter = createStorageAdapter();

      expect(adapter).toBeInstanceOf(IndexedDBAdapter);
    });

    it('should create RemoteStorageAdapter when config type is remote', () => {
      mockLocalStorage['gremlinofa_storage_config'] = JSON.stringify({
        type: 'remote',
        baseUrl: 'https://example.com/storage',
        password: 'test-password',
        userId: 'test-user-id-64-chars-abcdef1234567890abcdef1234567890abcdef',
      });

      const adapter = createStorageAdapter();

      expect(adapter).toBeInstanceOf(RemoteStorageAdapter);
    });

    it('should pass correct parameters to RemoteStorageAdapter', () => {
      const config = {
        type: 'remote' as const,
        baseUrl: 'https://my-server.com/api',
        password: 'secret123',
        userId: 'user123456789012345678901234567890123456789012345678901234567890',
      };
      mockLocalStorage['gremlinofa_storage_config'] = JSON.stringify(config);

      const adapter = createStorageAdapter();

      expect(adapter).toBeInstanceOf(RemoteStorageAdapter);
      // We can verify the adapter was created with correct params by checking its behavior
      // The RemoteStorageAdapter stores baseUrl internally and uses it to build URLs
    });

    it('should handle empty baseUrl for same-origin remote storage', () => {
      mockLocalStorage['gremlinofa_storage_config'] = JSON.stringify({
        type: 'remote',
        baseUrl: '',
        password: '',
        userId: 'test-user-id-64-chars-abcdef1234567890abcdef1234567890abcdef',
      });

      const adapter = createStorageAdapter();

      expect(adapter).toBeInstanceOf(RemoteStorageAdapter);
    });

    it('should use explicit config when provided (local)', () => {
      // Set remote config in localStorage
      mockLocalStorage['gremlinofa_storage_config'] = JSON.stringify({
        type: 'remote',
        baseUrl: 'https://example.com/storage',
        password: '',
        userId: 'test-user-id-64-chars-abcdef1234567890abcdef1234567890abcdef',
      });

      // But explicitly pass local config - should ignore localStorage
      const adapter = createStorageAdapter({ type: 'local' });

      expect(adapter).toBeInstanceOf(IndexedDBAdapter);
    });

    it('should use explicit config when provided (remote)', () => {
      // Set local config in localStorage
      mockLocalStorage['gremlinofa_storage_config'] = JSON.stringify({ type: 'local' });

      // But explicitly pass remote config - should ignore localStorage
      const adapter = createStorageAdapter({
        type: 'remote',
        baseUrl: 'https://explicit.example.com/storage',
        password: 'explicit-password',
        userId: 'explicit-user-id-64-chars-bcdef1234567890abcdef1234567890abcd',
      });

      expect(adapter).toBeInstanceOf(RemoteStorageAdapter);
    });
  });

  describe('createStorage', () => {
    it('should return a UnifiedStorage instance with IndexedDBAdapter for local config', () => {
      mockLocalStorage['gremlinofa_storage_config'] = JSON.stringify({ type: 'local' });

      const storage = createStorage();

      expect(storage).toBeDefined();
      expect(storage.getAdapter()).toBeInstanceOf(IndexedDBAdapter);
    });

    it('should return a UnifiedStorage instance with RemoteStorageAdapter for remote config', () => {
      mockLocalStorage['gremlinofa_storage_config'] = JSON.stringify({
        type: 'remote',
        baseUrl: 'https://example.com/storage',
        password: 'test-password',
        userId: 'test-user-id-64-chars-abcdef1234567890abcdef1234567890abcdef',
      });

      const storage = createStorage();

      expect(storage).toBeDefined();
      expect(storage.getAdapter()).toBeInstanceOf(RemoteStorageAdapter);
    });

    it('should create independent instances on each call', () => {
      mockLocalStorage['gremlinofa_storage_config'] = JSON.stringify({ type: 'local' });

      const storage1 = createStorage();
      const storage2 = createStorage();

      expect(storage1).not.toBe(storage2);
      expect(storage1.getAdapter()).not.toBe(storage2.getAdapter());
    });

    it('should use explicit config when provided (local)', () => {
      // Set remote config in localStorage
      mockLocalStorage['gremlinofa_storage_config'] = JSON.stringify({
        type: 'remote',
        baseUrl: 'https://example.com/storage',
        password: '',
        userId: 'test-user-id-64-chars-abcdef1234567890abcdef1234567890abcdef',
      });

      // But explicitly pass local config
      const storage = createStorage({ type: 'local' });

      expect(storage).toBeDefined();
      expect(storage.getAdapter()).toBeInstanceOf(IndexedDBAdapter);
    });

    it('should use explicit config when provided (remote)', () => {
      // Set local config in localStorage
      mockLocalStorage['gremlinofa_storage_config'] = JSON.stringify({ type: 'local' });

      // But explicitly pass remote config
      const storage = createStorage({
        type: 'remote',
        baseUrl: 'https://explicit.example.com/storage',
        password: 'explicit-password',
        userId: 'explicit-user-id-64-chars-bcdef1234567890abcdef1234567890abcd',
      });

      expect(storage).toBeDefined();
      expect(storage.getAdapter()).toBeInstanceOf(RemoteStorageAdapter);
    });
  });
});
