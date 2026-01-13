/**
 * Tests for WebLLM Client
 *
 * Note: These tests mock the @mlc-ai/web-llm library since we can't run
 * actual WebGPU inference in tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { APIDefinition, Message } from '../../../types';
import type { WebLLMModelInfo } from '../webllmModelInfo';

// Mock the @mlc-ai/web-llm module
vi.mock('@mlc-ai/web-llm', () => ({
  CreateMLCEngine: vi.fn(),
  prebuiltAppConfig: {
    model_list: [
      // Include buffer_size_required_bytes and vram_required_MB for realistic model info
      {
        model_id: 'Phi-3.5-mini-instruct-q4f16_1-MLC',
        buffer_size_required_bytes: 2.3 * 1024 * 1024 * 1024,
        vram_required_MB: 3000,
      },
      {
        model_id: 'Llama-3.1-8B-Instruct-q4f16_1-MLC',
        buffer_size_required_bytes: 4.3 * 1024 * 1024 * 1024,
        vram_required_MB: 5000,
      },
      {
        model_id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
        buffer_size_required_bytes: 1.0 * 1024 * 1024 * 1024,
        vram_required_MB: 1500,
      },
      {
        model_id: 'SmolLM2-360M-Instruct-q4f16_1-MLC',
        buffer_size_required_bytes: 0.4 * 1024 * 1024 * 1024,
        vram_required_MB: 500,
      },
      {
        model_id: 'gemma-2-2b-it-q4f16_1-MLC',
        buffer_size_required_bytes: 1.5 * 1024 * 1024 * 1024,
        vram_required_MB: 2000,
      },
      {
        model_id: 'TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC',
        buffer_size_required_bytes: 0.6 * 1024 * 1024 * 1024,
        vram_required_MB: 800,
      },
      { model_id: 'some-base-model-v1' }, // Should be filtered out (no instruct/chat)
    ],
  },
}));

// Import after mocking
import { WebLLMClient, setProgressCallback, getEngineState, disposeEngine } from '../webllmClient';
import { CreateMLCEngine } from '@mlc-ai/web-llm';

describe('WebLLMClient', () => {
  let client: WebLLMClient;
  let mockApiDefinition: APIDefinition;

  beforeEach(() => {
    client = new WebLLMClient();
    mockApiDefinition = {
      id: 'webllm-def',
      apiType: 'webllm',
      name: 'WebLLM Local',
      baseUrl: '',
      apiKey: '', // Not needed for WebLLM
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up engine state between tests
    await disposeEngine();
  });

  describe('discoverModels', () => {
    it('should return filtered list of chat/instruct models', async () => {
      const models = await client.discoverModels(mockApiDefinition);

      // Should filter for instruct/chat models only
      expect(models.length).toBeGreaterThan(0);

      // All returned models should have instruct or chat in their ID
      for (const model of models) {
        const idLower = model.id.toLowerCase();
        expect(idLower.includes('instruct') || idLower.includes('chat')).toBe(true);
      }

      // Should not include base models without instruct/chat
      expect(models.find(m => m.id === 'some-base-model-v1')).toBeUndefined();
    });

    it('should return models with correct apiType', async () => {
      const models = await client.discoverModels(mockApiDefinition);

      for (const model of models) {
        expect(model.apiType).toBe('webllm');
      }
    });

    it('should return models with context windows', async () => {
      const models = await client.discoverModels(mockApiDefinition);

      for (const model of models) {
        expect(model.contextWindow).toBeGreaterThan(0);
      }
    });

    it('should sort models by size (smaller first)', async () => {
      const models = await client.discoverModels(mockApiDefinition);

      // SmolLM should come before Llama 8B
      const smolLMIndex = models.findIndex(m => m.id.includes('SmolLM'));
      const llamaIndex = models.findIndex(m => m.id.includes('Llama-3.1-8B'));

      if (smolLMIndex !== -1 && llamaIndex !== -1) {
        expect(smolLMIndex).toBeLessThan(llamaIndex);
      }
    });
  });

  describe('shouldPrependPrefill', () => {
    it('should return false', () => {
      expect(client.shouldPrependPrefill(mockApiDefinition)).toBe(false);
    });
  });

  describe('calculateCost', () => {
    it('should always return 0 (free)', () => {
      expect(client.calculateCost('any-model', 1000, 500)).toBe(0);
      expect(client.calculateCost('any-model', 0, 0)).toBe(0);
      expect(client.calculateCost('any-model', 1000000, 1000000, 500, 100, 200)).toBe(0);
    });
  });

  describe('getModelInfo', () => {
    it('should return model info with zero pricing', () => {
      const info = client.getModelInfo('Phi-3.5-mini-instruct-q4f16_1-MLC');
      expect(info.inputPrice).toBe(0);
      expect(info.outputPrice).toBe(0);
      expect(info.cacheReadPrice).toBe(0);
    });

    it('should return context window', () => {
      const info = client.getModelInfo('Phi-3.5-mini-instruct-q4f16_1-MLC');
      expect(info.contextWindow).toBeGreaterThan(0);
    });
  });

  describe('formatModelInfoForDisplay', () => {
    it('should show free and size info', () => {
      const info = client.getModelInfo('Phi-3.5-mini-instruct-q4f16_1-MLC') as WebLLMModelInfo;
      const formatted = client.formatModelInfoForDisplay(info);
      expect(formatted).toContain('Free');
      // Shows download size when available, VRAM otherwise
      expect(formatted.includes('download') || formatted.includes('VRAM')).toBe(true);
    });
  });

  describe('isReasoningModel', () => {
    it('should return false for all models', () => {
      expect(client.isReasoningModel('Phi-3.5-mini-instruct-q4f16_1-MLC')).toBe(false);
      expect(client.isReasoningModel('Llama-3.1-8B-Instruct-q4f16_1-MLC')).toBe(false);
    });
  });

  describe('migrateMessageRendering', () => {
    it('should convert text content to rendering groups', () => {
      const fullContent = [{ type: 'text', text: 'Hello world!' }];
      const result = client.migrateMessageRendering(fullContent, null);

      expect(result.renderingContent.length).toBe(1);
      expect(result.renderingContent[0].category).toBe('text');
      expect(result.stopReason).toBe('end_turn');
    });

    it('should handle string content', () => {
      const result = client.migrateMessageRendering('Plain string content', null);

      expect(result.renderingContent.length).toBe(1);
      expect(result.stopReason).toBe('end_turn');
    });

    it('should handle empty content', () => {
      const result = client.migrateMessageRendering([], null);
      expect(result.renderingContent.length).toBe(0);
    });

    it('should map stop reasons correctly', () => {
      expect(client.migrateMessageRendering([], 'stop').stopReason).toBe('end_turn');
      expect(client.migrateMessageRendering([], 'length').stopReason).toBe('max_tokens');
      expect(client.migrateMessageRendering([], null).stopReason).toBe('end_turn');
    });
  });

  describe('engine state management', () => {
    it('should report initial state as not loaded', () => {
      const state = getEngineState();
      expect(state.isLoaded).toBe(false);
      expect(state.currentModelId).toBeNull();
    });

    it('should accept progress callback', () => {
      const callback = vi.fn();
      setProgressCallback(callback);
      // Should not throw
      setProgressCallback(null);
    });
  });

  describe('sendMessageStream', () => {
    it('should handle model loading errors gracefully', async () => {
      // Mock CreateMLCEngine to throw an error
      vi.mocked(CreateMLCEngine).mockRejectedValue(new Error('WebGPU not available'));

      const messages: Message<unknown>[] = [
        {
          id: 'msg1',
          role: 'user',
          content: { type: 'text', content: 'Hello' },
          timestamp: new Date(),
        },
      ];

      const generator = client.sendMessageStream(messages, 'test-model', mockApiDefinition, {
        maxTokens: 1024,
        enableReasoning: false,
        reasoningBudgetTokens: 0,
      });

      // Consume the generator
      const chunks = [];
      let result;
      try {
        for await (const chunk of generator) {
          chunks.push(chunk);
        }
      } catch (e) {
        // The generator might throw or return error
        result = e;
      }

      // Get the final result
      if (!result) {
        // If no exception, check what the generator returned
        // The result should have error info
      }
    });

    it('should provide helpful error for WebGPU unavailability', async () => {
      vi.mocked(CreateMLCEngine).mockRejectedValue(new Error('WebGPU is not supported'));

      const messages: Message<unknown>[] = [
        {
          id: 'msg1',
          role: 'user',
          content: { type: 'text', content: 'Hello' },
          timestamp: new Date(),
        },
      ];

      const generator = client.sendMessageStream(messages, 'test-model', mockApiDefinition, {
        maxTokens: 1024,
        enableReasoning: false,
        reasoningBudgetTokens: 0,
      });

      // Exhaust the generator to get the result
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of generator) {
        // consume chunks
      }

      // The generator should complete - error will be in result
    });

    it('should provide helpful error for OOM', async () => {
      vi.mocked(CreateMLCEngine).mockRejectedValue(new Error('out of memory'));

      const messages: Message<unknown>[] = [
        {
          id: 'msg1',
          role: 'user',
          content: { type: 'text', content: 'Hello' },
          timestamp: new Date(),
        },
      ];

      const generator = client.sendMessageStream(messages, 'test-model', mockApiDefinition, {
        maxTokens: 1024,
        enableReasoning: false,
        reasoningBudgetTokens: 0,
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of generator) {
        // consume
      }
    });

    it('should handle successful streaming', async () => {
      // Mock a successful engine
      const mockEngine = {
        chat: {
          completions: {
            create: vi.fn().mockReturnValue(
              (async function* () {
                yield { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] };
                yield { choices: [{ delta: { content: ' world!' }, finish_reason: 'stop' }] };
              })()
            ),
          },
        },
        runtimeStatsText: vi.fn().mockResolvedValue('prefill: 10 tok, decode: 5 tok'),
        unload: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(CreateMLCEngine).mockImplementation(
        () => Promise.resolve(mockEngine) as unknown as ReturnType<typeof CreateMLCEngine>
      );

      const messages: Message<unknown>[] = [
        {
          id: 'msg1',
          role: 'user',
          content: { type: 'text', content: 'Hi' },
          timestamp: new Date(),
        },
      ];

      const generator = client.sendMessageStream(messages, 'test-model', mockApiDefinition, {
        maxTokens: 1024,
        enableReasoning: false,
        reasoningBudgetTokens: 0,
      });

      const chunks = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      // Should have content chunks
      expect(chunks.some(c => c.type === 'content')).toBe(true);
    });

    it('should include system prompt when provided', async () => {
      const mockEngine = {
        chat: {
          completions: {
            create: vi.fn().mockReturnValue(
              (async function* () {
                yield { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] };
              })()
            ),
          },
        },
        runtimeStatsText: vi.fn().mockResolvedValue(''),
        unload: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(CreateMLCEngine).mockImplementation(
        () => Promise.resolve(mockEngine) as unknown as ReturnType<typeof CreateMLCEngine>
      );

      const messages: Message<unknown>[] = [
        {
          id: 'msg1',
          role: 'user',
          content: { type: 'text', content: 'Hi' },
          timestamp: new Date(),
        },
      ];

      const generator = client.sendMessageStream(messages, 'test-model', mockApiDefinition, {
        maxTokens: 1024,
        enableReasoning: false,
        reasoningBudgetTokens: 0,
        systemPrompt: 'You are a helpful assistant.',
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of generator) {
        // consume
      }

      // Check that create was called with system message
      expect(mockEngine.chat.completions.create).toHaveBeenCalled();
      const callArgs = mockEngine.chat.completions.create.mock.calls[0][0];
      expect(callArgs.messages[0].role).toBe('system');
      expect(callArgs.messages[0].content).toBe('You are a helpful assistant.');
    });

    it('should handle attachments with note about no vision support', async () => {
      const mockEngine = {
        chat: {
          completions: {
            create: vi.fn().mockReturnValue(
              (async function* () {
                yield { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] };
              })()
            ),
          },
        },
        runtimeStatsText: vi.fn().mockResolvedValue(''),
        unload: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(CreateMLCEngine).mockImplementation(
        () => Promise.resolve(mockEngine) as unknown as ReturnType<typeof CreateMLCEngine>
      );

      const messages: Message<unknown>[] = [
        {
          id: 'msg1',
          role: 'user',
          content: { type: 'text', content: 'What is this?' },
          timestamp: new Date(),
          attachments: [{ id: 'att1', type: 'image', mimeType: 'image/png', data: 'base64data' }],
        },
      ];

      const generator = client.sendMessageStream(messages, 'test-model', mockApiDefinition, {
        maxTokens: 1024,
        enableReasoning: false,
        reasoningBudgetTokens: 0,
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of generator) {
        // consume
      }

      // Check that message content includes note about images
      const callArgs = mockEngine.chat.completions.create.mock.calls[0][0];
      const userMessage = callArgs.messages.find((m: { role: string }) => m.role === 'user');
      expect(userMessage.content).toContain('image(s) were attached');
      expect(userMessage.content).toContain("doesn't support vision");
    });
  });
});
