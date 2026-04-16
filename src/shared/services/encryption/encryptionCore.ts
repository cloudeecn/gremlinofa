/**
 * Pure encryption primitives — zero `localStorage` coupling.
 *
 * `EncryptionCore` is the runtime-agnostic subset of the encryption service.
 * It holds a single `derivedKey` in memory, exposes AES-256-GCM
 * encrypt/decrypt and the userId derivation, and never reads or writes
 * browser-only state. The Phase 2 Node WebSocket server constructs one of
 * these directly; the worker does the same inside `GremlinServer.init`
 * from the CEK bytes posted via `gremlinClient.init({cek})`; tests can pin
 * a key without touching `globalThis`.
 *
 * Phase 1.65 deleted the legacy main-thread subclass that wrapped this
 * core with localStorage CEK caching. The free helpers in
 * `src/utils/{localStorageBoot,cekFormat}.ts` now own the main-thread
 * CEK lifecycle (read by OOBE / Data Manager directly).
 */

import { compressString, decompressString } from '../compression/compressionService';

// Base32 alphabet (RFC 4648, lowercase for readability)
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const KEY_LENGTH = 32; // 256 bits for AES-256

/** Encode Uint8Array to base64. Used internally for ciphertext serialization. */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const binaryString = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
  return btoa(binaryString);
}

/** Decode base64 to Uint8Array. */
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  return Uint8Array.from(binaryString, char => char.charCodeAt(0));
}

/** Decode base32 (case-insensitive) to Uint8Array. */
function base32ToUint8Array(base32: string): Uint8Array {
  const normalized = base32.toLowerCase().replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new Error(`Invalid base32 character: ${char}`);
    }

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }

  return new Uint8Array(bytes);
}

/**
 * Detect base32 vs base64 by character set.
 * Base32 contains only: a-z, 2-7 (case-insensitive)
 */
function isBase32(str: string): boolean {
  const normalized = str.toLowerCase().replace(/\s/g, '');
  return /^[a-z2-7]+$/.test(normalized);
}

/** Decode CEK from either base32 or base64 format. */
export function decodeCEKString(encoded: string): Uint8Array {
  const trimmed = encoded.trim();
  if (isBase32(trimmed)) {
    return base32ToUint8Array(trimmed);
  } else {
    return base64ToUint8Array(trimmed);
  }
}

/** Generate random bytes using Web Crypto API. */
function getRandomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

export class EncryptionCore {
  /**
   * The active 32-byte AES-256 key. `null` until `initializeWithCEK` is
   * called. Stored as `protected` only because legacy subclasses used to
   * tap into it; after Phase 1.65 there are no subclasses, but the field
   * remains protected to leave the option open for tests that pin a key.
   */
  protected derivedKey: Uint8Array | null = null;

  /**
   * Initialize the core with a specific CEK. Accepts both base32 and
   * base64 formats. The CEK is held only in memory — `EncryptionCore`
   * never persists it anywhere.
   */
  async initializeWithCEK(cek: string): Promise<void> {
    this.derivedKey = decodeCEKString(cek);
  }

  /** Returns true iff a key has been loaded into memory. */
  isInitialized(): boolean {
    return this.derivedKey !== null;
  }

  /**
   * Drop the in-memory key. Subsequent encrypt/decrypt calls throw until
   * `initializeWithCEK` is called again. Replaces the old `clearCEK()`
   * helper for callers that have no business with localStorage.
   */
  forget(): void {
    this.derivedKey = null;
  }

  /** Encrypt UTF-8 plaintext to a base64-encoded `nonce + ciphertext` string. */
  async encrypt(plaintext: string): Promise<string> {
    if (!this.derivedKey) {
      throw new Error('Encryption not initialized. Call initializeWithCEK() first.');
    }

    try {
      const nonce = getRandomBytes(12);
      const plaintextBytes = new TextEncoder().encode(plaintext);
      const keyBytes = new Uint8Array(this.derivedKey);

      const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
        'encrypt',
      ]);

