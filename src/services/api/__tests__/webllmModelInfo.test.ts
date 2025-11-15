/**
 * Tests for WebLLM Model Information
 *
 * Uses WebLLM's prebuiltAppConfig directly for model metadata.
 */

import { describe, it, expect } from 'vitest';
import { prebuiltAppConfig } from '@mlc-ai/web-llm';
import {
  getModelInfo,
  formatModelInfoForDisplay,
  formatSize,
  isReasoningModel,
} from '../webllmModelInfo';

describe('webllmModelInfo', () => {
  describe('getModelInfo', () => {
    it('should return info for models in prebuiltAppConfig', () => {
      // Use a model that's actually in the config
      const models = prebuiltAppConfig.model_list;
      expect(models.length).toBeGreaterThan(0);

      const firstModel = models[0];
      const info = getModelInfo(firstModel.model_id);

      expect(info.displayName).toBe(firstModel.model_id);
      expect(info.inputPrice).toBe(0);
      expect(info.outputPrice).toBe(0);
      expect(info.cacheReadPrice).toBe(0);
    });

    it('should return VRAM from config (converted to bytes)', () => {
      const models = prebuiltAppConfig.model_list;
      const modelWithVram = models.find(m => m.vram_required_MB !== undefined);

      if (modelWithVram) {
        const info = getModelInfo(modelWithVram.model_id);
        expect(info.vramRequired).toBe(modelWithVram.vram_required_MB! * 1024 * 1024);
      }
    });

    it('should return download size from config', () => {
      const models = prebuiltAppConfig.model_list;
      const modelWithSize = models.find(m => m.buffer_size_required_bytes !== undefined);

      if (modelWithSize) {
        const info = getModelInfo(modelWithSize.model_id);
        expect(info.downloadSize).toBe(modelWithSize.buffer_size_required_bytes);
      }
    });

    it('should throw for unknown models', () => {
      expect(() => getModelInfo('unknown-model-xyz')).toThrow(
        'Model not found in WebLLM config: unknown-model-xyz'
      );
    });
  });

  describe('formatModelInfoForDisplay', () => {
    it('should format model info with Free label and context', () => {
      const models = prebuiltAppConfig.model_list;
      const info = getModelInfo(models[0].model_id);
      const formatted = formatModelInfoForDisplay(info);

      expect(formatted).toContain('Free');
      // Should show either download or VRAM depending on what's available
      expect(formatted.includes('download') || formatted.includes('VRAM')).toBe(true);
      expect(formatted).toContain('ctx');
    });

    it('should format with download size when available', () => {
      const mockInfo = {
        displayName: 'Test Model',
        inputPrice: 0,
        outputPrice: 0,
        cacheReadPrice: 0,
        contextWindow: 8192,
        vramRequired: 5 * 1024 * 1024 * 1024,
        downloadSize: 4.3 * 1024 * 1024 * 1024,
        lowResourceRequired: false,
      };

      const formatted = formatModelInfoForDisplay(mockInfo);
      expect(formatted).toContain('4.3GB download');
      expect(formatted).toContain('8k ctx');
    });

    it('should show unknown download size when download size is 0', () => {
      const mockInfo = {
        displayName: 'Test Model',
        inputPrice: 0,
        outputPrice: 0,
        cacheReadPrice: 0,
        contextWindow: 4096,
        vramRequired: 5.3 * 1024 * 1024 * 1024,
        downloadSize: 0,
        lowResourceRequired: false,
      };

      const formatted = formatModelInfoForDisplay(mockInfo);
      expect(formatted).toContain('unknown download size');
      expect(formatted).toContain('4k ctx');
    });
  });

  describe('formatSize', () => {
    it('should format bytes to GB for large sizes', () => {
      expect(formatSize(2.3 * 1024 * 1024 * 1024)).toBe('2.3 GB');
      expect(formatSize(4.3 * 1024 * 1024 * 1024)).toBe('4.3 GB');
    });

    it('should format bytes to MB for smaller sizes', () => {
      expect(formatSize(400 * 1024 * 1024)).toBe('400 MB');
      expect(formatSize(700 * 1024 * 1024)).toBe('700 MB');
    });

    it('should handle edge case at GB boundary', () => {
      expect(formatSize(1024 * 1024 * 1024)).toBe('1.0 GB');
    });

    it('should handle small MB values', () => {
      expect(formatSize(100 * 1024 * 1024)).toBe('100 MB');
    });
  });

  describe('isReasoningModel', () => {
    it('should return false for all WebLLM models', () => {
      // WebLLM models don't have native reasoning support
      const models = prebuiltAppConfig.model_list;
      for (const model of models.slice(0, 5)) {
        // Test first 5 models
        expect(isReasoningModel(model.model_id)).toBe(false);
      }
    });

    it('should return false for any model ID', () => {
      expect(isReasoningModel('any-model-id')).toBe(false);
    });
  });
});
