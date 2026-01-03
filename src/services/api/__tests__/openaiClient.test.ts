import { describe, expect, it } from 'vitest';
import { OpenAIClient } from '../openaiClient';

describe('OpenAIClient.migrateMessageRendering', () => {
  const client = new OpenAIClient();

  describe('basic functionality', () => {
    it('should return empty renderingContent for empty array', () => {
      const result = client.migrateMessageRendering([], null);

      expect(result.renderingContent).toEqual([]);
      expect(result.stopReason).toBe('end_turn');
    });

    it('should handle string fullContent (legacy format)', () => {
      const result = client.migrateMessageRendering('Hello world', null);

      expect(result.renderingContent).toHaveLength(1);
      expect(result.renderingContent[0].category).toBe('text');
      expect(result.renderingContent[0].blocks).toHaveLength(1);
      expect(result.renderingContent[0].blocks[0]).toEqual({ type: 'text', text: 'Hello world' });
    });

    it('should handle empty string fullContent', () => {
      const result = client.migrateMessageRendering('', null);

      expect(result.renderingContent).toEqual([]);
    });

    it('should handle whitespace-only string fullContent', () => {
      const result = client.migrateMessageRendering('   ', null);

      expect(result.renderingContent).toEqual([]);
    });

    it('should handle null fullContent', () => {
      const result = client.migrateMessageRendering(null, null);

      expect(result.renderingContent).toEqual([]);
      expect(result.stopReason).toBe('end_turn');
    });

    it('should handle undefined fullContent', () => {
      const result = client.migrateMessageRendering(undefined, null);

      expect(result.renderingContent).toEqual([]);
      expect(result.stopReason).toBe('end_turn');
    });
  });

  describe('OpenAI content block format', () => {
    it('should convert text content blocks to TextRenderBlock', () => {
      const fullContent = [{ type: 'text', text: 'Hello world' }];

      const result = client.migrateMessageRendering(fullContent, null);

      expect(result.renderingContent).toHaveLength(1);
      expect(result.renderingContent[0].category).toBe('text');
      expect(result.renderingContent[0].blocks[0]).toEqual({ type: 'text', text: 'Hello world' });
    });

    it('should concatenate multiple text blocks', () => {
      const fullContent = [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
        { type: 'text', text: '!' },
      ];

      const result = client.migrateMessageRendering(fullContent, null);

      expect(result.renderingContent).toHaveLength(1);
      expect(result.renderingContent[0].blocks).toHaveLength(1);
      expect(result.renderingContent[0].blocks[0]).toEqual({ type: 'text', text: 'Hello world!' });
    });

    it('should skip blocks without text property', () => {
      const fullContent = [
        { type: 'text', text: 'Hello' },
        { type: 'image', url: 'http://example.com/image.jpg' },
        { type: 'text', text: ' world' },
      ];

      const result = client.migrateMessageRendering(fullContent, null);

      expect(result.renderingContent).toHaveLength(1);
      expect(result.renderingContent[0].blocks[0]).toEqual({ type: 'text', text: 'Hello world' });
    });

    it('should skip blocks with non-string text', () => {
      const fullContent = [
        { type: 'text', text: 'Valid' },
        { type: 'text', text: 123 },
        { type: 'text', text: null },
      ];

      const result = client.migrateMessageRendering(fullContent, null);

      expect(result.renderingContent).toHaveLength(1);
      expect(result.renderingContent[0].blocks[0]).toEqual({ type: 'text', text: 'Valid' });
    });
  });

  describe('stop reason mapping', () => {
    it('should map "stop" to end_turn', () => {
      const result = client.migrateMessageRendering([{ type: 'text', text: 'Hello' }], 'stop');
      expect(result.stopReason).toBe('end_turn');
    });

    it('should map "length" to max_tokens', () => {
      const result = client.migrateMessageRendering([{ type: 'text', text: 'Hello' }], 'length');
      expect(result.stopReason).toBe('max_tokens');
    });

    it('should map "tool_calls" to tool_use for agentic loop', () => {
      const result = client.migrateMessageRendering([{ type: 'text', text: 'test' }], 'tool_calls');
      expect(result.stopReason).toBe('tool_use');
    });

    it('should map "function_call" to tool_use for agentic loop', () => {
      const result = client.migrateMessageRendering(
        [{ type: 'text', text: 'test' }],
        'function_call'
      );
      expect(result.stopReason).toBe('tool_use');
    });

    it('should map "content_filter" to error', () => {
      const result = client.migrateMessageRendering(
        [{ type: 'text', text: 'Hello' }],
        'content_filter'
      );
      expect(result.stopReason).toBe('error');
    });

    it('should pass through unknown stop reasons', () => {
      const result = client.migrateMessageRendering(
        [{ type: 'text', text: 'Hello' }],
        'custom_reason'
      );
      expect(result.stopReason).toBe('custom_reason');
    });

    it('should default to end_turn for null stop reason', () => {
      const result = client.migrateMessageRendering([{ type: 'text', text: 'Hello' }], null);
      expect(result.stopReason).toBe('end_turn');
    });

    it('should default to end_turn for empty string stop reason', () => {
      const result = client.migrateMessageRendering([{ type: 'text', text: 'Hello' }], '');
      expect(result.stopReason).toBe('end_turn');
    });
  });

  describe('real-world content format', () => {
    it('should handle typical OpenAI response format', () => {
      // OpenAI Chat Completions typically stores fullContent as [{ type: 'text', text: '...' }]
      const fullContent = [
        {
          type: 'text',
          text: 'Here is a detailed response with multiple paragraphs.\n\nSecond paragraph here.',
        },
      ];

      const result = client.migrateMessageRendering(fullContent, 'stop');

      expect(result.renderingContent).toHaveLength(1);
      expect(result.renderingContent[0].category).toBe('text');
      expect(result.renderingContent[0].blocks[0]).toEqual({
        type: 'text',
        text: 'Here is a detailed response with multiple paragraphs.\n\nSecond paragraph here.',
      });
      expect(result.stopReason).toBe('end_turn');
    });

    it('should handle response with prefill prepended', () => {
      // When preFillResponse is used, the text includes both prefill and response
      const fullContent = [{ type: 'text', text: 'YoActual AI response continues here.' }];

      const result = client.migrateMessageRendering(fullContent, 'stop');

      expect(result.renderingContent).toHaveLength(1);
      expect(result.renderingContent[0].blocks[0]).toEqual({
        type: 'text',
        text: 'YoActual AI response continues here.',
      });
    });
  });
});
