/**
 * Tests for apiService WebLLM Integration (Phase 3)
 *
 * Verifies that WebLLM is properly integrated into the API service layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the @mlc-ai/web-llm module before importing apiService
vi.mock('@mlc-ai/web-llm', () => ({
  CreateMLCEngine: vi.fn(),
  ModelType: { LLM: 'LLM', embedding: 'embedding', vlm: 'vlm' },
  prebuiltAppConfig: {
    model_list: [
      { model_id: 'Phi-3.5-mini-instruct-q4f16_1-MLC', model_type: 'LLM' },
      { model_id: 'SmolLM2-360M-Instruct-q4f16_1-MLC', model_type: 'LLM' },
    ],
  },
}));

// Import after mocking
import { apiService } from '../apiService';
import { getModelMetadataFor, calculateCost } from '../modelMetadata';
import type { APIDefinition } from '../../../types';

describe('apiService WebLLM integration', () => {
  let webllmApiDefinition: APIDefinition;

  beforeEach(() => {
    webllmApiDefinition = {
      id: 'webllm-test-def',
      apiType: 'webllm',
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

    it('should calculate cost as 0 for WebLLM via modelMetadata', () => {
      const model = getModelMetadataFor(webllmApiDefinition, 'Phi-3.5-mini-instruct-q4f16_1-MLC');

      // WebLLM models are free
      const cost = calculateCost(model, 10000, 5000, 0, 0, 0);
      expect(cost).toBe(0);
    });

    it('should return model metadata for WebLLM models', () => {
      const model = getModelMetadataFor(webllmApiDefinition, 'Phi-3.5-mini-instruct-q4f16_1-MLC');

      expect(model).toBeDefined();
      expect(model.id).toBe('Phi-3.5-mini-instruct-q4f16_1-MLC');
      expect(model.apiType).toBe('webllm');
      // WebLLM models have no pricing defined in knowledge base
      expect(model.matchedMode).toBe('default');
    });

    it('should report WebLLM models as non-reasoning via metadata', () => {
      const model = getModelMetadataFor(webllmApiDefinition, 'Phi-3.5-mini-instruct-q4f16_1-MLC');

      // No reasoning mode defined means not a reasoning model
      expect(model.reasoningMode).toBeUndefined();
    });

    it('should not require prefill for WebLLM', () => {
      const shouldPrepend = apiService.shouldPrependPrefill(webllmApiDefinition);
      expect(shouldPrepend).toBe(false);
    });
  });

  describe('stop reason mapping', () => {
    it('should map WebLLM stop reasons correctly', () => {
      // WebLLM uses 'stop' and 'length' like OpenAI
      expect(apiService.mapStopReason('webllm', 'stop')).toBe('end_turn');
      expect(apiService.mapStopReason('webllm', 'length')).toBe('max_tokens');
      expect(apiService.mapStopReason('webllm', null)).toBe('end_turn');
    });
  });

  describe('message rendering migration', () => {
    it('should migrate WebLLM message rendering', () => {
      const fullContent = [{ type: 'text', text: 'Hello from local model!' }];
      const result = apiService.migrateMessageRendering('webllm', fullContent, 'stop');

      expect(result.renderingContent.length).toBeGreaterThan(0);
      expect(result.stopReason).toBe('end_turn');
    });

    it('should handle empty WebLLM content', () => {
      const result = apiService.migrateMessageRendering('webllm', [], null);

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
        expect(model.apiType).toBe('webllm');
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
