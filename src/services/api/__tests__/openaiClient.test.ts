import { describe, expect, it } from 'vitest';
import { OpenAIClient } from '../openaiClient';
import type { CompletionMessage } from '../completionStreamMapper';

describe('OpenAIClient.extractToolUseBlocks', () => {
  const client = new OpenAIClient();

  describe('CompletionMessage format (new)', () => {
    it('should extract tool_use blocks from CompletionMessage with tool_calls', () => {
      const fullContent: CompletionMessage = {
        role: 'assistant',
        content: 'Let me ping',
        tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'ping', arguments: '{}' } }],
        refusal: null,
      };

      const blocks = client.extractToolUseBlocks(fullContent);

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual({
        type: 'tool_use',
        id: 'tc_1',
        name: 'ping',
        input: {},
      });
    });

    it('should extract multiple tool_use blocks', () => {
      const fullContent: CompletionMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'tc_1', type: 'function', function: { name: 'ping', arguments: '{}' } },
          {
            id: 'tc_2',
            type: 'function',
            function: { name: 'javascript', arguments: '{"code":"return 42;"}' },
          },
        ],
        refusal: null,
      };

      const blocks = client.extractToolUseBlocks(fullContent);

      expect(blocks).toHaveLength(2);
      expect(blocks[0].name).toBe('ping');
      expect(blocks[1].name).toBe('javascript');
      expect(blocks[1].input).toEqual({ code: 'return 42;' });
    });

    it('should return empty array when no tool_calls', () => {
      const fullContent: CompletionMessage = {
        role: 'assistant',
        content: 'Hello',
        refusal: null,
      };

      const blocks = client.extractToolUseBlocks(fullContent);

      expect(blocks).toEqual([]);
    });

    it('should handle empty tool_calls array', () => {
      const fullContent: CompletionMessage = {
        role: 'assistant',
        content: 'Hello',
        tool_calls: [],
        refusal: null,
      };

      const blocks = client.extractToolUseBlocks(fullContent);

      expect(blocks).toEqual([]);
    });
  });

  describe('legacy array format', () => {
    it('should extract tool_use blocks from legacy array format', () => {
      const fullContent = [
        { type: 'text', text: 'Let me ping' },
        {
          type: 'tool_calls',
          tool_calls: [
            { id: 'tc_1', type: 'function', function: { name: 'ping', arguments: '{}' } },
          ],
        },
      ];

      const blocks = client.extractToolUseBlocks(fullContent);

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual({
        type: 'tool_use',
        id: 'tc_1',
        name: 'ping',
        input: {},
      });
    });

    it('should return empty array for legacy format without tool_calls block', () => {
      const fullContent = [{ type: 'text', text: 'Hello' }];

      const blocks = client.extractToolUseBlocks(fullContent);

      expect(blocks).toEqual([]);
    });
  });

  describe('edge cases', () => {
    it('should return empty array for null fullContent', () => {
      const blocks = client.extractToolUseBlocks(null);
      expect(blocks).toEqual([]);
    });

    it('should return empty array for undefined fullContent', () => {
      const blocks = client.extractToolUseBlocks(undefined);
      expect(blocks).toEqual([]);
    });

    it('should handle empty string arguments', () => {
      const fullContent: CompletionMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'ping', arguments: '' } }],
        refusal: null,
      };

      const blocks = client.extractToolUseBlocks(fullContent);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].input).toEqual({});
    });
  });
});
