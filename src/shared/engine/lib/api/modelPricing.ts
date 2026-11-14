import type { ContextPricingTier, ModelMetadata, PriceFields } from '../../../protocol/types';

// Kept free of the metadata tables so the frontend can resolve prices on the
// `Model` objects it already holds without bundling every provider's entries.

const PRICE_KEYS = [
  'inputPrice',
  'outputPrice',
  'cacheReadPrice',
  'cacheWritePrice',
  'reasoningPrice',
] as const satisfies ReadonlyArray<keyof PriceFields>;

type PricedModel = Pick<ModelMetadata, keyof PriceFields | 'contextPricingTiers' | 'priceSchedule'>;

export interface PricingContext {
  /** Prompt size of one request (input + cache read + cache write). Omit for the base tier. */
  promptTokens?: number;
  /** Defaults to the current time; schedules compare UTC calendar days. */
  now?: Date;
}

function overlay(base: PriceFields, layer: PriceFields): PriceFields {
  const merged = { ...base };
  for (const key of PRICE_KEYS) {
    if (layer[key] !== undefined) merged[key] = layer[key];
  }
  return merged;
}

/**
 * Effective token prices for a model: scheduled changes whose date has arrived
 * are applied in date order, then the highest context tier the prompt exceeds.
 * Without `promptTokens` the base (lowest) tier is returned, which is what the
 * UI shows as the model's price.
 */
export function resolveModelPricing(model: PricedModel, context: PricingContext = {}): PriceFields {
  let prices: PriceFields = {};
  for (const key of PRICE_KEYS) {
    if (model[key] !== undefined) prices[key] = model[key];
  }
  let tiers: ContextPricingTier[] | undefined = model.contextPricingTiers;

  if (model.priceSchedule?.length) {
    const today = (context.now ?? new Date()).toISOString().slice(0, 10);
    const arrived = model.priceSchedule
      .filter(entry => entry.effectiveFrom <= today)
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    for (const entry of arrived) {
      prices = overlay(prices, entry);
      if (entry.contextPricingTiers !== undefined) tiers = entry.contextPricingTiers;
    }
  }

  const { promptTokens } = context;
  if (promptTokens !== undefined && tiers?.length) {
    let activeTier: ContextPricingTier | undefined;
    for (const tier of tiers) {
      if (
        promptTokens > tier.thresholdTokens &&
        (!activeTier || tier.thresholdTokens > activeTier.thresholdTokens)
      ) {
        activeTier = tier;
      }
    }
    if (activeTier) prices = overlay(prices, activeTier);
  }

  return prices;
}
