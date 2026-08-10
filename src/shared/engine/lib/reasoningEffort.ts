import type { Model, ReasoningEffort } from '../../protocol/types';

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
 * Map a reasoning effort level to a supported one.
 * - undefined → undefined
 * - Below supported range → lowest supported
 * - Above supported range → highest supported
 * - Between two supported values → the higher one. Every vendor with a gapped
 *   ladder rounds this way itself (DeepSeek, Z.ai and Alibaba send `medium` to
 *   `high`), and rounding down would let `minimal` switch off a model whose
 *   ladder starts at `none`.
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
  const supportedIndices = supportedEfforts
    .map(e => REASONING_EFFORTS.indexOf(e))
    .sort((a, b) => a - b);
  const atOrAbove = supportedIndices.find(i => i >= effortIndex);
  return REASONING_EFFORTS[atOrAbove ?? supportedIndices[supportedIndices.length - 1]] as T;
}

/**
 * Effort for a request with the reasoning toggle off: `none` where the model's
 * ladder has it (which actually switches reasoning off), else the lowest level,
 * since a model that can't switch off should at least reason as little as it
 * allows. No ladder, or a model that doesn't reason → undefined, send nothing.
 */
export function effortWhenOff(
  model: Pick<Model, 'reasoningMode' | 'supportedReasoningEfforts'> | undefined
): ReasoningEffort | undefined {
  const levels = model?.supportedReasoningEfforts;
  if (!levels?.length || model?.reasoningMode === 'none') return undefined;
  return mapReasoningEffort('none', levels);
}

/**
 * Effort to send beside a dialect's thinking toggle (`thinking` object, or
 * `enable_thinking` on Responses). Only a model whose metadata lists effort
 * levels gets one; Kimi K2.x rejects the pair and lists none. With the toggle
 * off, an always-reasoning model drops to its lowest level, Z.ai's documented
 * replacement for `thinking: disabled`.
 */
export function effortBesideToggle(
  effort: ReasoningEffort | undefined,
  model: Model | undefined,
  reasoningOff: boolean
): ReasoningEffort | undefined {
  const levels = model?.supportedReasoningEfforts;
  if (!levels?.length) return undefined;
  if (reasoningOff) return model?.reasoningMode === 'always' ? effortWhenOff(model) : undefined;
  return mapReasoningEffort(effort, levels);
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
  return mapReasoningEffort(effort, levels);
}
