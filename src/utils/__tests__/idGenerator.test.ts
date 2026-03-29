/**
 * Unit tests for ID Generator
 */

import { describe, it, expect } from 'vitest';
import { generateChecksummedId, generateUniqueId, validateIdChecksum } from '../idGenerator';

describe('idGenerator', () => {
  describe('generateUniqueId', () => {
    it('should generate ID with correct prefix', () => {
      const id = generateUniqueId('test');
      expect(id).toMatch(/^test_[a-z2-7]{32}$/);
    });

    it('should generate ID with correct format', () => {
      const prefixes = ['msg_user', 'msg_assistant', 'chat', 'project', 'api'];

      for (const prefix of prefixes) {
        const id = generateUniqueId(prefix);
        expect(id).toMatch(new RegExp(`^${prefix}_[a-z2-7]{32}$`));
      }
    });

    it('should generate 32-character random string', () => {
      const id = generateUniqueId('test');
      const parts = id.split('_');
      const randomPart = parts.slice(1).join('_'); // Handle prefixes with underscores

      // For simple prefix like "test", randomPart should be 32 chars
      expect(randomPart).toHaveLength(32);
    });

    it('should only use base32 characters (a-z2-7)', () => {
      const id = generateUniqueId('test');
      const randomPart = id.substring('test_'.length);

      // Base32 uses lowercase a-z and digits 2-7
      expect(randomPart).toMatch(/^[a-z2-7]+$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      const count = 1000;

      for (let i = 0; i < count; i++) {
        const id = generateUniqueId('test');
        ids.add(id);
      }

      // All IDs should be unique
      expect(ids.size).toBe(count);
    });

    it('should handle different prefixes', () => {
      const prefixes = ['msg_user', 'msg_assistant', 'chat', 'project', 'api_def', 'model'];

      for (const prefix of prefixes) {
        const id = generateUniqueId(prefix);
        expect(id.startsWith(prefix + '_')).toBe(true);
      }
    });

    it('should handle empty prefix', () => {
      const id = generateUniqueId('');
      expect(id).toMatch(/^_[a-z2-7]{32}$/);
    });

    it('should handle prefix with special characters', () => {
      const id = generateUniqueId('test-prefix');
      expect(id).toMatch(/^test-prefix_[a-z2-7]{32}$/);
    });

    it('should generate different IDs with same prefix', () => {
      const id1 = generateUniqueId('test');
      const id2 = generateUniqueId('test');
      const id3 = generateUniqueId('test');

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });

    it('should have high entropy (no patterns)', () => {
      const ids: string[] = [];
      for (let i = 0; i < 100; i++) {
        ids.push(generateUniqueId('test'));
      }

      // Extract random parts
      const randomParts = ids.map(id => id.substring('test_'.length));

      // Count character frequency
      const charCounts: { [key: string]: number } = {};
      for (const part of randomParts) {
        for (const char of part) {
          charCounts[char] = (charCounts[char] || 0) + 1;
        }
      }

      // Should use multiple different characters (not just repeating one char)
      const uniqueChars = Object.keys(charCounts).length;
      expect(uniqueChars).toBeGreaterThan(10); // Should use variety of base32 chars
    });

    it('should generate IDs that are URL-safe', () => {
      const id = generateUniqueId('test');
      // Base32 chars are all URL-safe (no need for encoding)
      expect(encodeURIComponent(id)).toBe(id);
    });

    it('should match expected ID patterns used in the app', () => {
      // Test actual prefixes used in the app
      const patterns = [
        { prefix: 'msg_user', pattern: /^msg_user_[a-z2-7]{32}$/ },
        { prefix: 'msg_assistant', pattern: /^msg_assistant_[a-z2-7]{32}$/ },
        { prefix: 'chat', pattern: /^chat_[a-z2-7]{32}$/ },
        { prefix: 'project', pattern: /^project_[a-z2-7]{32}$/ },
        { prefix: 'api', pattern: /^api_[a-z2-7]{32}$/ },
      ];

      for (const { prefix, pattern } of patterns) {
        const id = generateUniqueId(prefix);
        expect(id).toMatch(pattern);
      }
    });
  });

  describe('Collision Resistance', () => {
    it('should have extremely low collision probability', () => {
      // With 160 bits of entropy (32 bytes), collision probability is negligible
      // Generate a large batch and check for uniqueness
      const batchSize = 10000;
      const ids = new Set<string>();

      for (let i = 0; i < batchSize; i++) {
        ids.add(generateUniqueId('test'));
      }

      expect(ids.size).toBe(batchSize);
    });

    it('should maintain uniqueness across different prefixes', () => {
      const prefixes = ['msg', 'chat', 'project', 'api'];
      const ids = new Set<string>();

      for (const prefix of prefixes) {
        for (let i = 0; i < 100; i++) {
          ids.add(generateUniqueId(prefix));
        }
      }

      // Total unique IDs = prefixes.length * 100
      expect(ids.size).toBe(prefixes.length * 100);
    });
  });

  describe('Format Consistency', () => {
    it('should always generate IDs of consistent length for same prefix', () => {
      const lengths = new Set<number>();

      for (let i = 0; i < 100; i++) {
        const id = generateUniqueId('test');
        lengths.add(id.length);
      }

      // All IDs should have same length: "test_" (5) + 32 chars = 37
      expect(lengths.size).toBe(1);
      expect(Array.from(lengths)[0]).toBe(37);
    });

    it('should generate valid identifiers (no spaces or special chars except underscore)', () => {
      const id = generateUniqueId('test');

      // Should only contain alphanumeric and underscore
      expect(id).toMatch(/^[a-z0-9_]+$/);
    });
  });

  describe('generateChecksummedId', () => {
    it('produces IDs with 34-char random+checksum portion', () => {
      const id = generateChecksummedId('minion');
      expect(id).toMatch(/^minion_[a-z2-7]{34}$/);
    });

    it('produces unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i++) ids.add(generateChecksummedId('test'));
      expect(ids.size).toBe(1000);
    });

    it('passes its own checksum validation', () => {
      for (let i = 0; i < 50; i++) {
        expect(validateIdChecksum(generateChecksummedId('minion'))).toBe('valid');
      }
    });
  });

  describe('validateIdChecksum', () => {
    it('returns valid for a correct checksummed ID', () => {
      const id = generateChecksummedId('minion');
      expect(validateIdChecksum(id)).toBe('valid');
    });

    it('returns invalid when the last 2 chars are tampered', () => {
      const id = generateChecksummedId('minion');
      // Flip the last character
      const lastChar = id[id.length - 1];
      const flipped = lastChar === 'a' ? 'b' : 'a';
      const tampered = id.slice(0, -1) + flipped;
      expect(validateIdChecksum(tampered)).toBe('invalid');
    });

    it('returns invalid when a middle character is substituted', () => {
      const id = generateChecksummedId('minion');
      const midIdx = Math.floor(id.length / 2);
      const midChar = id[midIdx];
      const replacement = midChar === 'a' ? 'b' : 'a';
      const tampered = id.slice(0, midIdx) + replacement + id.slice(midIdx + 1);
      expect(validateIdChecksum(tampered)).toBe('invalid');
    });

    it('detects transposition (position-dependent)', () => {
      const id = generateChecksummedId('minion');
      const arr = [...id];
      // Swap two adjacent chars in the random portion
      const swapIdx = 'minion_'.length + 5;
      if (arr[swapIdx] !== arr[swapIdx + 1]) {
        [arr[swapIdx], arr[swapIdx + 1]] = [arr[swapIdx + 1], arr[swapIdx]];
        expect(validateIdChecksum(arr.join(''))).toBe('invalid');
      }
    });

    it('returns no_checksum for legacy 32-char IDs', () => {
      const legacyId = generateUniqueId('minion'); // 32 chars after prefix
      expect(validateIdChecksum(legacyId)).toBe('no_checksum');
    });

    it('returns no_checksum for IDs without underscore', () => {
      expect(validateIdChecksum('nounderscore')).toBe('no_checksum');
    });

    it('returns invalid for wrong-length random parts (not 32 or 34)', () => {
      expect(validateIdChecksum('minion_abc')).toBe('no_checksum'); // too short
      expect(validateIdChecksum('minion_' + 'a'.repeat(35))).toBe('invalid'); // 35 chars
      expect(validateIdChecksum('minion_' + 'a'.repeat(36))).toBe('invalid'); // 36 chars
    });
  });
});
