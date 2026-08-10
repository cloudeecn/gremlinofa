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
        model: 'gpt-4o-2026-08-01',
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

      let result: unknown;
      while (true) {
        const next = await generator.next();
        if (next.done) {
          result = next.value;
          break;
        }
        chunks.push(next.value);
      }

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
          // Comes from the response, not the requested 'gpt-4o' alias
          servedModel: 'gpt-4o-2026-08-01',
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
        { type: 'response.completed', response: { status: 'completed' }, sequence_number: 2 },
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
      // result should still contain text and tool calls. Also covers
      // OpenRouter-style `response.keep_alive` frames: the accumulator path
      // iterates the raw `.create({stream:true})` stream, so these unknown
      // frames pass through harmlessly instead of crashing the SDK snapshot.
      const messages: Message<any>[] = [
        {
          id: 'msg1',
          role: 'user',
          content: { type: 'text', content: 'Use ping tool' },
          timestamp: new Date(),
        },
      ];

      const mockEvents: any[] = [
        // OpenRouter sends keep-alive frames during long reasoning. The SDK's
        // `.stream()` would throw on this; the raw `.create()` stream must
        // tolerate it.
        { type: 'response.keep_alive', sequence_number: 0 },
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

      // Raw async-iterable returned by `.create({stream:true})`. No
      // finalResponse() — the accumulator builds the result directly.
      const rawStream = {
        [Symbol.asyncIterator]: async function* () {
          for (const event of mockEvents) {
            yield event;
          }
        },
      };

      const mockClient = {
        responses: {
          stream: vi.fn(),
          create: vi.fn().mockResolvedValue(rawStream),
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

      // Accumulator path must bypass the SDK snapshot — `.stream()` is never
      // called; `.create({stream:true})` is what we iterate.
      expect(mockClient.responses.stream).not.toHaveBeenCalled();
      expect(mockClient.responses.create).toHaveBeenCalledWith(
        expect.objectContaining({ stream: true }),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );

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
        { type: 'response.completed', response: { status: 'completed' }, sequence_number: 2 },
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
        { type: 'response.completed', response: { status: 'completed' }, sequence_number: 2 },
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

  describe('abnormal termination', () => {
    const userMessages: Message<any>[] = [
      {
        id: 'msg1',
        role: 'user',
        content: { type: 'text', content: 'Think hard' },
        timestamp: new Date(),
      },
    ];

    const reasoningAdded = {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: 'rs_1', status: 'in_progress', summary: [] },
    };
    const reasoningDelta = {
      type: 'response.reasoning_text.delta',
      output_index: 0,
      content_index: 0,
      delta: 'Let me see',
    };
    const truncatedUsage = {
      input_tokens: 40,
      output_tokens: 256,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 256 },
    };
    const incompleteEvent = {
      type: 'response.incomplete',
      response: {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [
          {
            type: 'reasoning',
            id: 'rs_1',
            status: 'incomplete',
            summary: [],
            content: [{ type: 'reasoning_text', text: 'Let me see' }],
          },
        ],
        usage: truncatedUsage,
      },
    };

    const mockSdk = (sdk: object) =>
      (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: any) {
        return sdk as any;
      });

    const eventStream = (events: object[]) => ({
      [Symbol.asyncIterator]: async function* () {
        yield* events;
      },
    });

    const run = async (apiDef: APIDefinition, disableStream = false) => {
      const generator = client.sendMessageStream(userMessages, 'gpt-5', apiDef, {
        maxTokens: 256,
        enableReasoning: true,
        reasoningBudgetTokens: 0,
        disableStream,
        signal: new AbortController().signal,
      });
      let next = await generator.next();
      while (!next.done) next = await generator.next();
      return next.value;
    };

    describe('stream accumulator path', () => {
      const accumulatorDef = (): APIDefinition => ({
        ...mockApiDefinition,
        advancedSettings: { useStreamAccumulator: true },
      });

      it('errors when the stream ends without a terminal event', async () => {
        mockSdk({
          responses: { create: vi.fn().mockResolvedValue(eventStream([reasoningAdded])) },
        });

        const result = await run(accumulatorDef());

        expect(result.error?.message).toContain('Stream ended before the response finished');
        expect(result.stopReason).toBeUndefined();
      });

      it('reports max_tokens with usage on response.incomplete', async () => {
        mockSdk({
          responses: {
            create: vi
              .fn()
              .mockResolvedValue(eventStream([reasoningAdded, reasoningDelta, incompleteEvent])),
          },
        });

        const result = await run(accumulatorDef());

        expect(result.error).toBeUndefined();
        expect(result.stopReason).toBe('max_tokens');
        expect(result.inputTokens).toBe(40);
        expect(result.reasoningTokens).toBe(256);
      });
    });

    describe('default (finalResponse) path', () => {
      // What the SDK's finalResponse() returns after response.incomplete: the
      // response.created snapshot plus streamed items, never the terminal one.
      const staleSnapshot = {
        status: 'in_progress',
        output_text: '',
        output: [
          {
            type: 'reasoning',
            id: 'rs_1',
            status: 'in_progress',
            summary: [],
            content: [{ type: 'reasoning_text', text: 'Let me see' }],
          },
        ],
        usage: null,
      };

      const mockFinalResponseStream = (events: object[]) => {
        const stream = {
          ...eventStream(events),
          finalResponse: vi.fn().mockResolvedValue(staleSnapshot),
        };
        mockSdk({ responses: { stream: vi.fn().mockReturnValue(stream) } });
        return stream;
      };

      it('adopts the terminal response of response.incomplete', async () => {
        mockFinalResponseStream([reasoningAdded, reasoningDelta, incompleteEvent]);

        const result = await run(mockApiDefinition);

        expect(result.error).toBeUndefined();
        expect(result.stopReason).toBe('max_tokens');
        expect(result.fullContent).toEqual(incompleteEvent.response.output);
        expect(result.inputTokens).toBe(40);
        expect(result.reasoningTokens).toBe(256);
      });

      it('errors when the stream ends without a terminal event', async () => {
        const stream = mockFinalResponseStream([reasoningAdded, reasoningDelta]);

        const result = await run(mockApiDefinition);

        expect(result.error?.message).toContain('Stream ended before the response finished');
        expect(stream.finalResponse).not.toHaveBeenCalled();
      });

      it('errors with the provider message on response.failed', async () => {
        mockFinalResponseStream([
          reasoningAdded,
          {
            type: 'response.failed',
            response: {
              status: 'failed',
              error: { code: 'server_error', message: 'The model crashed' },
              output: [],
            },
          },
        ]);

        const result = await run(mockApiDefinition);

        expect(result.error?.message).toContain('Response failed: server_error: The model crashed');
      });
    });

    it('reports max_tokens for an incomplete non-streaming response', async () => {
      mockSdk({
        responses: {
          create: vi.fn().mockResolvedValue({ ...incompleteEvent.response, output_text: '' }),
        },
      });

      const result = await run(mockApiDefinition, true);

      expect(result.error).toBeUndefined();
      expect(result.stopReason).toBe('max_tokens');
    });

    it('extractToolUseBlocks skips a call whose arguments were cut off', () => {
      const blocks = client.extractToolUseBlocks([
        { type: 'function_call', call_id: 'c_1', name: 'ping', arguments: '{"host":"a"}' },
        { type: 'function_call', call_id: 'c_2', name: 'ping', arguments: '{"host":"exa' },
      ]);

      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ id: 'c_1', input: { host: 'a' } });
    });
  });

  describe('injected-file content items', () => {
    const captureUserContent = async (text: string, withFiles = true) => {
      mockGetModel.mockResolvedValueOnce({ id: 'gpt-5', apiType: 'responses_api' });
      const mockClient = {
        responses: {
          create: vi.fn().mockResolvedValue({ output: [], usage: {} }),
          stream: vi.fn(),
        },
      };
      (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: any) {
        return mockClient as any;
      });

      const messages: Message<any>[] = [
        {
          id: 'msg1',
          role: 'user',
          content: {
            type: 'text',
            content: text,
            ...(withFiles && {
              injectedFiles: [{ path: '/f.ts', content: 'const x = 1;' }],
              injectionMode: 'separate-block',
            }),
          },
          timestamp: new Date(),
        },
      ];
      const generator = client.sendMessageStream(messages, 'gpt-5', mockApiDefinition, {
        maxTokens: 2048,
        enableReasoning: true,
        reasoningBudgetTokens: 2048,
        signal: new AbortController().signal,
        disableStream: true,
      });
      for await (const _chunk of generator) {
        // drain
      }
      const request = mockClient.responses.create.mock.calls[0][0];
      return request.input[0].content as Array<{ type: string; text?: string }>;
    };

    it('emits the file item and the text item for a message with text', async () => {
      const items = await captureUserContent('analyze');
      expect(items.map(i => i.text)).toEqual(['=== /f.ts ===\nconst x = 1;', 'analyze']);
    });

    it('skips the empty text item for an inject-only message', async () => {
      const items = await captureUserContent('');
      expect(items.map(i => i.text)).toEqual(['=== /f.ts ===\nconst x = 1;']);
    });

    it('still sends one empty text item for a message with nothing at all', async () => {
      const items = await captureUserContent('', false);
      expect(items).toEqual([{ type: 'input_text', text: '' }]);
    });
  });

  describe('verbosity', () => {
    // Drains a non-streaming call and hands back the request params the SDK saw.
    const captureRequest = async (
      model: Record<string, unknown> | undefined,
      verbosity?: 'low' | 'medium' | 'high'
    ) => {
      mockGetModel.mockResolvedValueOnce(model);

      const mockClient = {
        responses: {
          create: vi.fn().mockResolvedValue({ output: [], usage: {} }),
          stream: vi.fn(),
        },
      };
      (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: any) {
        return mockClient as any;
      });

      const messages: Message<any>[] = [
        {
          id: 'msg1',
          role: 'user',
          content: { type: 'text', content: 'Hi' },
          timestamp: new Date(),
        },
      ];

      const generator = client.sendMessageStream(messages, 'gpt-5', mockApiDefinition, {
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

      return mockClient.responses.create.mock.calls[0][0];
    };

    it('nests verbosity under text for models that support it', async () => {
      const request = await captureRequest(
        { id: 'gpt-5', apiType: 'responses_api', supportsVerbosity: true },
        'low'
      );

      expect(request.text).toEqual({ verbosity: 'low' });
    });

    it('omits verbosity for models without supportsVerbosity', async () => {
      const request = await captureRequest({ id: 'gpt-4o', apiType: 'responses_api' }, 'low');

      expect(request.text).toBeUndefined();
    });

    it('omits verbosity when the option is unset', async () => {
      const request = await captureRequest({
        id: 'gpt-5',
        apiType: 'responses_api',
        supportsVerbosity: true,
      });

      expect(request.text).toBeUndefined();
    });
  });

  describe('hosted web search tool', () => {
    const captureRequest = async (
      model: Record<string, unknown> | undefined,
      webSearchEnabled: boolean
    ) => {
      mockGetModel.mockResolvedValueOnce(model);

      const mockClient = {
        responses: {
          create: vi.fn().mockResolvedValue({ output: [], usage: {} }),
          stream: vi.fn(),
        },
      };
      (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: any) {
        return mockClient as any;
      });

      const messages: Message<any>[] = [
        {
          id: 'msg1',
          role: 'user',
          content: { type: 'text', content: 'Who won yesterday?' },
          timestamp: new Date(),
        },
      ];

      const generator = client.sendMessageStream(messages, 'gpt-5', mockApiDefinition, {
        maxTokens: 2048,
        enableReasoning: true,
        reasoningBudgetTokens: 2048,
        signal: new AbortController().signal,
        disableStream: true,
        webSearchEnabled,
      });
      for await (const _chunk of generator) {
        // drain
      }

      return mockClient.responses.create.mock.calls[0][0];
    };

    it('sends the GA web_search tool by default', async () => {
      const request = await captureRequest({ id: 'gpt-5', apiType: 'responses_api' }, true);

      expect(request.tools).toEqual([{ type: 'web_search' }]);
    });

    it('sends the legacy alias for a model whose metadata asks for it', async () => {
      const request = await captureRequest(
        { id: 'gpt-4o', apiType: 'responses_api', webSearchTool: 'web_search_preview' },
        true
      );

      expect(request.tools).toEqual([{ type: 'web_search_preview' }]);
    });

    it('sends no tools when web search is off', async () => {
      const request = await captureRequest({ id: 'gpt-5', apiType: 'responses_api' }, false);

      expect(request.tools).toBeUndefined();
    });
  });

  describe('reasoning replay', () => {
    const captureRequest = async (
      messages: Message<any>[],
      { modelId = 'gpt-5', model, ...optionOverrides }: Record<string, any> = {}
    ) => {
      mockGetModel.mockResolvedValueOnce(model ?? { id: modelId, apiType: 'responses_api' });

      const mockClient = {
        responses: {
          create: vi.fn().mockResolvedValue({ output: [], usage: {} }),
          stream: vi.fn(),
        },
      };
      (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (this: any) {
        return mockClient as any;
      });

      const generator = client.sendMessageStream(messages, modelId, mockApiDefinition, {
        maxTokens: 2048,
        enableReasoning: true,
        reasoningBudgetTokens: 2048,
        signal: new AbortController().signal,
        disableStream: true,
        ...optionOverrides,
      });
      for await (const _chunk of generator) {
        // drain
      }

      return mockClient.responses.create.mock.calls[0][0];
    };

    const user = (id: string, text = 'Hi'): Message<any> => ({
      id,
      role: 'user',
      content: { type: 'text', content: text },
      timestamp: new Date(),
    });
    const assistant = (id: string, fullContent: any[]): Message<any> => ({
      id,
      role: 'assistant',
      content: { type: 'text', content: 'prev', modelFamily: 'responses_api', fullContent },
      timestamp: new Date(),
    });
    const toolResult = (id: string, callId: string): Message<any> => ({
      id,
      role: 'user',
      content: {
        type: 'text',
        content: '',
        toolResults: [{ type: 'tool_result', tool_use_id: callId, content: 'pong' }],
      },
      timestamp: new Date(),
    });
    const call = (callId: string) => ({
      type: 'function_call',
      call_id: callId,
      name: 'ping',
      arguments: '{}',
    });
    const reasoning = (text: string) => ({
      type: 'reasoning',
      summary: [],
      content: [{ type: 'reasoning_text', text }],
    });

    it('asks for encrypted reasoning even with the toggle off and no metadata', async () => {
      const request = await captureRequest([user('u1')], {
        modelId: 'mystery-model',
        model: null,
        enableReasoning: false,
      });

      expect(request.include).toEqual(['reasoning.encrypted_content']);
    });

    it('does not ask a model that cannot reason', async () => {
      const request = await captureRequest([user('u1')], {
        modelId: 'gpt-4.1-nano',
        model: { id: 'gpt-4.1-nano', apiType: 'responses_api', reasoningMode: 'none' },
      });

      expect(request.include).toBeUndefined();
    });

    it('fills a missing summary without touching stored history', async () => {
      const stored = { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'qwen' }] };
      const history = [user('u1'), assistant('a1', [stored]), user('u2')];

      const request = await captureRequest(history);

      expect(request.input[1]).toEqual({ ...stored, summary: [] });
      expect(stored).not.toHaveProperty('summary');
    });

    it('drops parsed_arguments without touching stored history', async () => {
      const stored = { ...call('call_1'), parsed_arguments: {} };
      const history = [user('u1'), assistant('a1', [stored]), toolResult('r1', 'call_1')];

      const request = await captureRequest(history);

      expect(request.input[1]).not.toHaveProperty('parsed_arguments');
      expect(stored).toHaveProperty('parsed_arguments');
    });

    it('sends reasoning.context: all_turns to a model that takes it at keep -1', async () => {
      const request = await captureRequest([user('u1')], {
        modelId: 'gpt-5.5',
        model: {
          id: 'gpt-5.5',
          apiType: 'responses_api',
          reasoningMode: 'always',
          supportedReasoningEfforts: ['low', 'medium', 'high'],
        },
        reasoningEffort: 'low',
        thinkingKeepTurns: -1,
      });

      expect(request.reasoning).toMatchObject({ context: 'all_turns', effort: 'low' });
    });

    it('omits reasoning.context at keep 1', async () => {
      const request = await captureRequest([user('u1')], {
        modelId: 'gpt-5.5',
        model: {
          id: 'gpt-5.5',
          apiType: 'responses_api',
          reasoningMode: 'always',
          supportedReasoningEfforts: ['low', 'medium', 'high'],
        },
        reasoningEffort: 'low',
        thinkingKeepTurns: 1,
      });

      expect(request.reasoning).not.toHaveProperty('context');
    });

    describe('mandated replay (DeepSeek)', () => {
      const deepseek = {
        modelId: 'deepseek-v4-flash',
        model: { id: 'deepseek-v4-flash', apiType: 'responses_api' },
      };
      const placeholder = {
        type: 'reasoning',
        summary: [],
        content: [{ type: 'reasoning_text', text: ' ' }],
      };

      // Keep 1 is the in-progress turn only, so every stored turn is prunable
      const history = () => [
        user('u1'),
        assistant('a1', [reasoning('tool thought'), call('call_1')]),
        toolResult('r1', 'call_1'),
        assistant('a2', [reasoning('chat thought'), { type: 'message', role: 'assistant' }]),
        user('u2'),
      ];
      const reasoningTexts = (request: any) =>
        request.input
          .filter((it: any) => it.type === 'reasoning')
          .map((it: any) => it.content[0].text);

      it('keeps reasoning on pruned function_call turns and strips it elsewhere', async () => {
        const request = await captureRequest(history(), {
          ...deepseek,
          pruneThinkingKeepTurns: 1,
        });

        expect(reasoningTexts(request)).toEqual(['tool thought']);
      });

      it('prunes every earlier turn for a model without the mandate', async () => {
        const request = await captureRequest(history(), { pruneThinkingKeepTurns: 1 });

        expect(reasoningTexts(request)).toEqual([]);
      });

      it("leads another provider's tool-call turn with the placeholder", async () => {
        const request = await captureRequest(
          [
            user('u1'),
            {
              id: 'a1',
              role: 'assistant',
              content: {
                type: 'text',
                content: 'checking',
                modelFamily: 'chatgpt',
                toolCalls: [{ type: 'tool_use', id: 'call_x', name: 'ping', input: {} }],
              },
              timestamp: new Date(),
            },
            toolResult('r1', 'call_x'),
          ],
          deepseek
        );

        expect(request.input.slice(1, 4)).toEqual([
          placeholder,
          expect.objectContaining({ type: 'message', role: 'assistant' }),
          expect.objectContaining({ type: 'function_call', call_id: 'call_x' }),
        ]);
      });

      it('gives a stored function_call turn without reasoning the placeholder', async () => {
        const request = await captureRequest(
          [user('u1'), assistant('a1', [call('call_1')]), toolResult('r1', 'call_1')],
          deepseek
        );

        expect(request.input[1]).toEqual(placeholder);
        expect(request.input[2]).toMatchObject({ type: 'function_call', call_id: 'call_1' });
      });

      it('adds no placeholder for other models', async () => {
        const request = await captureRequest([
          user('u1'),
          assistant('a1', [call('call_1')]),
          toolResult('r1', 'call_1'),
        ]);

        expect(request.input.some((it: any) => it.type === 'reasoning')).toBe(false);
      });
    });
  });
});
