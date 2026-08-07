import { describe, expect, it, vi } from 'vitest';
import type { MockedClass } from 'vitest';
import OpenAI from 'openai';
import { OpenAIClient } from '../openaiClient';
import type { CompletionMessage } from '../completionStreamMapper';
import type { APIDefinition, Message } from '../../../protocol/types';
import type { UnifiedStorage } from '../../storage/unifiedStorage';
import { stubApiDeps } from './testStubs';

// Mock OpenAI SDK
vi.mock('openai');

describe('OpenAIClient.extractToolUseBlocks', () => {
  const client = new OpenAIClient(stubApiDeps);

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

describe('OpenAIClient verbosity', () => {
  const mockGetModel = vi.fn();
  const client = new OpenAIClient({
    ...stubApiDeps,
    storage: { getModel: mockGetModel } as unknown as UnifiedStorage,
  });

  const apiDefinition: APIDefinition = {
    id: 'test-api-def',
    apiType: 'chatgpt',
    name: 'Test OpenAI',
    baseUrl: '',
    apiKey: 'test-key',
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Drains a non-streaming call and hands back the request params the SDK saw.
  const captureRequest = async (
    model: Record<string, unknown> | undefined,
    verbosity?: 'low' | 'medium' | 'high'
  ) => {
    vi.clearAllMocks();
    mockGetModel.mockResolvedValueOnce(model);

    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: any) {
      return { chat: { completions: { create } } } as any;
    });

    const messages: Message<any>[] = [
      {
        id: 'msg1',
        role: 'user',
        content: { type: 'text', content: 'Hi' },
        timestamp: new Date(),
      },
    ];

    const generator = client.sendMessageStream(messages, 'gpt-5', apiDefinition, {
      temperature: 1,
      maxTokens: 2048,
      enableReasoning: true,
      reasoningBudgetTokens: 2048,
      signal: new AbortController().signal,
      disableStream: true,
      verbosity,
    });
    for await (const _chunk of generator) {
      // drain
    }

    return create.mock.calls[0][0];
  };

  it('sends verbosity top-level for models that support it', async () => {
    const request = await captureRequest(
      { id: 'gpt-5', apiType: 'chatgpt', supportsVerbosity: true },
      'high'
    );

    expect(request.verbosity).toBe('high');
  });

  it('omits verbosity for models without supportsVerbosity', async () => {
    const request = await captureRequest({ id: 'gpt-4o', apiType: 'chatgpt' }, 'high');

    expect(request.verbosity).toBeUndefined();
  });

  it('omits verbosity when the option is unset', async () => {
    const request = await captureRequest({
      id: 'gpt-5',
      apiType: 'chatgpt',
      supportsVerbosity: true,
    });

    expect(request.verbosity).toBeUndefined();
  });
});
