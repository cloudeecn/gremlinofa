/**
 * Unit tests for Storage Configuration Module
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getStorageConfig,
  setStorageConfig,
  clearStorageConfig,
  hashPassword,
  type StorageConfig,
} from '../storageConfig';

describe('storageConfig', () => {
  let mockStorage: Record<string, string>;
  let originalLocalStorage: Storage;

  beforeEach(() => {
    mockStorage = {};
    originalLocalStorage = global.localStorage;

    // Create a complete mock localStorage
    const mockLocalStorage = {
      getItem: vi.fn((key: string) => mockStorage[key] || null),
      setItem: vi.fn((key: string, value: string) => {
        mockStorage[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete mockStorage[key];
      }),
      clear: vi.fn(),
      length: 0,
      key: vi.fn(),
    } as unknown as Storage;

    Object.defineProperty(global, 'localStorage', {
      value: mockLocalStorage,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(global, 'localStorage', {
      value: originalLocalStorage,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  describe('getStorageConfig', () => {
    it('should return default local config when nothing stored', () => {
      const config = getStorageConfig();

      expect(config).toEqual({ type: 'local' });
    });

    it('should return stored local config', () => {
      mockStorage['gremlinofa_storage_config'] = JSON.stringify({ type: 'local' });

      const config = getStorageConfig();

      expect(config).toEqual({ type: 'local' });
    });

    it('should return stored remote config', () => {
      const remoteConfig: StorageConfig = {
        type: 'remote',
        baseUrl: 'https://example.com/storage',
        password: 'secret123',
        userId: 'test-user-id-64-chars-abcdef1234567890abcdef1234567890abcdef',
      };
      mockStorage['gremlinofa_storage_config'] = JSON.stringify(remoteConfig);

      const config = getStorageConfig();

      expect(config).toEqual(remoteConfig);
    });

    it('should return default on JSON parse error', () => {
      mockStorage['gremlinofa_storage_config'] = 'invalid json';
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const config = getStorageConfig();

      expect(config).toEqual({ type: 'local' });
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('setStorageConfig', () => {
    it('should store local config', () => {
      const config: StorageConfig = { type: 'local' };

      setStorageConfig(config);

      expect(mockStorage['gremlinofa_storage_config']).toBe(JSON.stringify(config));
    });

    it('should store remote config', () => {
      const config: StorageConfig = {
        type: 'remote',
        baseUrl: 'https://api.example.com',
        password: 'mypassword',
        userId: 'user-id-64-chars-abcdef1234567890abcdef1234567890abcdef1234',
      };

      setStorageConfig(config);

      expect(mockStorage['gremlinofa_storage_config']).toBe(JSON.stringify(config));
    });

    it('should overwrite existing config', () => {
      mockStorage['gremlinofa_storage_config'] = JSON.stringify({ type: 'local' });

      const newConfig: StorageConfig = {
        type: 'remote',
        baseUrl: 'https://new.example.com',
        password: '',
        userId: 'new-user-id-64-chars-bcdef1234567890abcdef1234567890abcdef12',
      };
      setStorageConfig(newConfig);

      expect(mockStorage['gremlinofa_storage_config']).toBe(JSON.stringify(newConfig));
    });
  });

  describe('clearStorageConfig', () => {
    it('should remove stored config', () => {
      mockStorage['gremlinofa_storage_config'] = JSON.stringify({ type: 'local' });

      clearStorageConfig();

      expect(mockStorage['gremlinofa_storage_config']).toBeUndefined();
    });

    it('should not error when nothing stored', () => {
      expect(() => clearStorageConfig()).not.toThrow();
    });
  });

  describe('hashPassword', () => {
    it('should return empty string for empty password', async () => {
      const result = await hashPassword('');
      expect(result).toBe('');
    });

    it('should return 128-character hex string for non-empty password', async () => {
      const result = await hashPassword('test-password');
      expect(result).toHaveLength(128); // SHA-512 = 512 bits = 64 bytes = 128 hex chars
      expect(result).toMatch(/^[0-9a-f]+$/);
    });

    it('should produce deterministic output for same input', async () => {
      const result1 = await hashPassword('my-secret');
      const result2 = await hashPassword('my-secret');
      expect(result1).toBe(result2);
    });

    it('should produce different output for different inputs', async () => {
      const result1 = await hashPassword('password1');
      const result2 = await hashPassword('password2');
      expect(result1).not.toBe(result2);
    });

    it('should include salt in hash (same password without salt would differ)', async () => {
      // The hash is of `${password}|gremlinofa`, so it's salted
      // We can verify by computing the expected hash manually
      const password = 'test';
      const result = await hashPassword(password);

      // Compute expected hash: SHA-512 of "test|gremlinofa"
      const expectedInput = `${password}|gremlinofa`;
      const data = new TextEncoder().encode(expectedInput);
      const hashBuffer = await crypto.subtle.digest('SHA-512', data);
      const expected = Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      expect(result).toBe(expected);
    });
  });
});
