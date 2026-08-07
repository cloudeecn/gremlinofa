import type { ReasoningEffort } from '../../protocol/types';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
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

const ANTHROPIC_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Levels Anthropic's `output_config.effort` and the Agent SDK's `EffortLevel` accept. */
export type AnthropicEffort = (typeof ANTHROPIC_EFFORT_LEVELS)[number];

const ANTHROPIC_EFFORT_SET: ReadonlySet<string> = new Set(ANTHROPIC_EFFORT_LEVELS);

export function isAnthropicEffort(effort: ReasoningEffort): effort is AnthropicEffort {
  return effort !== undefined && ANTHROPIC_EFFORT_SET.has(effort);
}

/**
 * Map a reasoning effort to the nearest level a given Claude model accepts.
 *
 * Returns undefined when no effort was requested, or when the model advertises no
 * configurable effort — callers then omit the field entirely and Anthropic's server
 * default (`high`) applies. Also absorbs the empty/undefined array that the generic
 * `mapReasoningEffort` throws on, so metadata gaps can never break a live request.
 */
export function mapAnthropicEffort(
  effort: ReasoningEffort,
  supportedEfforts: readonly ReasoningEffort[] | undefined
): AnthropicEffort | undefined {
  if (effort === undefined) return undefined;
  const levels = (supportedEfforts ?? []).filter(isAnthropicEffort);
  if (levels.length === 0) return undefined;
  // `xhigh` means "deeper than high", so on a model without it escalate to `max`
  // rather than letting the generic helper round down to `high`.
  if (effort === 'xhigh' && !levels.includes('xhigh') && levels.includes('max')) return 'max';
  return mapReasoningEffort(effort, levels);
}
