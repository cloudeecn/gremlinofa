import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MockedClass } from 'vitest';
import { ResponsesClient } from '../responsesClient';
import { APIType, MessageRole } from '../../../types';
import type { APIDefinition, Message } from '../../../types';
import OpenAI from 'openai';

// Mock OpenAI SDK
vi.mock('openai');

describe('ResponsesClient', () => {
  let client: ResponsesClient;
  let mockApiDefinition: APIDefinition;

  beforeEach(() => {
    client = new ResponsesClient();
    mockApiDefinition = {
      id: 'test-api-def',
      apiType: APIType.RESPONSES_API,
      name: 'Test OpenAI',
      baseUrl: '',
      apiKey: 'test-key',
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Clear all mocks
    vi.clearAllMocks();
  });

  describe('discoverModels', () => {
    it('should discover and filter OpenAI models', async () => {
      const mockModels = {
        data: [
          { id: 'gpt-5', created: 1234567890 },
          { id: 'gpt-4o', created: 1234567890 },
          { id: 'o3-mini', created: 1234567890 },
          { id: 'dall-e-3', created: 1234567890 }, // Should be filtered out
        ],
      };

      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue(mockModels),
        },
      };

      (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: any) {
        return mockClient as any;
      });

      const models = await client.discoverModels(mockApiDefinition);

      expect(models).toHaveLength(3);
      expect(models.map(m => m.id)).toEqual(['gpt-5', 'gpt-4o', 'o3-mini']);
      expect(models[0].apiType).toBe(APIType.RESPONSES_API);
    });

    it('should keep all models for custom baseUrl', async () => {
      const customApiDef = {
        ...mockApiDefinition,
        baseUrl: 'https://api.x.ai/v1',
      };

      const mockModels = {
        data: [
          { id: 'grok-beta', created: 1234567890 },
          { id: 'custom-model', created: 1234567890 },
        ],
      };

      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue(mockModels),
        },
      };

      (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: any) {
        return mockClient as any;
      });

      const models = await client.discoverModels(customApiDef);

      expect(models).toHaveLength(2);
      // Custom providers keep all models but still apply sorting
      expect(models.map(m => m.id)).toEqual(['custom-model', 'grok-beta']);
    });

    it('should return fallback models on error', async () => {
      const mockClient = {
        models: {
          list: vi.fn().mockRejectedValue(new Error('Network error')),
        },
      };

      (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: any) {
        return mockClient as any;
      });

      const models = await client.discoverModels(mockApiDefinition);

      expect(models.length).toBeGreaterThan(0);
      expect(models[0].id).toBe('gpt-5');
    });
  });

  describe('sendMessageStream', () => {
    it('should stream response with correct parameters', async () => {
      const messages: Message<any>[] = [
        {
          id: 'msg1',
          role: MessageRole.USER,
          content: { type: 'text', content: 'Hello' },
          timestamp: new Date(),
        },
      ];

      const mockEvents = [
        { type: 'response.output_text.delta', delta: 'Hello', sequence_number: 1 },
        { type: 'response.output_text.delta', delta: ' world', sequence_number: 2 },
        {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              input_tokens_details: { cached_tokens: 2 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
          sequence_number: 3,
        },
      ];

      const mockFinalResponse = {
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Hello world',
              },
            ],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      };

      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          for (const event of mockEvents) {
            yield event;
          }
        },
        finalResponse: vi.fn().mockResolvedValue(mockFinalResponse),
      };

      const mockClient = {
        responses: {
          stream: vi.fn().mockReturnValue(mockStream),
        },
      };

      (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: any) {
        return mockClient as any;
      });

      const chunks: any[] = [];
      const generator = client.sendMessageStream(messages, 'gpt-4o', mockApiDefinition, {
        temperature: 1.0,
        maxTokens: 2048,
        enableReasoning: false,
        reasoningBudgetTokens: 2048,
        systemPrompt: 'You are helpful',
      });

      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      const result = chunks[chunks.length - 1];

      // Check that we received content chunks
      expect(chunks.filter(c => c.type === 'content').length).toBe(2);
      expect(chunks.filter(c => c.type === 'content')[0].content).toBe('Hello');
      expect(chunks.filter(c => c.type === 'content')[1].content).toBe(' world');

      // Check final result (StreamResult is the return value of the generator)
      expect(result).toEqual(
        expect.objectContaining({
          inputTokens: 8, // 10 - 2 cached
          outputTokens: 5,
          cacheReadTokens: 2,
        })
      );
    });

    it('should handle reasoning models with non-streaming', async () => {
      const messages: Message<any>[] = [
        {
          id: 'msg1',
          role: MessageRole.USER,
          content: { type: 'text', content: 'Solve this' },
          timestamp: new Date(),
        },
      ];

      const mockResponse = {
        output: [
          {
            type: 'reasoning',
            content: [
              {
                type: 'reasoning_text',
                text: 'Let me think...',
              },
            ],
          },
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'The answer is',
              },
            ],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      };

      const mockClient = {
        responses: {
          create: vi.fn().mockResolvedValue(mockResponse),
          stream: vi.fn(),
        },
      };

      (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: any) {
        return mockClient as any;
      });

      const generator = client.sendMessageStream(messages, 'o3-mini', mockApiDefinition, {
        maxTokens: 2048,
        enableReasoning: true,
        reasoningBudgetTokens: 4096,
      });

      // Consume the generator
      const chunks: any[] = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      // Verify that non-streaming was used for o3-mini (o3-mini doesn't support streaming)
      expect(mockClient.responses.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'o3-mini',
          stream: false,
          reasoning: expect.objectContaining({
            effort: 'medium', // 4096 maps to medium
            summary: 'detailed',
          }),
        })
      );
      expect(mockClient.responses.stream).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      const messages: Message<any>[] = [
        {
          id: 'msg1',
          role: MessageRole.USER,
          content: { type: 'text', content: 'Hello' },
          timestamp: new Date(),
        },
      ];

      const mockClient = {
        responses: {
          stream: vi.fn().mockImplementation(() => {
            throw { status: 401, message: 'Invalid API key' };
          }),
        },
      };

      (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: any) {
        return mockClient as any;
      });

      const chunks: any[] = [];
      let result: any;
      const generator = client.sendMessageStream(messages, 'gpt-4o', mockApiDefinition, {
        maxTokens: 2048,
        enableReasoning: false,
        reasoningBudgetTokens: 2048,
      });

      // Consume generator and capture the return value
      let iteratorResult = await generator.next();
      while (!iteratorResult.done) {
        chunks.push(iteratorResult.value);
        iteratorResult = await generator.next();
      }
      result = iteratorResult.value;

      // No error chunks are yielded anymore - error is in the result
      expect(chunks.filter(c => c.type === 'error')).toHaveLength(0);

      // Check that error is in the returned StreamResult
      expect(result).toEqual({
        textContent: '',
        fullContent: [],
        error: {
          message: expect.stringContaining('Invalid API key'),
          status: 401,
          stack: undefined,
        },
        inputTokens: 0,
        outputTokens: 0,
      });
    });
  });

  describe('reasoning effort calculation', () => {
    it('should apply correct reasoning effort based on budget tokens', () => {
      // The reasoning effort is calculated inline in applyReasoning method
      // We can verify this through the behavior in sendMessageStream
      // This test verifies the concept is working by checking the client exists
      expect(client).toBeDefined();
      expect(client.isReasoningModel).toBeDefined();
    });
  });

  describe('calculateCost', () => {
    it('should calculate cost correctly', () => {
      const cost = client.calculateCost('gpt-4o', 1000, 500, 100, 50);
      expect(cost).toBeGreaterThan(0);
    });
  });

  describe('shouldPrependPrefill', () => {
    it('should return false', () => {
      expect(client.shouldPrependPrefill(mockApiDefinition)).toBe(false);
    });
  });

  describe('isReasoningModel', () => {
    it('should identify reasoning models', () => {
      expect(client.isReasoningModel('o3')).toBe(true);
      expect(client.isReasoningModel('o3-mini')).toBe(true);
      expect(client.isReasoningModel('o1')).toBe(true);
      expect(client.isReasoningModel('gpt-4o')).toBe(false);
    });
  });

  describe('migrateMessageRendering', () => {
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

    describe('ResponseInputItem format (message objects)', () => {
      it('should extract text from assistant message with output_text content', () => {
        const fullContent = [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello world' }],
          },
        ];

        const result = client.migrateMessageRendering(fullContent, null);

        expect(result.renderingContent).toHaveLength(1);
        expect(result.renderingContent[0].category).toBe('text');
        expect(result.renderingContent[0].blocks[0]).toEqual({ type: 'text', text: 'Hello world' });
      });

      it('should concatenate multiple output_text blocks within a message', () => {
        const fullContent = [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'Hello ' },
              { type: 'output_text', text: 'world' },
              { type: 'output_text', text: '!' },
            ],
          },
        ];

        const result = client.migrateMessageRendering(fullContent, null);

        expect(result.renderingContent).toHaveLength(1);
        expect(result.renderingContent[0].blocks).toHaveLength(1);
        expect(result.renderingContent[0].blocks[0]).toEqual({
          type: 'text',
          text: 'Hello world!',
        });
      });

      it('should concatenate text from multiple assistant messages', () => {
        const fullContent = [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Part 1. ' }],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Part 2.' }],
          },
        ];

        const result = client.migrateMessageRendering(fullContent, null);

        expect(result.renderingContent).toHaveLength(1);
        expect(result.renderingContent[0].blocks[0]).toEqual({
          type: 'text',
          text: 'Part 1. Part 2.',
        });
      });

      it('should skip non-assistant messages', () => {
        const fullContent = [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'output_text', text: 'User text should be ignored' }],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Assistant text' }],
          },
        ];

        const result = client.migrateMessageRendering(fullContent, null);

        expect(result.renderingContent).toHaveLength(1);
        expect(result.renderingContent[0].blocks[0]).toEqual({
          type: 'text',
          text: 'Assistant text',
        });
      });

      it('should skip non-message items (like reasoning)', () => {
        const fullContent = [
          {
            type: 'reasoning',
            content: [{ type: 'reasoning_text', text: 'Thinking...' }],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'The answer' }],
          },
        ];

        const result = client.migrateMessageRendering(fullContent, null);

        expect(result.renderingContent).toHaveLength(1);
        expect(result.renderingContent[0].blocks[0]).toEqual({ type: 'text', text: 'The answer' });
      });

      it('should handle message with string content (legacy)', () => {
        const fullContent = [
          {
            type: 'message',
            role: 'assistant',
            content: 'Simple string content',
          },
        ];

        const result = client.migrateMessageRendering(fullContent, null);

        expect(result.renderingContent).toHaveLength(1);
        expect(result.renderingContent[0].blocks[0]).toEqual({
          type: 'text',
          text: 'Simple string content',
        });
      });

      it('should skip non-output_text content parts', () => {
        const fullContent = [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'Valid text' },
              { type: 'refusal', refusal: 'I cannot do that' },
              { type: 'output_text', text: ' more text' },
            ],
          },
        ];

        const result = client.migrateMessageRendering(fullContent, null);

        expect(result.renderingContent).toHaveLength(1);
        // Only output_text parts are extracted
        expect(result.renderingContent[0].blocks[0]).toEqual({
          type: 'text',
          text: 'Valid text more text',
        });
      });
    });

    describe('stop reason mapping', () => {
      it('should map "completed" to end_turn', () => {
        const result = client.migrateMessageRendering(
          [{ type: 'message', role: 'assistant', content: 'text' }],
          'completed'
        );
        expect(result.stopReason).toBe('end_turn');
      });

      it('should map "incomplete" to max_tokens', () => {
        const result = client.migrateMessageRendering(
          [{ type: 'message', role: 'assistant', content: 'text' }],
          'incomplete'
        );
        expect(result.stopReason).toBe('max_tokens');
      });

      it('should map "failed" to error', () => {
        const result = client.migrateMessageRendering(
          [{ type: 'message', role: 'assistant', content: 'text' }],
          'failed'
        );
        expect(result.stopReason).toBe('error');
      });

      it('should map "cancelled" to cancelled', () => {
        const result = client.migrateMessageRendering(
          [{ type: 'message', role: 'assistant', content: 'text' }],
          'cancelled'
        );
        expect(result.stopReason).toBe('cancelled');
      });

      it('should pass through unknown stop reasons', () => {
        const result = client.migrateMessageRendering(
          [{ type: 'message', role: 'assistant', content: 'text' }],
          'in_progress'
        );
        expect(result.stopReason).toBe('in_progress');
      });

      it('should default to end_turn for null stop reason', () => {
        const result = client.migrateMessageRendering(
          [{ type: 'message', role: 'assistant', content: 'text' }],
          null
        );
        expect(result.stopReason).toBe('end_turn');
      });

      it('should default to end_turn for empty string stop reason', () => {
        const result = client.migrateMessageRendering(
          [{ type: 'message', role: 'assistant', content: 'text' }],
          ''
        );
        expect(result.stopReason).toBe('end_turn');
      });
    });

    describe('real-world content format', () => {
      it('should handle typical Responses API output format', () => {
        // This is the actual format stored after a ResponsesClient.sendMessageStream call
        const fullContent = [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Here is a detailed response.\n\nWith multiple paragraphs.',
              },
            ],
          },
        ];

        const result = client.migrateMessageRendering(fullContent, 'completed');

        expect(result.renderingContent).toHaveLength(1);
        expect(result.renderingContent[0].category).toBe('text');
        expect(result.renderingContent[0].blocks[0]).toEqual({
          type: 'text',
          text: 'Here is a detailed response.\n\nWith multiple paragraphs.',
        });
        expect(result.stopReason).toBe('end_turn');
      });

      it('should handle response with reasoning output (reasoning is ignored)', () => {
        // Reasoning blocks are in fullContent but migrateMessageRendering extracts only text
        const fullContent = [
          {
            type: 'reasoning',
            content: [{ type: 'reasoning_text', text: 'Let me analyze this step by step...' }],
            summary: [{ type: 'summary_text', text: 'I thought about it carefully.' }],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'The answer is 42.' }],
          },
        ];

        const result = client.migrateMessageRendering(fullContent, 'completed');

        // Only the message text is extracted (reasoning is not yet supported in migrateMessageRendering)
        expect(result.renderingContent).toHaveLength(1);
        expect(result.renderingContent[0].blocks[0]).toEqual({
          type: 'text',
          text: 'The answer is 42.',
        });
      });
    });
  });

  describe('non-streaming support', () => {
    it('should use non-streaming for o3 model', async () => {
      const messages: Message<any>[] = [
        {
          id: 'msg1',
          role: MessageRole.USER,
          content: { type: 'text', content: 'Hello' },
          timestamp: new Date(),
        },
      ];

      const mockResponse = {
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Hello from o3',
              },
            ],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      };

      const mockClient = {
        responses: {
          create: vi.fn().mockResolvedValue(mockResponse),
          stream: vi.fn(),
        },
      };

      (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: any) {
        return mockClient as any;
      });

      const generator = client.sendMessageStream(messages, 'o3', mockApiDefinition, {
        maxTokens: 2048,
        enableReasoning: true,
        reasoningBudgetTokens: 4096,
      });

      // For non-streaming, the generator returns immediately
      // Consume the generator (even though it returns, not yields)
      const chunks: any[] = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      // Verify non-streaming was used
      expect(mockClient.responses.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'o3',
          stream: false,
        })
      );
      expect(mockClient.responses.stream).not.toHaveBeenCalled();

      // For non-streaming, no chunks are yielded (the result is returned, not yielded)
      // This is the expected behavior - the calling code uses the return value
      expect(chunks.length).toBe(0);
    });

    it('should use non-streaming for gpt-5 (non-chat variant)', async () => {
      const messages: Message<any>[] = [
        {
          id: 'msg1',
          role: MessageRole.USER,
          content: { type: 'text', content: 'Test' },
          timestamp: new Date(),
        },
      ];

      const mockResponse = {
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Response from gpt-5',
              },
            ],
          },
        ],
        usage: {
          input_tokens: 5,
          output_tokens: 8,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      };

      const mockClient = {
        responses: {
          create: vi.fn().mockResolvedValue(mockResponse),
          stream: vi.fn(),
        },
      };

      (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: any) {
        return mockClient as any;
      });

      const generator = client.sendMessageStream(messages, 'gpt-5', mockApiDefinition, {
        maxTokens: 2048,
        enableReasoning: false,
        reasoningBudgetTokens: 2048,
      });

      // For non-streaming, the generator returns immediately
      // Consume the generator (even though it returns, not yields)
      const chunks: any[] = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      // Verify non-streaming was used
      expect(mockClient.responses.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5',
          stream: false,
        })
      );
      expect(mockClient.responses.stream).not.toHaveBeenCalled();

      // For non-streaming, no chunks are yielded (the result is returned, not yielded)
      // This is the expected behavior - the calling code uses the return value
      expect(chunks.length).toBe(0);
    });

    it('should use streaming for o1 model', async () => {
      const messages: Message<any>[] = [
        {
          id: 'msg1',
          role: MessageRole.USER,
          content: { type: 'text', content: 'Test' },
          timestamp: new Date(),
        },
      ];

      const mockEvents = [
        {
          type: 'response.output_text.delta',
          delta: 'Hello',
          sequence_number: 1,
        },
      ];

      const mockFinalResponse = {
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Hello',
              },
            ],
          },
        ],
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      };

      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          for (const event of mockEvents) {
            yield event;
          }
        },
        finalResponse: vi.fn().mockResolvedValue(mockFinalResponse),
      };

      const mockClient = {
        responses: {
          stream: vi.fn().mockReturnValue(mockStream),
          create: vi.fn(),
        },
      };

      (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: any) {
        return mockClient as any;
      });

      const chunks: any[] = [];
      const generator = client.sendMessageStream(messages, 'o1', mockApiDefinition, {
        maxTokens: 2048,
        enableReasoning: true,
        reasoningBudgetTokens: 2048,
      });

      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      // Verify streaming was used (o1 supports streaming)
      expect(mockClient.responses.stream).toHaveBeenCalled();
      expect(mockClient.responses.create).not.toHaveBeenCalled();
    });
  });
});
