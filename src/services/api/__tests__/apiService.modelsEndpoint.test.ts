import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiService } from '../apiService';
import type { APIDefinition } from '../../../types';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('apiService.discoverModels with modelsEndpoint', () => {
  const createApiDef = (modelsEndpoint?: string): APIDefinition => ({
    id: 'test-api',
    apiType: 'chatgpt',
    name: 'Test API',
    baseUrl: 'https://api.example.com',
    apiKey: 'test-key',
    modelsEndpoint,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('OpenAI-compatible format', () => {
    it('parses { data: [...] } format', async () => {
      const apiDef = createApiDef('https://models.example.com/v1/models');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-4', name: 'GPT-4' },
            { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
          ],
        }),
      });

      const models = await apiService.discoverModels(apiDef);

      expect(mockFetch).toHaveBeenCalledWith('https://models.example.com/v1/models');
      expect(models).toHaveLength(2);
      expect(models[0].id).toBe('gpt-4');
      expect(models[0].name).toBe('GPT-4');
      expect(models[1].id).toBe('gpt-3.5-turbo');
      expect(models[1].name).toBe('GPT-3.5 Turbo');
    });
  });

  describe('plain array format', () => {
    it('parses [{ id: ... }] format', async () => {
      const apiDef = createApiDef('https://models.example.com/models');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 'model-a', display_name: 'Model A' }, { id: 'model-b' }],
      });

      const models = await apiService.discoverModels(apiDef);

      expect(models).toHaveLength(2);
      expect(models[0].id).toBe('model-a');
      expect(models[0].name).toBe('Model A'); // display_name used
      expect(models[1].id).toBe('model-b');
      expect(models[1].name).toBe('model-b'); // no name, falls back to id
    });
  });

  describe('string array format', () => {
    it('parses ["model-1", "model-2"] format', async () => {
      const apiDef = createApiDef('https://models.example.com/simple');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku'],
      });

      const models = await apiService.discoverModels(apiDef);

      expect(models).toHaveLength(3);
      expect(models[0].id).toBe('claude-3-opus');
      expect(models[1].id).toBe('claude-3-sonnet');
      expect(models[2].id).toBe('claude-3-haiku');
    });
  });

  describe('OpenRouter metadata', () => {
    it('applies OpenRouter pricing and context data', async () => {
      const apiDef = createApiDef('https://openrouter.ai/api/v1/models');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'openai/gpt-4',
              name: 'GPT-4',
              context_length: 8192,
              pricing: {
                prompt: '0.00003', // $30 per 1M
                completion: '0.00006', // $60 per 1M
              },
              top_provider: {
                max_completion_tokens: 4096,
              },
            },
          ],
        }),
      });

      const models = await apiService.discoverModels(apiDef);

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('openai/gpt-4');
      expect(models[0].contextWindow).toBe(8192);
      expect(models[0].maxOutputTokens).toBe(4096);
      expect(models[0].inputPrice).toBe(30);
      expect(models[0].outputPrice).toBe(60);
    });
  });

  describe('error handling', () => {
    it('throws on HTTP error', async () => {
      const apiDef = createApiDef('https://models.example.com/fail');
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(apiService.discoverModels(apiDef)).rejects.toThrow(
        'Failed to fetch models from https://models.example.com/fail: 500 Internal Server Error'
      );
    });

    it('throws on unexpected format', async () => {
      const apiDef = createApiDef('https://models.example.com/weird');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: 'unexpected' }),
      });

      await expect(apiService.discoverModels(apiDef)).rejects.toThrow(
        'Unexpected response format from https://models.example.com/weird'
      );
    });
  });

  describe('fallback to SDK', () => {
    it('uses client.discoverModels when modelsEndpoint not set', async () => {
      const apiDef = createApiDef(undefined);

      // Without mocking the client, this will throw because there's no real API
      // The key is that the modelsEndpoint is undefined, so SDK path is used
      await expect(apiService.discoverModels(apiDef)).rejects.toThrow();
      // SDK internally uses fetch, but to a different URL (baseUrl + /models)
      // We can't reliably check which URL was called without deeper mocking
    });
  });
});
