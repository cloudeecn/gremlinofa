import { compressString, decompressString } from '../compression/compressionService';

const CEK_KEY = 'chatbot_cek'; // Content Encryption Key

// Base32 alphabet (RFC 4648, lowercase for readability)
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Encode Uint8Array to base32 (lowercase)
 */
function uint8ArrayToBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let result = '';

  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }

  // Handle remaining bits
  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }

  return result;
}

/**
 * Decode base32 (case-insensitive) to Uint8Array
 */
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
 * Encode Uint8Array to base64
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const binaryString = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
  return btoa(binaryString);
}

/**
 * Decode base64 to Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  return Uint8Array.from(binaryString, char => char.charCodeAt(0));
}

/**
 * Generate random bytes using Web Crypto API
 */
function getRandomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

/**
 * Detect if a string is base32 or base64
 * Base32 contains only: a-z, 2-7 (case-insensitive)
 * Base64 contains: A-Za-z0-9+/=
 */
function isBase32(str: string): boolean {
  const normalized = str.toLowerCase().replace(/\s/g, '');
  return /^[a-z2-7]+$/.test(normalized);
}

/**
 * Decode CEK from either base32 or base64 format
 */
function decodeCEK(encoded: string): Uint8Array {
  const trimmed = encoded.trim();
  if (isBase32(trimmed)) {
    return base32ToUint8Array(trimmed);
  } else {
    return base64ToUint8Array(trimmed);
  }
}

const KEY_LENGTH = 32; // 256 bits for AES-256

class EncryptionService {
  private derivedKey: Uint8Array | null = null;

  /**
   * Get cached CEK from localStorage
   */
  private getCachedCEK(): string | null {
    try {
      return localStorage.getItem(CEK_KEY);
    } catch (error) {
      console.error('Failed to get cached CEK:', error);
      return null;
    }
  }

  /**
   * Set cached CEK in localStorage
   */
  private setCachedCEK(cekString: string): void {
    try {
      localStorage.setItem(CEK_KEY, cekString);
    } catch (error) {
      console.error('Failed to set cached CEK:', error);
      throw error;
    }
  }

  /**
   * Delete cached CEK from localStorage
   */
  private deleteCachedCEK(): void {
    try {
      localStorage.removeItem(CEK_KEY);
    } catch (error) {
      console.error('Failed to delete cached CEK:', error);
    }
  }

  /**
   * Initialize encryption - load existing CEK or generate new one
   * New CEKs are generated as base32 for easier manual entry
   */
  async initialize(): Promise<void> {
    try {
      // Try to load cached CEK
      const cachedCEK = this.getCachedCEK();
      if (cachedCEK) {
        console.debug('[Encryption] Using cached CEK');
        this.derivedKey = decodeCEK(cachedCEK);
        return;
      }

      // No cached CEK - generate new one (base32 format)
      console.debug('[Encryption] Generating new CEK (base32)');
      const newKey = getRandomBytes(KEY_LENGTH);
      const base32CEK = uint8ArrayToBase32(newKey);
      this.setCachedCEK(base32CEK);
      this.derivedKey = newKey;
      console.debug('[Encryption] New CEK generated and cached');
    } catch (error) {
      console.error('Failed to initialize encryption:', error);
      throw error;
    }
  }

  /**
   * Initialize with a specific CEK (for import utility)
   * Accepts both base32 and base64 formats
   * Does not save CEK to localStorage
   *
   * @param cek The CEK string (base32 or base64)
   */
  async initializeWithCEK(cek: string): Promise<void> {
    console.debug('[Encryption] Initializing with provided CEK');
    this.derivedKey = decodeCEK(cek);
    console.debug('[Encryption] CEK loaded');
  }

  /**
   * Check if encryption is initialized
   */
  isInitialized(): boolean {
    return this.derivedKey !== null;
  }

  /**
   * Encrypt data using AES-256-GCM (provides authenticated encryption)
   */
  async encrypt(plaintext: string): Promise<string> {
    if (!this.derivedKey) {
      throw new Error('Encryption not initialized. Call initialize() first.');
    }

    try {
      // Generate random nonce (12 bytes is standard for GCM)
      const nonce = getRandomBytes(12);

      // Convert plaintext to bytes
      const plaintextBytes = new TextEncoder().encode(plaintext);

      // Ensure derivedKey is a proper Uint8Array for Web Crypto API
      const keyBytes = new Uint8Array(this.derivedKey);

      // Import the key for Web Crypto API
      const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
        'encrypt',
      ]);

