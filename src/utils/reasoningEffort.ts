export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

/**
 * Map a reasoning effort level to the nearest supported level.
 * - undefined → undefined
 * - Below supported range → lowest supported
 * - Above supported range → highest supported
 * - Between two supported values → lower one
 */
export function mapReasoningEffort<T extends ReasoningEffort>(
  effort: ReasoningEffort | undefined,
  supportedEfforts: readonly T[]
): T | undefined {
  if (effort === undefined) return undefined;

  if (supportedEfforts.length === 0) {
    throw new Error('supportedEfforts must not be empty');
  }

  const effortIndex = REASONING_EFFORTS.indexOf(effort);

  // Build sorted indices of supported efforts
  const supportedIndices = supportedEfforts
    .map(e => REASONING_EFFORTS.indexOf(e))
    .sort((a, b) => a - b);

  const minSupported = supportedIndices[0];
  const maxSupported = supportedIndices[supportedIndices.length - 1];

  // Below range → lowest supported
  if (effortIndex <= minSupported) {
    return REASONING_EFFORTS[minSupported] as T;
  }

  // At or above range → highest supported
  if (effortIndex >= maxSupported) {
    return REASONING_EFFORTS[maxSupported] as T;
  }

  // In between → find highest supported that's <= effort
  for (let i = supportedIndices.length - 1; i >= 0; i--) {
    if (supportedIndices[i] <= effortIndex) {
      return REASONING_EFFORTS[supportedIndices[i]] as T;
    }
  }

  // Fallback (shouldn't reach here)
  return REASONING_EFFORTS[minSupported] as T;
}
