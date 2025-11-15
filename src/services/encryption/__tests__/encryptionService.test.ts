import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EncryptionService, encryptionService } from '../encryptionService';
import { Buffer } from 'buffer';

describe('EncryptionService', () => {
  beforeEach(async () => {
    // Clear localStorage mock
    global.localStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      length: 0,
      key: vi.fn(),
    } as unknown as Storage;
  });

  afterEach(async () => {
    // Clean up
    await encryptionService.clearCEK();
  });

  describe('initialize', () => {
    it('should initialize successfully and generate and store CEK on first initialization', async () => {
      const setItemSpy = vi.spyOn(global.localStorage, 'setItem');

      await encryptionService.initialize();

      expect(setItemSpy).toHaveBeenCalled();
      expect(encryptionService.isInitialized()).toBe(true);
    });

    it('should generate CEK in base32 format', async () => {
      const storage: Record<string, string> = {};
      vi.spyOn(global.localStorage, 'getItem').mockImplementation(
        (key: string) => storage[key] || null
      );
      vi.spyOn(global.localStorage, 'setItem').mockImplementation((key: string, value: string) => {
        storage[key] = value;
        return undefined;
      });

      await encryptionService.initialize();

      const storedCEK = storage['chatbot_cek'];
      expect(storedCEK).toBeDefined();
      // Base32 lowercase contains only a-z and 2-7
      expect(storedCEK).toMatch(/^[a-z2-7]+$/);
      // 32 bytes = 52 characters in base32
      expect(storedCEK.length).toBe(52);
    });

    it('should use cached CEK on subsequent initializations', async () => {
      const existingCEK = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 52 chars base32
      vi.spyOn(global.localStorage, 'getItem').mockReturnValue(existingCEK);
      const setItemSpy = vi.spyOn(global.localStorage, 'setItem');

      await encryptionService.initialize();

      // Should NOT call setItem since CEK already exists
      expect(setItemSpy).not.toHaveBeenCalled();
      expect(encryptionService.isInitialized()).toBe(true);
    });
  });

  describe('encrypt and decrypt', () => {
    beforeEach(async () => {
      // Mock localStorage to store values
      const storage: Record<string, string> = {};
      vi.spyOn(global.localStorage, 'getItem').mockImplementation(
        (key: string) => storage[key] || null
      );
      vi.spyOn(global.localStorage, 'setItem').mockImplementation((key: string, value: string) => {
        storage[key] = value;
        return undefined;
      });
      vi.spyOn(global.localStorage, 'removeItem').mockImplementation((key: string) => {
        delete storage[key];
        return undefined;
      });

      await encryptionService.initialize();
    });

    it('should encrypt plaintext to base64 string', async () => {
      const plaintext = 'Hello, World!';
      const ciphertext = await encryptionService.encrypt(plaintext);

      expect(typeof ciphertext).toBe('string');
      expect(ciphertext).not.toBe(plaintext);

      // Should be valid base64
      expect(() => Buffer.from(ciphertext, 'base64')).not.toThrow();
    });

    it('should decrypt ciphertext back to original plaintext', async () => {
      const plaintext = 'Hello, World!';

      const ciphertext = await encryptionService.encrypt(plaintext);
      const decrypted = await encryptionService.decrypt(ciphertext);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle empty strings', async () => {
      const plaintext = '';

      const ciphertext = await encryptionService.encrypt(plaintext);
      const decrypted = await encryptionService.decrypt(ciphertext);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle special characters', async () => {
      const plaintext = '!@#$%^&*()_+-=[]{}|;:\'",.<>?/~`';

      const ciphertext = await encryptionService.encrypt(plaintext);
      const decrypted = await encryptionService.decrypt(ciphertext);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle unicode characters', async () => {
      const plaintext = '你好世界 🌍 مرحبا بالعالم';

      const ciphertext = await encryptionService.encrypt(plaintext);
      const decrypted = await encryptionService.decrypt(ciphertext);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle long strings', async () => {
      const plaintext = 'a'.repeat(10000);

      const ciphertext = await encryptionService.encrypt(plaintext);
      const decrypted = await encryptionService.decrypt(ciphertext);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle JSON data', async () => {
      const data = {
        apiKey: 'sk-test-123456',
        model: 'gpt-4',
        temperature: 0.7,
        nested: {
          array: [1, 2, 3],
          boolean: true,
          null: null,
        },
      };
      const plaintext = JSON.stringify(data);

      const ciphertext = await encryptionService.encrypt(plaintext);
      const decrypted = await encryptionService.decrypt(ciphertext);

      expect(JSON.parse(decrypted)).toEqual(data);
    });

    it('should produce different ciphertexts for same plaintext (due to random nonce)', async () => {
      const plaintext = 'Same message';

      const ciphertext1 = await encryptionService.encrypt(plaintext);
      const ciphertext2 = await encryptionService.encrypt(plaintext);

      expect(ciphertext1).not.toBe(ciphertext2);

      // Both should decrypt to the same plaintext
      expect(await encryptionService.decrypt(ciphertext1)).toBe(plaintext);
      expect(await encryptionService.decrypt(ciphertext2)).toBe(plaintext);
    });

    it('should throw error when decrypting invalid ciphertext', async () => {
      await expect(encryptionService.decrypt('invalid-base64')).rejects.toThrow();
    });

    it('should throw error when decrypting tampered ciphertext', async () => {
      const plaintext = 'Original message';
      const ciphertext = await encryptionService.encrypt(plaintext);

      // Tamper with the ciphertext
      const tamperedCiphertext = ciphertext.slice(0, -5) + 'XXXXX';

      await expect(encryptionService.decrypt(tamperedCiphertext)).rejects.toThrow();
    });
  });

  describe('encryption without initialization', () => {
    it('should throw error when encrypting without initialization', async () => {
      const service = new EncryptionService();

      await expect(service.encrypt('test')).rejects.toThrow('Encryption not initialized');
    });

    it('should throw error when decrypting without initialization', async () => {
      const service = new EncryptionService();

      await expect(service.decrypt('test')).rejects.toThrow('Encryption not initialized');
    });
  });

  describe('CEK management', () => {
    it('should store CEK after initialization', async () => {
      const setItemSpy = vi.spyOn(global.localStorage, 'setItem');

      await encryptionService.initialize();

      expect(setItemSpy).toHaveBeenCalledWith('chatbot_cek', expect.any(String));
    });

    it('should clear CEK when calling clearCEK()', async () => {
      const storage: Record<string, string> = {};
      vi.spyOn(global.localStorage, 'getItem').mockImplementation(
        (key: string) => storage[key] || null
      );
      vi.spyOn(global.localStorage, 'setItem').mockImplementation((key: string, value: string) => {
        storage[key] = value;
        return undefined;
      });
      const removeItemSpy = vi
        .spyOn(global.localStorage, 'removeItem')
        .mockImplementation((key: string) => {
          delete storage[key];
          return undefined;
        });

      await encryptionService.initialize();
      await encryptionService.clearCEK();

      expect(removeItemSpy).toHaveBeenCalledWith('chatbot_cek');
      expect(encryptionService.isInitialized()).toBe(false);
    });
  });

  describe('CEK format support', () => {
    it('should accept base32 format CEK', async () => {
      // 32 bytes encoded as base32 (52 characters)
      const base32CEK = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      const service = new EncryptionService();
      await service.initializeWithCEK(base32CEK);

      expect(service.isInitialized()).toBe(true);
    });

    it('should accept base64 format CEK for backward compatibility', async () => {
      // 32 bytes encoded as base64 (44 characters with padding)
      const base64CEK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

      const service = new EncryptionService();
      await service.initializeWithCEK(base64CEK);

      expect(service.isInitialized()).toBe(true);
    });

    it('should be case-insensitive for base32 CEK', async () => {
      // Same key in uppercase
      const base32CEK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

      const service = new EncryptionService();
      await service.initializeWithCEK(base32CEK);

      expect(service.isInitialized()).toBe(true);
    });

    it('should encrypt and decrypt correctly with imported base32 CEK', async () => {
      const storage: Record<string, string> = {};
      vi.spyOn(global.localStorage, 'getItem').mockImplementation(
        (key: string) => storage[key] || null
      );
      vi.spyOn(global.localStorage, 'setItem').mockImplementation((key: string, value: string) => {
        storage[key] = value;
        return undefined;
      });

      // 52-character base32 = 32 bytes
      const base32CEK = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';

      const service = new EncryptionService();
      await service.importCEK(base32CEK);

      const plaintext = 'Test message with base32 CEK';
      const ciphertext = await service.encrypt(plaintext);
      const decrypted = await service.decrypt(ciphertext);

      expect(decrypted).toBe(plaintext);
    });
  });

  describe('hasSameKeyAs', () => {
    it('should return true for services with same CEK', async () => {
      // 52-character base32 = 32 bytes
      const cek = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';

      const service1 = new EncryptionService();
      await service1.initializeWithCEK(cek);

      const service2 = new EncryptionService();
      await service2.initializeWithCEK(cek);

      expect(service1.hasSameKeyAs(service2)).toBe(true);
    });

    it('should return false for services with different CEKs', async () => {
      const storage1: Record<string, string> = {};
      const storage2: Record<string, string> = {};

      // Create two services with different CEKs
      const service1 = new EncryptionService();
      vi.spyOn(global.localStorage, 'getItem').mockImplementation(
        (key: string) => storage1[key] || null
      );
      vi.spyOn(global.localStorage, 'setItem').mockImplementation((key: string, value: string) => {
        storage1[key] = value;
        return undefined;
      });
      await service1.initialize();

      const service2 = new EncryptionService();
      vi.spyOn(global.localStorage, 'getItem').mockImplementation(
        (key: string) => storage2[key] || null
      );
      vi.spyOn(global.localStorage, 'setItem').mockImplementation((key: string, value: string) => {
        storage2[key] = value;
        return undefined;
      });
      await service2.initialize();

      expect(service1.hasSameKeyAs(service2)).toBe(false);
    });

    it('should return false if either service is not initialized', async () => {
      const service1 = new EncryptionService();
      const service2 = new EncryptionService();

      expect(service1.hasSameKeyAs(service2)).toBe(false);
    });
  });

  describe('getCEK', () => {
    it('should return stored CEK string', async () => {
      const storage: Record<string, string> = {};
      vi.spyOn(global.localStorage, 'getItem').mockImplementation(
        (key: string) => storage[key] || null
      );
      vi.spyOn(global.localStorage, 'setItem').mockImplementation((key: string, value: string) => {
        storage[key] = value;
        return undefined;
      });

      await encryptionService.initialize();

      const cek = encryptionService.getCEK();
      expect(cek).toBeDefined();
      expect(typeof cek).toBe('string');
      // Should be base32 (52 characters for 32 bytes)
      expect(cek!.length).toBe(52);
    });

    it('should return null when no CEK is stored', () => {
      vi.spyOn(global.localStorage, 'getItem').mockReturnValue(null);

      const service = new EncryptionService();
      const cek = service.getCEK();

      expect(cek).toBeNull();
    });
  });

  describe('importCEK', () => {
    it('should import and store CEK', async () => {
      const storage: Record<string, string> = {};
      vi.spyOn(global.localStorage, 'getItem').mockImplementation(
        (key: string) => storage[key] || null
      );
      const setItemSpy = vi
        .spyOn(global.localStorage, 'setItem')
        .mockImplementation((key: string, value: string) => {
          storage[key] = value;
          return undefined;
        });

      // 52-character base32 = 32 bytes
      const cek = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';
      const result = await encryptionService.importCEK(cek);

      expect(result).toBe(true);
      expect(setItemSpy).toHaveBeenCalledWith('chatbot_cek', cek);
      expect(encryptionService.isInitialized()).toBe(true);
    });

    it('should reject invalid CEK length', async () => {
      const shortCEK = 'tooshort';
      const result = await encryptionService.importCEK(shortCEK);

      expect(result).toBe(false);
    });
  });

  describe('hasCEK', () => {
    it('should return true when CEK exists', () => {
      vi.spyOn(global.localStorage, 'getItem').mockReturnValue('some-cek-value');

      expect(encryptionService.hasCEK()).toBe(true);
    });

    it('should return false when no CEK exists', () => {
      vi.spyOn(global.localStorage, 'getItem').mockReturnValue(null);

      expect(encryptionService.hasCEK()).toBe(false);
    });
  });

  describe('isCEKBase32', () => {
    it('should return true for base32 CEK', () => {
      // 52-char lowercase base32
      const base32CEK = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';
      vi.spyOn(global.localStorage, 'getItem').mockReturnValue(base32CEK);

      expect(encryptionService.isCEKBase32()).toBe(true);
    });

    it('should return true for uppercase base32 CEK', () => {
      // 52-char uppercase base32
      const base32CEK = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST';
      vi.spyOn(global.localStorage, 'getItem').mockReturnValue(base32CEK);

      expect(encryptionService.isCEKBase32()).toBe(true);
    });

    it('should return false for base64 CEK', () => {
      // Base64 contains characters not in base32 (0, 1, 8, 9, +, /, =)
      const base64CEK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      vi.spyOn(global.localStorage, 'getItem').mockReturnValue(base64CEK);

      expect(encryptionService.isCEKBase32()).toBe(false);
    });

    it('should return null when no CEK exists', () => {
      vi.spyOn(global.localStorage, 'getItem').mockReturnValue(null);

      expect(encryptionService.isCEKBase32()).toBe(null);
    });
  });

  describe('convertCEKToBase32', () => {
    it('should convert base64 CEK to base32', () => {
      const storage: Record<string, string> = {};
      // Base64 CEK (contains '=' which is not valid base32)
      const base64CEK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      storage['chatbot_cek'] = base64CEK;

      vi.spyOn(global.localStorage, 'getItem').mockImplementation(
        (key: string) => storage[key] || null
      );
      vi.spyOn(global.localStorage, 'setItem').mockImplementation((key: string, value: string) => {
        storage[key] = value;
        return undefined;
      });

      const service = new EncryptionService();
      const result = service.convertCEKToBase32();

      expect(result).not.toBeNull();
      // Should now be base32 format
      expect(result!.length).toBe(52);
      expect(result).toMatch(/^[a-z2-7]+$/);
      // Storage should be updated
      expect(storage['chatbot_cek']).toBe(result);
    });

    it('should return current CEK if already base32', () => {
      const storage: Record<string, string> = {};
      const base32CEK = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';
      storage['chatbot_cek'] = base32CEK;

      vi.spyOn(global.localStorage, 'getItem').mockImplementation(
        (key: string) => storage[key] || null
      );
      const setItemSpy = vi
        .spyOn(global.localStorage, 'setItem')
        .mockImplementation((key: string, value: string) => {
          storage[key] = value;
          return undefined;
        });

      const service = new EncryptionService();
      const result = service.convertCEKToBase32();

      expect(result).toBe(base32CEK);
      // Should NOT call setItem since already base32
      expect(setItemSpy).not.toHaveBeenCalled();
    });

    it('should return null when no CEK exists', () => {
      vi.spyOn(global.localStorage, 'getItem').mockReturnValue(null);

      const service = new EncryptionService();
      const result = service.convertCEKToBase32();

      expect(result).toBeNull();
    });

    it('should preserve encryption capability after conversion', async () => {
      const storage: Record<string, string> = {};
      // Base64 CEK
      const base64CEK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      storage['chatbot_cek'] = base64CEK;

      vi.spyOn(global.localStorage, 'getItem').mockImplementation(
        (key: string) => storage[key] || null
      );
      vi.spyOn(global.localStorage, 'setItem').mockImplementation((key: string, value: string) => {
        storage[key] = value;
        return undefined;
      });

      const service = new EncryptionService();
      await service.initializeWithCEK(base64CEK);

      // Encrypt with base64 format
      const plaintext = 'Test message before conversion';
      const ciphertext = await service.encrypt(plaintext);

      // Convert to base32
      service.convertCEKToBase32();

      // Should still be able to decrypt
      const decrypted = await service.decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);

      // Should also be able to encrypt new data
      const newPlaintext = 'Test message after conversion';
      const newCiphertext = await service.encrypt(newPlaintext);
      const newDecrypted = await service.decrypt(newCiphertext);
      expect(newDecrypted).toBe(newPlaintext);
    });
  });

  describe('deriveUserId', () => {
    it('should derive a 64-character hex string from CEK', async () => {
      const storage: Record<string, string> = {};
      vi.spyOn(global.localStorage, 'getItem').mockImplementation(
        (key: string) => storage[key] || null
      );
      vi.spyOn(global.localStorage, 'setItem').mockImplementation((key: string, value: string) => {
        storage[key] = value;
        return undefined;
      });

      await encryptionService.initialize();
      const userId = await encryptionService.deriveUserId();

      expect(userId).toBeDefined();
      expect(typeof userId).toBe('string');
      // 32 bytes = 64 hex characters
      expect(userId.length).toBe(64);
      // Should be lowercase hex
      expect(userId).toMatch(/^[a-f0-9]+$/);
    });

    it('should produce deterministic output for same CEK', async () => {
      const cek = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';

      const service1 = new EncryptionService();
      await service1.initializeWithCEK(cek);
      const userId1 = await service1.deriveUserId();

      const service2 = new EncryptionService();
      await service2.initializeWithCEK(cek);
      const userId2 = await service2.deriveUserId();

      expect(userId1).toBe(userId2);
    });

    it('should produce different userIds for different CEKs', async () => {
      const cek1 = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';
      const cek2 = 'stuvwxyz234567abcdefghijklmnopqrstuvwxyz234567abcdef';

      const service1 = new EncryptionService();
      await service1.initializeWithCEK(cek1);
      const userId1 = await service1.deriveUserId();

      const service2 = new EncryptionService();
      await service2.initializeWithCEK(cek2);
      const userId2 = await service2.deriveUserId();

      expect(userId1).not.toBe(userId2);
    });

    it('should throw error when not initialized', async () => {
      const service = new EncryptionService();

      await expect(service.deriveUserId()).rejects.toThrow('Encryption not initialized');
    });

    it('should produce same userId from base32 and base64 formats of same key', async () => {
      // Same 32-byte key represented in both formats
      const base64CEK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      const base32CEK = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      const service1 = new EncryptionService();
      await service1.initializeWithCEK(base64CEK);
      const userId1 = await service1.deriveUserId();

      const service2 = new EncryptionService();
      await service2.initializeWithCEK(base32CEK);
      const userId2 = await service2.deriveUserId();

      expect(userId1).toBe(userId2);
    });
  });

  describe('base32/base64 interoperability', () => {
    it('should decrypt data encrypted with same key in different format', async () => {
      // Same 32-byte key represented in both formats
      // All zeros: base64 = 'AAAA...AA=', base32 = 'aaaa...aa'
      const base64CEK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      const base32CEK = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      // Encrypt with base64 format
      const service1 = new EncryptionService();
      await service1.initializeWithCEK(base64CEK);

      const plaintext = 'Secret message for interop test';
      const ciphertext = await service1.encrypt(plaintext);

      // Decrypt with base32 format (same key bytes)
      const service2 = new EncryptionService();
      await service2.initializeWithCEK(base32CEK);

      const decrypted = await service2.decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce same derived key from both formats', async () => {
      // Same key in both formats
      const base64CEK = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      const base32CEK = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      const service1 = new EncryptionService();
      await service1.initializeWithCEK(base64CEK);

      const service2 = new EncryptionService();
      await service2.initializeWithCEK(base32CEK);

      // The hasSameKeyAs method compares the derived keys
      expect(service1.hasSameKeyAs(service2)).toBe(true);
    });
  });
});