      const ciphertext = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(nonce),
        },
        cryptoKey,
        plaintextBytes
      );

      const ciphertextBytes = new Uint8Array(ciphertext);
      const combined = new Uint8Array(nonce.length + ciphertextBytes.length);
      combined.set(nonce, 0);
      combined.set(ciphertextBytes, nonce.length);

      return uint8ArrayToBase64(combined);
    } catch (error) {
      console.error('Encryption failed:', error);
      throw error;
    }
  }

  /** Decrypt a base64-encoded ciphertext string back to UTF-8 plaintext. */
  async decrypt(ciphertext: string): Promise<string> {
    if (!this.derivedKey) {
      throw new Error('Encryption not initialized. Call initializeWithCEK() first.');
    }

    try {
      const combined = base64ToUint8Array(ciphertext);
      const nonce = combined.subarray(0, 12);
      const encryptedData = combined.subarray(12);
      const keyBytes = new Uint8Array(this.derivedKey);

      const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
        'decrypt',
      ]);

      const plaintextBuffer = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(nonce),
        },
        cryptoKey,
        new Uint8Array(encryptedData)
      );

      return new TextDecoder().decode(plaintextBuffer);
    } catch (error) {
      console.error('Decryption failed:', error);
      throw error;
    }
  }

  /** Encrypt raw bytes (used by the compression path). */
  protected async encryptBytes(plaintextBytes: Uint8Array): Promise<string> {
    if (!this.derivedKey) {
      throw new Error('Encryption not initialized. Call initializeWithCEK() first.');
    }

    try {
      const nonce = getRandomBytes(12);
      const keyBytes = new Uint8Array(this.derivedKey);

      const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
        'encrypt',
      ]);

      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: new Uint8Array(nonce) },
        cryptoKey,
        new Uint8Array(plaintextBytes)
      );

      const ciphertextBytes = new Uint8Array(ciphertext);
      const combined = new Uint8Array(nonce.length + ciphertextBytes.length);
      combined.set(nonce, 0);
      combined.set(ciphertextBytes, nonce.length);

      return uint8ArrayToBase64(combined);
    } catch (error) {
      console.error('Binary encryption failed:', error);
      throw error;
    }
  }

  /** Decrypt to raw bytes (used by the compression path). */
  protected async decryptToBytes(ciphertext: string): Promise<Uint8Array> {
    if (!this.derivedKey) {
      throw new Error('Encryption not initialized. Call initializeWithCEK() first.');
    }

    try {
      const combined = base64ToUint8Array(ciphertext);
      const nonce = combined.subarray(0, 12);
      const encryptedData = combined.subarray(12);
      const keyBytes = new Uint8Array(this.derivedKey);

      const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
        'decrypt',
      ]);

      const plaintextBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(nonce) },
        cryptoKey,
        new Uint8Array(encryptedData)
      );

      return new Uint8Array(plaintextBuffer);
    } catch (error) {
      console.error('Binary decryption failed:', error);
      throw error;
    }
  }

  /**
   * Encrypt with optional gzip compression.
   * Flow: plaintext → compress → prepend "GZ" bytes → encrypt bytes → base64
   */
  async encryptWithCompression(plaintext: string, compress = true): Promise<string> {
    if (!compress) {
      return this.encrypt(plaintext);
    }

    try {
      const compressed = await compressString(plaintext);
      const indicator = new Uint8Array([71, 90]); // ASCII codes for 'G' and 'Z'
      const dataWithIndicator = new Uint8Array(indicator.length + compressed.length);
      dataWithIndicator.set(indicator, 0);
      dataWithIndicator.set(compressed, indicator.length);
      return this.encryptBytes(dataWithIndicator);
    } catch (error) {
      console.error('Encryption with compression failed:', error);
      throw error;
    }
  }

  /**
   * Decrypt with automatic decompression detection.
   * Flow: decrypt to bytes → check for "GZ" bytes → decompress → text
   */
  async decryptWithDecompression(ciphertext: string): Promise<string> {
    try {
      const decryptedBytes = await this.decryptToBytes(ciphertext);

      if (decryptedBytes.length < 2 || decryptedBytes[0] !== 71 || decryptedBytes[1] !== 90) {
        const decoder = new TextDecoder();
        return decoder.decode(decryptedBytes);
      }

      const compressed = decryptedBytes.subarray(2);
      return decompressString(compressed);
    } catch (error) {
      console.error('Decryption with decompression failed:', error);
      throw error;
    }
  }

  /**
   * Derive a userId from the CEK using PBKDF2-SHA256 (600k iterations).
   * Used as the HTTP Basic Auth username for `storage-backend`.
   *
   * @returns 64-character lowercase hex string (32 bytes)
   */
  async deriveUserId(): Promise<string> {
    if (!this.derivedKey) {
      throw new Error('Encryption not initialized. Call initializeWithCEK() first.');
    }

    const salt = new TextEncoder().encode('gremlinofa-userid-v1');
    const keyBytes = new Uint8Array(this.derivedKey);
    const keyMaterial = await crypto.subtle.importKey('raw', keyBytes, 'PBKDF2', false, [
      'deriveBits',
    ]);

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt,
        iterations: 600000,
        hash: 'SHA-256',
      },
      keyMaterial,
      256
    );

    const bytes = new Uint8Array(derivedBits);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Constant-time comparison of two cores' derived keys. Used by `rotateCek`
   * and `dataImport` to short-circuit re-encryption when both sides hold the
   * same key.
   */
  hasSameKeyAs(other: EncryptionCore): boolean {
    if (!this.derivedKey || !other.derivedKey) {
      return false;
    }

    if (this.derivedKey.length !== other.derivedKey.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < this.derivedKey.length; i++) {
      result |= this.derivedKey[i] ^ other.derivedKey[i];
    }

    return result === 0;
  }
}

export { KEY_LENGTH };
