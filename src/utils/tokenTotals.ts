import type { TokenTotals } from '../types/content';

/**
 * Create a zero-initialized TokenTotals object.
 */
export function createTokenTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchCount: 0,
    cost: 0,
    costUnreliable: false,
  };
}

/**
 * Add iteration tokens to accumulator (mutates target).
 */
export function addTokens(target: TokenTotals, source: TokenTotals): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.webSearchCount += source.webSearchCount;
  target.cost += source.cost;
  target.costUnreliable = target.costUnreliable || source.costUnreliable;
}

/**
 * Check if a TokenTotals has any non-zero usage.
 */
export function hasTokenUsage(totals: TokenTotals): boolean {
  return totals.inputTokens > 0 || totals.outputTokens > 0 || totals.cost > 0;
}
