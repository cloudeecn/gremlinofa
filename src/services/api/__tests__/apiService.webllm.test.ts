/**
 * Tests for apiService WebLLM Integration (Phase 3)
 *
 * Verifies that WebLLM is properly integrated into the API service layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { APIType } from '../../../types';

// Mock the @mlc-ai/web-llm module before importing apiService
vi.mock('@mlc-ai/web-llm', () => ({
  CreateMLCEngine: vi.fn(),
  prebuiltAppConfig: {
    model_list: [
      { model_id: 'Phi-3.5-mini-instruct-q4f16_1-MLC' },
      { model_id: 'SmolLM2-360M-Instruct-q4f16_1-MLC' },
    ],
  },
}));

// Import after mocking
import { apiService } from '../apiService';
import type { APIDefinition } from '../../../types';

describe('apiService WebLLM integration', () => {
  let webllmApiDefinition: APIDefinition;

  beforeEach(() => {
    webllmApiDefinition = {
      id: 'webllm-test-def',
      apiType: APIType.WEBLLM,
      name: 'WebLLM Test',
      baseUrl: '',
      apiKey: '', // No API key needed for WebLLM
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });

  describe('client routing', () => {
    it('should route WebLLM API type to WebLLMClient', async () => {
      // If WebLLM is not properly registered, discoverModels will throw
      const models = await apiService.discoverModels(webllmApiDefinition);

      // Should return models (if properly routed)
      expect(Array.isArray(models)).toBe(true);
    });

    it('should calculate cost as 0 for WebLLM', () => {
      const cost = apiService.calculateCost(
        APIType.WEBLLM,
        'Phi-3.5-mini-instruct-q4f16_1-MLC',
        10000, // input tokens
        5000, // output tokens
        0, // reasoning tokens
        0, // cache creation
        0 // cache read
      );

      expect(cost).toBe(0);
    });

    it('should return model info for WebLLM models', () => {
      const info = apiService.getModelInfo(APIType.WEBLLM, 'Phi-3.5-mini-instruct-q4f16_1-MLC');

      expect(info).toBeDefined();
      expect(info.inputPrice).toBe(0);
      expect(info.outputPrice).toBe(0);
    });

    it('should format model info for WebLLM', () => {
      const formatted = apiService.formatModelInfoForDisplay(
        APIType.WEBLLM,
        'Phi-3.5-mini-instruct-q4f16_1-MLC'
      );

      expect(formatted).toContain('Free');
      // Shows download or VRAM depending on availability
      expect(formatted.includes('download') || formatted.includes('VRAM')).toBe(true);
    });

    it('should report WebLLM models as non-reasoning', () => {
      const isReasoning = apiService.isReasoningModel(
        APIType.WEBLLM,
        'Phi-3.5-mini-instruct-q4f16_1-MLC'
      );

      expect(isReasoning).toBe(false);
    });

    it('should not require prefill for WebLLM', () => {
      const shouldPrepend = apiService.shouldPrependPrefill(webllmApiDefinition);
      expect(shouldPrepend).toBe(false);
    });
  });

  describe('stop reason mapping', () => {
    it('should map WebLLM stop reasons correctly', () => {
      // WebLLM uses 'stop' and 'length' like OpenAI
      expect(apiService.mapStopReason(APIType.WEBLLM, 'stop')).toBe('end_turn');
      expect(apiService.mapStopReason(APIType.WEBLLM, 'length')).toBe('max_tokens');
      expect(apiService.mapStopReason(APIType.WEBLLM, null)).toBe('end_turn');
    });
  });

  describe('message rendering migration', () => {
    it('should migrate WebLLM message rendering', () => {
      const fullContent = [{ type: 'text', text: 'Hello from local model!' }];
      const result = apiService.migrateMessageRendering(APIType.WEBLLM, fullContent, 'stop');

      expect(result.renderingContent.length).toBeGreaterThan(0);
      expect(result.stopReason).toBe('end_turn');
    });

    it('should handle empty WebLLM content', () => {
      const result = apiService.migrateMessageRendering(APIType.WEBLLM, [], null);

      expect(result.renderingContent.length).toBe(0);
      expect(result.stopReason).toBe('end_turn');
    });
  });

  describe('model discovery', () => {
    it('should discover WebLLM models without API key', async () => {
      // WebLLM should work without an API key
      const defWithoutKey: APIDefinition = {
        ...webllmApiDefinition,
        apiKey: '',
      };

      const models = await apiService.discoverModels(defWithoutKey);

      expect(models.length).toBeGreaterThan(0);
      // All models should have WEBLLM type
      models.forEach(model => {
        expect(model.apiType).toBe(APIType.WEBLLM);
      });
    });

    it('should filter for instruct/chat models only', async () => {
      const models = await apiService.discoverModels(webllmApiDefinition);

      // All returned models should have instruct or chat in their ID
      models.forEach(model => {
        const idLower = model.id.toLowerCase();
        expect(idLower.includes('instruct') || idLower.includes('chat')).toBe(true);
      });
    });
  });
});
