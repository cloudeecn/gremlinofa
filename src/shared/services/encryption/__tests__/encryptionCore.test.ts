/**
 * Pure-crypto tests for `EncryptionCore`. Zero DOM, zero localStorage —
 * mirrors the runtime contract: workers and the future Node server
 * construct an `EncryptionCore` directly and never touch browser-only
 * state.
 */

import { describe, it, expect } from 'vitest';
import { EncryptionCore, decodeCEKString } from '../encryptionCore';
import { Buffer } from 'buffer';

const BASE32_KEY = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';
const ALT_BASE32_KEY = 'stuvwxyz234567abcdefghijklmnopqrstuvwxyz234567abcdef';

describe('EncryptionCore — pure crypto', () => {
  describe('initializeWithCEK + isInitialized + forget', () => {
    it('starts uninitialized', () => {
      const core = new EncryptionCore();
      expect(core.isInitialized()).toBe(false);
    });

    it('reports initialized after initializeWithCEK', async () => {
      const core = new EncryptionCore();
      await core.initializeWithCEK(BASE32_KEY);
      expect(core.isInitialized()).toBe(true);
    });

    it('forget() drops the in-memory key', async () => {
      const core = new EncryptionCore();
      await core.initializeWithCEK(BASE32_KEY);
      core.forget();
      expect(core.isInitialized()).toBe(false);
    });

    it('accepts both base32 and base64 CEK formats', async () => {
      const base32Core = new EncryptionCore();
      await base32Core.initializeWithCEK(BASE32_KEY);
      // Same 32-byte all-zeros key in both formats:
      const base64Core = new EncryptionCore();
      await base64Core.initializeWithCEK('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      expect(base32Core.isInitialized()).toBe(true);
      expect(base64Core.isInitialized()).toBe(true);
    });
  });

  describe('encrypt + decrypt round-trip', () => {
    it('round-trips simple text', async () => {
      const core = new EncryptionCore();
      await core.initializeWithCEK(BASE32_KEY);
      const ciphertext = await core.encrypt('Hello, World!');
      expect(ciphertext).not.toBe('Hello, World!');
      // Should be valid base64
      expect(() => Buffer.from(ciphertext, 'base64')).not.toThrow();
      const plaintext = await core.decrypt(ciphertext);
      expect(plaintext).toBe('Hello, World!');
    });

    it('round-trips unicode + special characters + empty + long strings', async () => {
      const core = new EncryptionCore();
      await core.initializeWithCEK(BASE32_KEY);
      for (const text of ['', '!@#$%^&*()', '你好世界 🌍 مرحبا بالعالم', 'a'.repeat(10000)]) {
        const ct = await core.encrypt(text);
        const pt = await core.decrypt(ct);
        expect(pt).toBe(text);
      }
    });

    it('produces different ciphertexts for the same plaintext (random nonce)', async () => {
      const core = new EncryptionCore();
      await core.initializeWithCEK(BASE32_KEY);
      const a = await core.encrypt('Same message');
      const b = await core.encrypt('Same message');
      expect(a).not.toBe(b);
      expect(await core.decrypt(a)).toBe('Same message');
      expect(await core.decrypt(b)).toBe('Same message');
    });

    it('throws when encrypting/decrypting before initialization', async () => {
      const core = new EncryptionCore();
      await expect(core.encrypt('x')).rejects.toThrow(/not initialized/i);
      await expect(core.decrypt('x')).rejects.toThrow(/not initialized/i);
    });

    it('throws on tampered ciphertext (auth tag)', async () => {
      const core = new EncryptionCore();
      await core.initializeWithCEK(BASE32_KEY);
      const ct = await core.encrypt('original');
      const tampered = ct.slice(0, -5) + 'AAAAA';
      await expect(core.decrypt(tampered)).rejects.toThrow();
    });
  });

  describe('encryptWithCompression / decryptWithDecompression', () => {
    it('round-trips compressed text', async () => {
      const core = new EncryptionCore();
      await core.initializeWithCEK(BASE32_KEY);
      const text = 'a'.repeat(1000);
      const compressed = await core.encryptWithCompression(text);
      const decoded = await core.decryptWithDecompression(compressed);
      expect(decoded).toBe(text);
    });

    it('round-trips uncompressed text via the same decompress path', async () => {
      const core = new EncryptionCore();
      await core.initializeWithCEK(BASE32_KEY);
      const text = 'short';
      const ciphertext = await core.encryptWithCompression(text, false);
      const decoded = await core.decryptWithDecompression(ciphertext);
      expect(decoded).toBe(text);
    });
  });

  describe('hasSameKeyAs', () => {
    it('returns true for two cores keyed with the same CEK', async () => {
      const a = new EncryptionCore();
      await a.initializeWithCEK(BASE32_KEY);
      const b = new EncryptionCore();
      await b.initializeWithCEK(BASE32_KEY);
      expect(a.hasSameKeyAs(b)).toBe(true);
      expect(b.hasSameKeyAs(a)).toBe(true);
    });

    it('returns true across base32/base64 representations of the same key', async () => {
      const a = new EncryptionCore();
      await a.initializeWithCEK('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      const b = new EncryptionCore();
      await b.initializeWithCEK('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(a.hasSameKeyAs(b)).toBe(true);
    });

    it('returns false for two cores keyed with different CEKs', async () => {
      const a = new EncryptionCore();
      await a.initializeWithCEK(BASE32_KEY);
      const b = new EncryptionCore();
      await b.initializeWithCEK(ALT_BASE32_KEY);
      expect(a.hasSameKeyAs(b)).toBe(false);
    });

    it('returns false when either core is uninitialized', async () => {
      const a = new EncryptionCore();
      const b = new EncryptionCore();
      await b.initializeWithCEK(BASE32_KEY);
      expect(a.hasSameKeyAs(b)).toBe(false);
      expect(b.hasSameKeyAs(a)).toBe(false);
    });
  });

  describe('deriveUserId', () => {
    it('produces a 64-char lowercase hex string', async () => {
      const core = new EncryptionCore();
      await core.initializeWithCEK(BASE32_KEY);
      const userId = await core.deriveUserId();
      expect(userId).toMatch(/^[a-f0-9]{64}$/);
    });

    it('is deterministic for the same CEK', async () => {
      const a = new EncryptionCore();
      await a.initializeWithCEK(BASE32_KEY);
      const b = new EncryptionCore();
      await b.initializeWithCEK(BASE32_KEY);
      expect(await a.deriveUserId()).toBe(await b.deriveUserId());
    });

    it('produces different userIds for different CEKs', async () => {
      const a = new EncryptionCore();
      await a.initializeWithCEK(BASE32_KEY);
      const b = new EncryptionCore();
      await b.initializeWithCEK(ALT_BASE32_KEY);
      expect(await a.deriveUserId()).not.toBe(await b.deriveUserId());
    });

    it('throws when not initialized', async () => {
      const core = new EncryptionCore();
      await expect(core.deriveUserId()).rejects.toThrow(/not initialized/i);
    });
  });

  describe('decodeCEKString helper', () => {
    it('decodes base32 input', () => {
      const bytes = decodeCEKString(BASE32_KEY);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBe(32);
    });

    it('decodes base64 input', () => {
      const bytes = decodeCEKString('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBe(32);
    });
  });
});
