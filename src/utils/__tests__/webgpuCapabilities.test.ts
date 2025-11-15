/**
 * Tests for WebGPU capability detection
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isWebGPUAvailable,
  checkWebGPUCapabilities,
  clearWebGPUCapabilitiesCache,
  getSupportedBrowsers,
  checkModelCompatibility,
  formatVRAM,
  type WebGPUCapabilities,
} from '../webgpuCapabilities';

describe('webgpuCapabilities', () => {
  beforeEach(() => {
    // Clear cache between tests
    clearWebGPUCapabilitiesCache();

    // Reset navigator.gpu mock
    vi.unstubAllGlobals();
  });

  describe('isWebGPUAvailable', () => {
    it('should return false when navigator.gpu is not defined', () => {
      vi.stubGlobal('navigator', {});
      expect(isWebGPUAvailable()).toBe(false);
    });

    it('should return true when navigator.gpu is defined', () => {
      vi.stubGlobal('navigator', { gpu: {} });
      expect(isWebGPUAvailable()).toBe(true);
    });

    it('should handle undefined navigator', () => {
      vi.stubGlobal('navigator', undefined);
      expect(isWebGPUAvailable()).toBe(false);
    });
  });

  describe('checkWebGPUCapabilities', () => {
    it('should return not supported when navigator.gpu is not available', async () => {
      vi.stubGlobal('navigator', {});

      const result = await checkWebGPUCapabilities();

      expect(result.supported).toBe(false);
      expect(result.reason).toContain('WebGPU API not available');
    });

    it('should return not supported when requestAdapter returns null', async () => {
      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: vi.fn().mockResolvedValue(null),
        },
      });

      const result = await checkWebGPUCapabilities();

      expect(result.supported).toBe(false);
      expect(result.reason).toContain('No compatible GPU adapter');
    });

    it('should return supported with adapter info when available', async () => {
      const mockAdapterInfo = {
        vendor: 'TestVendor',
        architecture: 'TestArch',
        device: 'TestDevice',
        description: 'Test GPU Description',
      };

      const mockLimits = {
        maxBufferSize: 1024 * 1024 * 1024,
      };

      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: vi.fn().mockResolvedValue({
            requestAdapterInfo: vi.fn().mockResolvedValue(mockAdapterInfo),
            limits: mockLimits,
          }),
        },
      });

      const result = await checkWebGPUCapabilities();

      expect(result.supported).toBe(true);
      expect(result.adapterInfo).toEqual(mockAdapterInfo);
      expect(result.maxBufferSize).toBe(mockLimits.maxBufferSize);
    });

    it('should cache results for subsequent calls', async () => {
      const requestAdapter = vi.fn().mockResolvedValue({
        requestAdapterInfo: vi.fn().mockResolvedValue({
          vendor: 'Test',
          architecture: 'Test',
          device: 'Test',
          description: 'Test',
        }),
        limits: { maxBufferSize: 100 },
      });

      vi.stubGlobal('navigator', { gpu: { requestAdapter } });

      // First call
      await checkWebGPUCapabilities();
      // Second call
      await checkWebGPUCapabilities();

      // requestAdapter should only be called once due to caching
      expect(requestAdapter).toHaveBeenCalledTimes(1);
    });

    it('should handle errors gracefully', async () => {
      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: vi.fn().mockRejectedValue(new Error('GPU error')),
        },
      });

      const result = await checkWebGPUCapabilities();

      expect(result.supported).toBe(false);
      expect(result.reason).toContain('GPU error');
    });

    it('should handle missing adapter info fields', async () => {
      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: vi.fn().mockResolvedValue({
            requestAdapterInfo: vi.fn().mockResolvedValue({}),
            limits: {},
          }),
        },
      });

      const result = await checkWebGPUCapabilities();

      expect(result.supported).toBe(true);
      expect(result.adapterInfo).toEqual({
        vendor: 'Unknown',
        architecture: 'Unknown',
        device: 'Unknown',
        description: 'Unknown',
      });
    });
  });

  describe('clearWebGPUCapabilitiesCache', () => {
    it('should clear the cache and allow fresh checks', async () => {
      const requestAdapter = vi.fn().mockResolvedValue({
        requestAdapterInfo: vi.fn().mockResolvedValue({
          vendor: 'Test',
          architecture: 'Test',
          device: 'Test',
          description: 'Test',
        }),
        limits: { maxBufferSize: 100 },
      });

      vi.stubGlobal('navigator', { gpu: { requestAdapter } });

      // First call
      await checkWebGPUCapabilities();
      expect(requestAdapter).toHaveBeenCalledTimes(1);

      // Clear cache
      clearWebGPUCapabilitiesCache();

      // Second call should hit adapter again
      await checkWebGPUCapabilities();
      expect(requestAdapter).toHaveBeenCalledTimes(2);
    });
  });

  describe('getSupportedBrowsers', () => {
    it('should return list of supported browsers', () => {
      const browsers = getSupportedBrowsers();

      expect(browsers).toBeInstanceOf(Array);
      expect(browsers.length).toBeGreaterThan(0);
      expect(browsers.some(b => b.includes('Chrome'))).toBe(true);
      expect(browsers.some(b => b.includes('Edge'))).toBe(true);
      expect(browsers.some(b => b.includes('Safari'))).toBe(true);
    });
  });

  describe('formatVRAM', () => {
    it('should format bytes to GB for large values', () => {
      const gb4 = 4 * 1024 * 1024 * 1024;
      expect(formatVRAM(gb4)).toBe('4.0 GB');
    });

    it('should format bytes to MB for smaller values', () => {
      const mb512 = 512 * 1024 * 1024;
      expect(formatVRAM(mb512)).toBe('512 MB');
    });

    it('should round GB values >= 10 to whole numbers', () => {
      const gb12 = 12 * 1024 * 1024 * 1024;
      expect(formatVRAM(gb12)).toBe('12 GB');
    });

    it('should show one decimal for GB values < 10', () => {
      const gb2_5 = 2.5 * 1024 * 1024 * 1024;
      expect(formatVRAM(gb2_5)).toBe('2.5 GB');
    });
  });

  describe('checkModelCompatibility', () => {
    const gb = 1024 * 1024 * 1024;

    it('should return not compatible when WebGPU not supported', () => {
      const capabilities: WebGPUCapabilities = {
        supported: false,
        reason: 'WebGPU not available',
      };

      const result = checkModelCompatibility(2 * gb, capabilities);

      expect(result.compatible).toBe(false);
      expect(result.warning).toContain('WebGPU not available');
      expect(result.vramCheckPossible).toBe(false);
    });

    it('should return compatible with no warning when VRAM unknown', () => {
      const capabilities: WebGPUCapabilities = {
        supported: true,
        adapterInfo: {
          vendor: 'Test',
          architecture: 'Test',
          device: 'Test',
          description: 'Test',
        },
        // No estimatedVRAM
      };

      const result = checkModelCompatibility(2 * gb, capabilities);

      expect(result.compatible).toBe(true);
      expect(result.warning).toBeUndefined();
      expect(result.vramCheckPossible).toBe(false);
    });

    it('should return compatible with no warning when model fits easily', () => {
      const capabilities: WebGPUCapabilities = {
        supported: true,
        estimatedVRAM: 8 * gb, // 8 GB available
      };

      // 2 GB model should fit easily in 8 GB
      const result = checkModelCompatibility(2 * gb, capabilities);

      expect(result.compatible).toBe(true);
      expect(result.warning).toBeUndefined();
      expect(result.vramCheckPossible).toBe(true);
    });

    it('should return compatible with warning when model is tight on VRAM', () => {
      const capabilities: WebGPUCapabilities = {
        supported: true,
        estimatedVRAM: 4 * gb, // 4 GB available
      };

      // 3.5 GB model is within 80-100% of available (tight)
      const result = checkModelCompatibility(3.5 * gb, capabilities);

      expect(result.compatible).toBe(true);
      expect(result.warning).toContain('tight on VRAM');
      expect(result.vramCheckPossible).toBe(true);
    });

    it('should return not compatible when model exceeds VRAM', () => {
      const capabilities: WebGPUCapabilities = {
        supported: true,
        estimatedVRAM: 4 * gb, // 4 GB available
      };

      // 6 GB model exceeds 4 GB by more than 20%
      const result = checkModelCompatibility(6 * gb, capabilities);

      expect(result.compatible).toBe(false);
      expect(result.warning).toContain('Requires');
      expect(result.warning).toContain('VRAM');
      expect(result.vramCheckPossible).toBe(true);
    });

    it('should handle null capabilities', () => {
      const result = checkModelCompatibility(2 * gb, null);

      expect(result.compatible).toBe(false);
      expect(result.warning).toContain('WebGPU not available');
      expect(result.vramCheckPossible).toBe(false);
    });
  });

  describe('estimatedVRAM calculation', () => {
    it('should estimate VRAM as 2x maxBufferSize', async () => {
      const maxBufferSize = 2 * 1024 * 1024 * 1024; // 2 GB

      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: vi.fn().mockResolvedValue({
            requestAdapterInfo: vi.fn().mockResolvedValue({
              vendor: 'Test',
              architecture: 'Test',
              device: 'Test',
              description: 'Test',
            }),
            limits: { maxBufferSize },
          }),
        },
      });

      const result = await checkWebGPUCapabilities();

      expect(result.supported).toBe(true);
      expect(result.estimatedVRAM).toBe(maxBufferSize * 2); // 4 GB
    });

    it('should not set estimatedVRAM when maxBufferSize is missing', async () => {
      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: vi.fn().mockResolvedValue({
            requestAdapterInfo: vi.fn().mockResolvedValue({
              vendor: 'Test',
              architecture: 'Test',
              device: 'Test',
              description: 'Test',
            }),
            limits: {}, // No maxBufferSize
          }),
        },
      });

      const result = await checkWebGPUCapabilities();

      expect(result.supported).toBe(true);
      expect(result.estimatedVRAM).toBeUndefined();
    });
  });
});
