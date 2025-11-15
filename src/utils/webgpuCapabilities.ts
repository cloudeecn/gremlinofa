/**
 * WebGPU Capability Detection
 *
 * Checks browser support for WebGPU, which is required for WebLLM.
 * Supported: Chrome 113+, Edge 113+, Safari 18+
 */

export interface WebGPUCapabilities {
  /** Whether WebGPU API is available */
  supported: boolean;
  /** GPU adapter info (if available) */
  adapterInfo?: {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
  };
  /** Estimated max buffer size (rough VRAM indicator) */
  maxBufferSize?: number;
  /** Estimated available VRAM in bytes (conservative estimate) */
  estimatedVRAM?: number;
  /** Reason for unsupported status */
  reason?: string;
}

/**
 * Cached capability result to avoid repeated async checks
 */
let cachedCapabilities: WebGPUCapabilities | null = null;

/**
 * Check if WebGPU is supported synchronously (basic check).
 * For full capability details, use checkWebGPUCapabilities().
 */
export function isWebGPUAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/**
 * Check WebGPU capabilities asynchronously.
 * Returns detailed info about GPU adapter if available.
 *
 * @returns Promise resolving to WebGPUCapabilities
 */
export async function checkWebGPUCapabilities(): Promise<WebGPUCapabilities> {
  // Return cached result if available
  if (cachedCapabilities) {
    return cachedCapabilities;
  }

  // Check basic availability
  if (!isWebGPUAvailable()) {
    cachedCapabilities = {
      supported: false,
      reason: 'WebGPU API not available in this browser',
    };
    return cachedCapabilities;
  }

  try {
    // Request GPU adapter
    // Use any type to avoid TypeScript issues with WebGPU types
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gpu = (navigator as any).gpu;
    const adapter = await gpu.requestAdapter();

    if (!adapter) {
      cachedCapabilities = {
        supported: false,
        reason: 'No compatible GPU adapter found',
      };
      return cachedCapabilities;
    }

    // Get adapter info - use info property (newer API) or requestAdapterInfo (fallback)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = adapter.info || (await (adapter as any).requestAdapterInfo?.()) || {};
    const limits = adapter.limits || {};

    // Estimate VRAM based on maxBufferSize
    // maxBufferSize is typically 1/4 to 1/2 of total VRAM
    // We use conservative estimate (maxBufferSize * 2) as a rough VRAM indicator
    const estimatedVRAM = limits.maxBufferSize ? limits.maxBufferSize * 2 : undefined;

    cachedCapabilities = {
      supported: true,
      adapterInfo: {
        vendor: info.vendor || 'Unknown',
        architecture: info.architecture || 'Unknown',
        device: info.device || 'Unknown',
        description: info.description || 'Unknown',
      },
      maxBufferSize: limits.maxBufferSize,
      estimatedVRAM,
    };

    return cachedCapabilities;
  } catch (error) {
    console.debug('WebGPU capability check failed:', error);
    cachedCapabilities = {
      supported: false,
      reason: error instanceof Error ? error.message : 'Unknown error checking WebGPU',
    };
    return cachedCapabilities;
  }
}

/**
 * Clear cached capabilities (useful for testing).
 */
export function clearWebGPUCapabilitiesCache(): void {
  cachedCapabilities = null;
}

/**
 * Get supported browser list for display.
 */
export function getSupportedBrowsers(): string[] {
  return ['Chrome 113+', 'Edge 113+', 'Safari 18+ (macOS/iOS)'];
}

/**
 * Model compatibility result
 */
export interface ModelCompatibility {
  /** Whether the model is likely compatible with available VRAM */
  compatible: boolean;
  /** Warning message if compatibility is uncertain or not met */
  warning?: string;
  /** Whether VRAM check was possible (false if VRAM unknown) */
  vramCheckPossible: boolean;
}

/**
 * Check if a model is compatible with estimated VRAM.
 * Returns compatibility status and warning message.
 *
 * @param vramRequired Model's VRAM requirement in bytes
 * @param capabilities WebGPU capabilities (use cached or check first)
 * @returns ModelCompatibility result
 */
export function checkModelCompatibility(
  vramRequired: number,
  capabilities: WebGPUCapabilities | null
): ModelCompatibility {
  // Can't check if WebGPU not supported
  if (!capabilities?.supported) {
    return {
      compatible: false,
      warning: 'WebGPU not available',
      vramCheckPossible: false,
    };
  }

  // Can't check if VRAM unknown
  if (!capabilities.estimatedVRAM) {
    return {
      compatible: true, // Assume compatible if we can't check
      warning: undefined,
      vramCheckPossible: false,
    };
  }

  const estimatedVRAM = capabilities.estimatedVRAM;

  // Model definitely won't fit
  if (vramRequired > estimatedVRAM * 1.2) {
    return {
      compatible: false,
      warning: `Requires ~${formatVRAM(vramRequired)} VRAM (estimated ~${formatVRAM(estimatedVRAM)} available)`,
      vramCheckPossible: true,
    };
  }

  // Model might have issues (within 20% of estimated limit)
  if (vramRequired > estimatedVRAM * 0.8) {
    return {
      compatible: true,
      warning: `May be tight on VRAM (~${formatVRAM(vramRequired)} needed, estimated ~${formatVRAM(estimatedVRAM)} available)`,
      vramCheckPossible: true,
    };
  }

  // Model should fit fine
  return {
    compatible: true,
    warning: undefined,
    vramCheckPossible: true,
  };
}

/**
 * Format VRAM size for human-readable display.
 * @param bytes Size in bytes
 * @returns Formatted string like "4 GB" or "512 MB"
 */
export function formatVRAM(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    const gb = bytes / (1024 * 1024 * 1024);
    return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