      // Encrypt using Web Crypto API AES-256-GCM
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(nonce),
        },
        cryptoKey,
        plaintextBytes
      );

      // Combine nonce + ciphertext (GCM auth tag is included in ciphertext)
      const ciphertextBytes = new Uint8Array(ciphertext);
      const combined = new Uint8Array(nonce.length + ciphertextBytes.length);
      combined.set(nonce, 0);
      combined.set(ciphertextBytes, nonce.length);

      // Return as base64
      return uint8ArrayToBase64(combined);
    } catch (error) {
      console.error('Encryption failed:', error);
      throw error;
    }
  }

  /**
   * Decrypt data using AES-256-GCM (verifies authentication automatically)
   */
  async decrypt(ciphertext: string): Promise<string> {
    if (!this.derivedKey) {
      throw new Error('Encryption not initialized. Call initialize() first.');
    }

    try {
      // Decode from base64 to Uint8Array
      const combined = base64ToUint8Array(ciphertext);

      // Extract nonce (first 12 bytes) and ciphertext (rest, includes auth tag)
      const nonce = combined.subarray(0, 12);
      const encryptedData = combined.subarray(12);

      // Ensure derivedKey is a proper Uint8Array for Web Crypto API
      const keyBytes = new Uint8Array(this.derivedKey);

      // Import the key for Web Crypto API
      const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
        'decrypt',
      ]);

      // Decrypt using Web Crypto API AES-256-GCM (will throw if authentication fails)
      const plaintextBuffer = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(nonce),
        },
        cryptoKey,
        new Uint8Array(encryptedData)
      );

      // Convert bytes to string
      return new TextDecoder().decode(plaintextBuffer);
    } catch (error) {
      console.error('Decryption failed:', error);
      throw error;
    }
  }

  /**
   * Get the current CEK (for backup/display)
   * Returns the stored string (base32 or base64)
   */
  getCEK(): string | null {
    try {
      return this.getCachedCEK();
    } catch (error) {
      console.error('Failed to get CEK:', error);
      return null;
    }
  }

  /**
   * Import a CEK (for device migration)
   * Accepts both base32 and base64 formats
   * Stores in original format
   */
  async importCEK(cek: string): Promise<boolean> {
    try {
      // Validate by attempting to decode
      const keyBytes = decodeCEK(cek);

      if (keyBytes.length !== KEY_LENGTH) {
        throw new Error(`Invalid CEK length: expected ${KEY_LENGTH} bytes, got ${keyBytes.length}`);
      }

      // Store the CEK (preserve original format)
      this.setCachedCEK(cek.trim());

      // Set the derived key
      this.derivedKey = keyBytes;

      return true;
    } catch (error) {
      console.error('Failed to import CEK:', error);
      return false;
    }
  }

  /**
   * Check if CEK exists (first launch detection)
   */
  hasCEK(): boolean {
    try {
      return this.getCachedCEK() !== null;
    } catch (_error: unknown) {
      return false;
    }
  }

  /**
   * Clear CEK (for testing or reset)
   */
  async clearCEK(): Promise<void> {
    try {
      this.deleteCachedCEK();
      this.derivedKey = null;
    } catch (error) {
      console.error('Failed to clear CEK:', error);
    }
  }

  /**
   * Compare if this encryption service has the same CEK as another
   * Used for import optimization - if CEKs match, no need to re-encrypt
   *
   * @param other - Another EncryptionService instance to compare with
   * @returns true if both have the same derived key, false otherwise
   */
  hasSameKeyAs(other: EncryptionService): boolean {
    if (!this.derivedKey || !other.derivedKey) {
      return false;
    }

    if (this.derivedKey.length !== other.derivedKey.length) {
      return false;
    }

    // Constant-time comparison to avoid timing attacks
    let result = 0;
    for (let i = 0; i < this.derivedKey.length; i++) {
      result |= this.derivedKey[i] ^ other.derivedKey[i];
    }

    return result === 0;
  }

  /**
   * Encrypt bytes directly (internal method for compression support)
   */
  private async encryptBytes(plaintextBytes: Uint8Array): Promise<string> {
    if (!this.derivedKey) {
      throw new Error('Encryption not initialized. Call initialize() first.');
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

      // Combine nonce + ciphertext
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

  /**
   * Decrypt to bytes directly (internal method for compression support)
   */
  private async decryptToBytes(ciphertext: string): Promise<Uint8Array> {
    if (!this.derivedKey) {
      throw new Error('Encryption not initialized. Call initialize() first.');
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
   * Encrypt with optional compression
   * Flow: plaintext → compress → prepend "GZ" bytes → encrypt bytes → base64
   */
  async encryptWithCompression(plaintext: string, compress = true): Promise<string> {
    if (!compress) {
      return this.encrypt(plaintext);
    }

    try {
      // 1. Compress text to bytes
      const compressed = await compressString(plaintext);

      // 2. Prepend "GZ" indicator as bytes [71, 90]
      const indicator = new Uint8Array([71, 90]); // ASCII codes for 'G' and 'Z'
      const dataWithIndicator = new Uint8Array(indicator.length + compressed.length);
      dataWithIndicator.set(indicator, 0);
      dataWithIndicator.set(compressed, indicator.length);

      // 3. Encrypt the binary data directly
      return this.encryptBytes(dataWithIndicator);
    } catch (error) {
      console.error('Encryption with compression failed:', error);
      throw error;
    }
  }

  /**
   * Decrypt with automatic decompression detection
   * Flow: decrypt to bytes → check for "GZ" bytes → decompress → text
   */
  async decryptWithDecompression(ciphertext: string): Promise<string> {
    try {
      // 1. Decrypt to bytes
      const decryptedBytes = await this.decryptToBytes(ciphertext);

      // 2. Check for "GZ" prefix (bytes [71, 90])
      if (decryptedBytes.length < 2 || decryptedBytes[0] !== 71 || decryptedBytes[1] !== 90) {
        // Not compressed - decode as plain UTF-8 text (backward compatibility)
        const decoder = new TextDecoder();
        return decoder.decode(decryptedBytes);
      }

      // 3. Remove "GZ" prefix (first 2 bytes)
      const compressed = decryptedBytes.subarray(2);

      // 4. Decompress
      return decompressString(compressed);
    } catch (error) {
      console.error('Decryption with decompression failed:', error);
      throw error;
    }
  }

  /**
   * Derive a userId from the CEK using PBKDF2
   * Used for HTTP Basic Auth with storage-backend
   *
   * @returns 64-character hex string (32 bytes)
   */
  async deriveUserId(): Promise<string> {
    if (!this.derivedKey) {
      throw new Error('Encryption not initialized. Call initialize() first.');
    }

    const salt = new TextEncoder().encode('gremlinofa-userid-v1');

    // Import the CEK as key material for PBKDF2
    const keyBytes = new Uint8Array(this.derivedKey);
    const keyMaterial = await crypto.subtle.importKey('raw', keyBytes, 'PBKDF2', false, [
      'deriveBits',
    ]);

    // Derive 256 bits (32 bytes) using 600,000 iterations
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

    // Convert to lowercase hex string
    const bytes = new Uint8Array(derivedBits);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Check if the current stored CEK is in base32 format
   * @returns true if base32, false if base64 or null if no CEK
   */
  isCEKBase32(): boolean | null {
    const cek = this.getCachedCEK();
    if (!cek) return null;
    return isBase32(cek);
  }

  /**
   * Convert the stored CEK from base64 to base32 format
   * This is useful for migrating old base64 CEKs to the more readable base32 format
   * @returns the new base32 CEK string, or null if conversion failed or already base32
   */
  convertCEKToBase32(): string | null {
    const currentCEK = this.getCachedCEK();
    if (!currentCEK) {
      console.debug('[Encryption] No CEK to convert');
      return null;
    }

    // Already base32, nothing to do
    if (isBase32(currentCEK)) {
      console.debug('[Encryption] CEK is already base32');
      return currentCEK;
    }

    try {
      // Decode base64 → raw bytes → encode to base32
      const keyBytes = base64ToUint8Array(currentCEK);
      const base32CEK = uint8ArrayToBase32(keyBytes);

      // Store the new format
      this.setCachedCEK(base32CEK);

      // Update derived key (should be same bytes)
      this.derivedKey = keyBytes;

      console.debug('[Encryption] CEK converted from base64 to base32');
      return base32CEK;
    } catch (error) {
      console.error('Failed to convert CEK to base32:', error);
      return null;
    }
  }
}

export { EncryptionService };
export const encryptionService = new EncryptionService();
