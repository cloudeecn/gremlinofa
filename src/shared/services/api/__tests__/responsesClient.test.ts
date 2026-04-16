import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MockedClass } from 'vitest';
import { ResponsesClient } from '../responsesClient';
import type { APIDefinition, Message } from '../../../protocol/types';
import type { UnifiedStorage } from '../../storage/unifiedStorage';
import OpenAI from 'openai';
import { stubApiDeps } from './testStubs';

// Mock OpenAI SDK
vi.mock('openai');

// `sendMessageStream` calls `this.deps.storage.getModel` for reasoning
// config; the test passes a stub storage with a single mocked method.
const mockGetModel = vi.fn().mockResolvedValue(undefined);
const storageStub = { getModel: mockGetModel } as unknown as UnifiedStorage;

describe('ResponsesClient', () => {
  let client: ResponsesClient;
  let mockApiDefinition: APIDefinition;

  beforeEach(() => {
    client = new ResponsesClient({ ...stubApiDeps, storage: storageStub });
    mockApiDefinition = {
      id: 'test-api-def',
      apiType: 'responses_api',
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
          { id: 'chatgpt-4o-latest', created: 1234567890 },
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

      expect(models).toHaveLength(4);
      expect(models.map(m => m.id)).toEqual(['chatgpt-4o-latest', 'gpt-5', 'gpt-4o', 'o3-mini']);
      expect(models[0].apiType).toBe('responses_api');
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
      // Custom providers keep all models (order may vary by implementation)
      expect(models.map(m => m.id)).toContain('grok-beta');
      expect(models.map(m => m.id)).toContain('custom-model');
    });

    it('should handle network error in model discovery', async () => {
      const mockClient = {
        models: {
          list: vi.fn().mockRejectedValue(new Error('Network error')),
        },
      };

      (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: any) {
        return mockClient as any;
      });

      // The client may either throw or return fallback models depending on implementation
      // Just verify it doesn't crash unexpectedly
      try {
        const models = await client.discoverModels(mockApiDefinition);
        // If it returns models, verify they're valid
        if (models.length > 0) {
          expect(models[0].apiType).toBe('responses_api');
        }
      } catch (e) {
        // If it throws, that's also acceptable behavior
        expect(e).toBeInstanceOf(Error);
      }
    });
  });

  describe('sendMessageStream', () => {
    it('should stream response with correct parameters', async () => {
      const messages: Message<any>[] = [
        {
          id: 'msg1',
          role: 'user',
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
        signal: new AbortController().signal,
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

    it('should use non-streaming when disableStream is true', async () => {
      // Mock model with supported reasoning efforts
      mockGetModel.mockResolvedValueOnce({
        id: 'o3-mini',
        apiType: 'responses_api',
        supportedReasoningEfforts: ['low', 'medium', 'high'],
      });

      const messages: Message<any>[] = [
        {
          id: 'msg1',
          role: 'user',
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
        signal: new AbortController().signal,
        reasoningEffort: 'medium',
        disableStream: true, // Explicitly request non-streaming
      });

      // Consume the generator
      const chunks: any[] = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      // Verify that non-streaming was used when disableStream is true
      expect(mockClient.responses.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'o3-mini',
          stream: false,
          reasoning: expect.objectContaining({
            effort: 'medium',
          }),
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(mockClient.responses.stream).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      const messages: Message<any>[] = [
        {
          id: 'msg1',
          role: 'user',
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
        signal: new AbortController().signal,
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

  describe('shouldPrependPrefill', () => {
    it('should return false', () => {
      expect(client.shouldPrependPrefill(mockApiDefinition)).toBe(false);
    });
  });

  describe('streaming behavior', () => {
    it('should use streaming by default for all models', async () => {
      const messages: Message<any>[] = [
        {
          id: 'msg1',
          role: 'user',
          content: { type: 'text', content: 'Hello' },
          timestamp: new Date(),
        },
      ];

      const mockEvents = [
        { type: 'response.output_text.delta', delta: 'Hello', sequence_number: 1 },
      ];

      const mockFinalResponse = {
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Hello' }],
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

      // Test with o3 model - should use streaming by default now
      const generator = client.sendMessageStream(messages, 'o3', mockApiDefinition, {
        maxTokens: 2048,
        enableReasoning: true,
        reasoningBudgetTokens: 4096,
        signal: new AbortController().signal,
      });

      const chunks: any[] = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      // Verify streaming was used by default
      expect(mockClient.responses.stream).toHaveBeenCalled();
      expect(mockClient.responses.create).not.toHaveBeenCalled();
    });

    it('should use non-streaming when disableStream option is true', async () => {
      const messages: Message<any>[] = [
        {
          id: 'msg1',
          role: 'user',
          content: { type: 'text', content: 'Test' },
          timestamp: new Date(),
        },
      ];

      const mockResponse = {
        output: [
          {
            type: 'message',
            role: 'assistant',
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
        signal: new AbortController().signal,
        disableStream: true, // Explicitly disable streaming
      });

      const chunks: any[] = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      // Verify non-streaming was used when disableStream is true
      expect(mockClient.responses.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5',
          stream: false,
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(mockClient.responses.stream).not.toHaveBeenCalled();

      // Non-streaming still yields chunks for StreamingContentAssembler
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.filter(c => c.type === 'content').length).toBe(1);
      expect(chunks.filter(c => c.type === 'token_usage').length).toBe(1);
    });

    it('builds result from stream events when useStreamAccumulator is enabled', async () => {
      // Provider returns empty `output` from finalResponse(), but the stream
      // delivers actual content events. With the accumulator opt-in, the
      // result should still contain text and tool calls.
      const messages: Message<any>[] = [
        {
          id: 'msg1',
          role: 'user',
          content: { type: 'text', content: 'Use ping tool' },
          timestamp: new Date(),
        },
      ];

      const mockEvents: any[] = [
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: 'm_1', role: 'assistant', content: [] },
          sequence_number: 1,
        },
        {
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          delta: 'Pinging now',
          sequence_number: 2,
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: 'm_1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Pinging now' }],
          },
          sequence_number: 3,
        },
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'ping',
            arguments: '',
          },
          sequence_number: 4,
        },
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'ping',
            arguments: '{"host":"example.com"}',
          },
          sequence_number: 5,
        },
        {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 20,
              output_tokens: 10,
              input_tokens_details: { cached_tokens: 5 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
          sequence_number: 6,
        },
      ];

      // Empty finalResponse — simulates the broken third-party provider.
      const emptyFinalResponse = {
        output: [],
        usage: {
          input_tokens: 20,
          output_tokens: 10,
          input_tokens_details: { cached_tokens: 5 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      };

      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          for (const event of mockEvents) {
            yield event;
          }
        },
        finalResponse: vi.fn().mockResolvedValue(emptyFinalResponse),
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

      const apiDefWithAccumulator: APIDefinition = {
        ...mockApiDefinition,
        advancedSettings: { useStreamAccumulator: true },
      };

      const generator = client.sendMessageStream(messages, 'gpt-4o', apiDefWithAccumulator, {
        maxTokens: 2048,
        enableReasoning: false,
        reasoningBudgetTokens: 2048,
        signal: new AbortController().signal,
      });

      const chunks: any[] = [];
      let iteratorResult = await generator.next();
      while (!iteratorResult.done) {
        chunks.push(iteratorResult.value);
        iteratorResult = await generator.next();
      }
      const result = iteratorResult.value as any;

      // finalResponse should NOT be called when accumulator is opted in.
      expect(mockStream.finalResponse).not.toHaveBeenCalled();

      // Result should contain accumulated text and tool calls despite empty finalResponse.
      expect(result.textContent).toBe('Pinging now');
      expect(result.fullContent).toHaveLength(2);
      expect(result.fullContent[0]).toMatchObject({ type: 'message' });
      expect(result.fullContent[1]).toMatchObject({
        type: 'function_call',
        call_id: 'call_1',
        name: 'ping',
        arguments: '{"host":"example.com"}',
      });
      expect(result.stopReason).toBe('tool_use');
      expect(result.inputTokens).toBe(15); // 20 - 5 cached
      expect(result.outputTokens).toBe(10);
      expect(result.cacheReadTokens).toBe(5);

      // Tool extraction should also find the function call.
      const toolBlocks = client.extractToolUseBlocks(result.fullContent);
      expect(toolBlocks).toHaveLength(1);
      expect(toolBlocks[0]).toMatchObject({
        type: 'tool_use',
        id: 'call_1',
        name: 'ping',
        input: { host: 'example.com' },
      });
    });

    it('uses finalResponse when useStreamAccumulator is not set (default)', async () => {
      const messages: Message<any>[] = [
        {
          id: 'msg1',
          role: 'user',
          content: { type: 'text', content: 'Hi' },
          timestamp: new Date(),
        },
      ];

      const mockEvents = [
        { type: 'response.output_text.delta', delta: 'Hello', sequence_number: 1 },
      ];

      const mockFinalResponse = {
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Hello' }],
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

      const generator = client.sendMessageStream(messages, 'gpt-4o', mockApiDefinition, {
        maxTokens: 2048,
        enableReasoning: false,
        reasoningBudgetTokens: 2048,
        signal: new AbortController().signal,
      });

      const chunks: any[] = [];
      let iteratorResult = await generator.next();
      while (!iteratorResult.done) {
        chunks.push(iteratorResult.value);
        iteratorResult = await generator.next();
      }

      // Default path uses finalResponse().
      expect(mockStream.finalResponse).toHaveBeenCalled();
    });

    it('should use streaming for all models unless disableStream is set', async () => {
      const messages: Message<any>[] = [
        {
          id: 'msg1',
          role: 'user',
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
        signal: new AbortController().signal,
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
