import { describe, expect, it } from 'vitest';
import { OpenAIClient } from '../openaiClient';
import type { CompletionMessage } from '../completionStreamMapper';

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

  describe('CompletionMessage fullContent format', () => {
    it('should handle CompletionMessage object with content only', () => {
      const fullContent: CompletionMessage = {
        role: 'assistant',
        content: 'Hello from Chat Completions',
        refusal: null,
      };

      const result = client.migrateMessageRendering(fullContent, 'stop');

      expect(result.renderingContent).toHaveLength(1);
      expect(result.renderingContent[0].category).toBe('text');
      expect(result.renderingContent[0].blocks[0]).toEqual({
        type: 'text',
        text: 'Hello from Chat Completions',
      });
      expect(result.stopReason).toBe('end_turn');
    });

    it('should handle CompletionMessage with null content', () => {
      const fullContent: CompletionMessage = {
        role: 'assistant',
        content: null,
        refusal: null,
      };

      const result = client.migrateMessageRendering(fullContent, null);

      expect(result.renderingContent).toEqual([]);
    });

    it('should handle CompletionMessage with tool_calls', () => {
      const fullContent: CompletionMessage = {
        role: 'assistant',
        content: 'Let me call a tool',
        tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'ping', arguments: '{}' } }],
        refusal: null,
      };

      const result = client.migrateMessageRendering(fullContent, 'tool_calls');

      // migrateMessageRendering only converts text, not tool_calls
      expect(result.renderingContent).toHaveLength(1);
      expect(result.renderingContent[0].blocks[0]).toEqual({
        type: 'text',
        text: 'Let me call a tool',
      });
      expect(result.stopReason).toBe('tool_use');
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

describe('OpenAIClient.buildToolResultMessage', () => {
  const client = new OpenAIClient();

  it('should build tool result message from single result', () => {
    const toolResults = [
      { type: 'tool_result' as const, tool_use_id: 'tc_1', content: 'pong', is_error: false },
    ];

    const message = client.buildToolResultMessage(toolResults);

    expect(message.role).toBe('user');
    expect(message.content.type).toBe('text');
    expect(message.content.content).toBe('');
    expect(message.content.modelFamily).toBe('chatgpt');
    expect(message.content.fullContent).toEqual([
      { type: 'tool_result', tool_call_id: 'tc_1', content: 'pong', is_error: false },
    ]);
  });

  it('should build tool result message from multiple results', () => {
    const toolResults = [
      { type: 'tool_result' as const, tool_use_id: 'tc_1', content: 'pong', is_error: false },
      { type: 'tool_result' as const, tool_use_id: 'tc_2', content: '42', is_error: false },
    ];

    const message = client.buildToolResultMessage(toolResults);

    expect(message.content.fullContent).toHaveLength(2);
    expect((message.content.fullContent as Array<unknown>)[0]).toEqual({
      type: 'tool_result',
      tool_call_id: 'tc_1',
      content: 'pong',
      is_error: false,
    });
    expect((message.content.fullContent as Array<unknown>)[1]).toEqual({
      type: 'tool_result',
      tool_call_id: 'tc_2',
      content: '42',
      is_error: false,
    });
  });

  it('should handle error results', () => {
    const toolResults = [
      {
        type: 'tool_result' as const,
        tool_use_id: 'tc_1',
        content: 'Error: File not found',
        is_error: true,
      },
    ];

    const message = client.buildToolResultMessage(toolResults);

    expect((message.content.fullContent as Array<unknown>)[0]).toEqual({
      type: 'tool_result',
      tool_call_id: 'tc_1',
      content: 'Error: File not found',
      is_error: true,
    });
  });

  it('should generate unique message id', () => {
    const message1 = client.buildToolResultMessage([
      { type: 'tool_result' as const, tool_use_id: 'tc_1', content: 'test', is_error: false },
    ]);
    const message2 = client.buildToolResultMessage([
      { type: 'tool_result' as const, tool_use_id: 'tc_2', content: 'test', is_error: false },
    ]);

    expect(message1.id).toMatch(/^msg_user_/);
    expect(message2.id).toMatch(/^msg_user_/);
  });

  it('should set timestamp to current time', () => {
    const before = new Date();
    const message = client.buildToolResultMessage([
      { type: 'tool_result' as const, tool_use_id: 'tc_1', content: 'test', is_error: false },
    ]);
    const after = new Date();

    expect(message.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(message.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
