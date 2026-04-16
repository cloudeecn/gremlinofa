/**
 * Tests for compression service
 */

import { describe, it, expect } from 'vitest';
import { compressString, decompressString } from '../compressionService';

describe('compressionService', () => {
  describe('compressString and decompressString', () => {
    it('should compress and decompress simple text', async () => {
      const original = 'Hello, world!';
      const compressed = await compressString(original);
      const decompressed = await decompressString(compressed);

      expect(decompressed).toBe(original);
      expect(compressed.length).toBeLessThan(original.length + 50); // Gzip overhead is small
    });

    it('should compress and decompress empty string', async () => {
      const original = '';
      const compressed = await compressString(original);
      const decompressed = await decompressString(compressed);

      expect(decompressed).toBe(original);
    });

    it('should compress and decompress special characters', async () => {
      const original = 'Special chars: 你好 🎉 \n\t\r\0 © ® ™';
      const compressed = await compressString(original);
      const decompressed = await decompressString(compressed);

      expect(decompressed).toBe(original);
    });

    it('should compress and decompress unicode', async () => {
      const original = '日本語 한국어 العربية עברית ελληνικά';
      const compressed = await compressString(original);
      const decompressed = await decompressString(compressed);

      expect(decompressed).toBe(original);
    });

    it('should compress and decompress emojis', async () => {
      const original = '😀 😃 😄 😁 🎉 🎊 🎈 🎆 🌟 ✨';
      const compressed = await compressString(original);
      const decompressed = await decompressString(compressed);

      expect(decompressed).toBe(original);
    });

    it('should compress and decompress JSON data', async () => {
      const original = JSON.stringify({
        id: 'test_123',
        role: 'user',
        content: 'Hello, how are you?',
        timestamp: '2025-01-01T00:00:00.000Z',
        metadata: {
          tokens: 10,
          cost: 0.001,
        },
      });

      const compressed = await compressString(original);
      const decompressed = await decompressString(compressed);

      expect(decompressed).toBe(original);
      expect(JSON.parse(decompressed)).toEqual(JSON.parse(original));
    });

    it('should achieve good compression ratio for repetitive data', async () => {
      const original = 'a'.repeat(1000);
      const compressed = await compressString(original);
      const decompressed = await decompressString(compressed);

      expect(decompressed).toBe(original);
      // Gzip should compress this very well (1000 bytes -> ~30 bytes)
      expect(compressed.length).toBeLessThan(100);
    });

    it('should handle large text (1MB)', async () => {
      // Create a large JSON-like message
      const largeMessage = {
        id: 'msg_large_test',
        role: 'assistant',
        content: 'Lorem ipsum dolor sit amet. '.repeat(10000), // ~300KB
        renderingContent: [
          {
            category: 'text',
            blocks: Array(100)
              .fill(null)
              .map((_, i) => ({
                type: 'text',
                text: `Block ${i}: Lorem ipsum dolor sit amet, consectetur adipiscing elit. `.repeat(
                  10
                ),
              })),
          },
        ],
      };

      const original = JSON.stringify(largeMessage);
      console.debug(`Original size: ${original.length} bytes`);

      const compressed = await compressString(original);
      console.debug(
        `Compressed size: ${compressed.length} bytes (${((compressed.length / original.length) * 100).toFixed(1)}%)`
      );

      const decompressed = await decompressString(compressed);

      expect(decompressed).toBe(original);
      expect(compressed.length).toBeLessThan(original.length * 0.5); // At least 50% compression
    });

    it('should handle typical message structure', async () => {
      const message = {
        id: 'msg_user_abc123',
        role: 'user',
        content: {
          text: 'What is the capital of France?',
          attachmentIds: [],
        },
        timestamp: '2025-01-01T12:00:00.000Z',
        metadata: {
          inputTokens: 8,
          cost: 0.00012,
        },
      };

      const original = JSON.stringify(message);
      const compressed = await compressString(original);
      const decompressed = await decompressString(compressed);

      expect(decompressed).toBe(original);
      expect(JSON.parse(decompressed)).toEqual(message);
    });

    it('should handle typical assistant response with renderingContent', async () => {
      const message = {
        id: 'msg_assistant_xyz789',
        role: 'assistant',
        content: '',
        renderingContent: [
          {
            category: 'backstage',
            blocks: [
              {
                type: 'thinking',
                thinking:
                  'The user is asking about the capital of France. This is a straightforward factual question. The answer is Paris.',
              },
            ],
          },
          {
            category: 'text',
            blocks: [
              {
                type: 'text',
                text: 'The capital of France is **Paris**. Paris is not only the capital but also the largest city in France, known for its art, culture, and landmarks like the Eiffel Tower.',
              },
            ],
          },
        ],
        fullContent: {
          type: 'anthropic',
          content: [
            {
              type: 'thinking',
              thinking:
                'The user is asking about the capital of France. This is a straightforward factual question. The answer is Paris.',
            },
            {
              type: 'text',
              text: 'The capital of France is **Paris**. Paris is not only the capital but also the largest city in France, known for its art, culture, and landmarks like the Eiffel Tower.',
            },
          ],
        },
        timestamp: '2025-01-01T12:00:01.500Z',
        metadata: {
          inputTokens: 15,
          outputTokens: 48,
          contextWindowUsage: 63,
          cost: 0.000567,
          model: 'claude-3-5-sonnet-20241022',
          stopReason: 'end_turn',
        },
      };

      const original = JSON.stringify(message);
      const compressed = await compressString(original);
      const decompressed = await decompressString(compressed);

      expect(decompressed).toBe(original);
      expect(JSON.parse(decompressed)).toEqual(message);
      // Should achieve reasonable compression
      expect(compressed.length).toBeLessThan(original.length);
    });

    it('should return Uint8Array from compressString', async () => {
      const original = 'test';
      const compressed = await compressString(original);

      expect(compressed).toBeInstanceOf(Uint8Array);
      expect(compressed.length).toBeGreaterThan(0);
    });

    it('should accept Uint8Array in decompressString', async () => {
      const original = 'test';
      const compressed = await compressString(original);

      // Should work with Uint8Array
      const decompressed = await decompressString(compressed);
      expect(decompressed).toBe(original);
    });
  });

  describe('error handling', () => {
    it('should throw error when decompressing invalid data', async () => {
      const invalidData = new Uint8Array([1, 2, 3, 4, 5]);

      await expect(decompressString(invalidData)).rejects.toThrow();
    });

    it('should throw error when decompressing corrupted gzip data', async () => {
      // Create valid gzip header but corrupt the data
      const corruptData = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff, 0xff, 0xff]);

      await expect(decompressString(corruptData)).rejects.toThrow();
    });
  });
});
