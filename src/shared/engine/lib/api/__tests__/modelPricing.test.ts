import { describe, it, expect } from 'vitest';
import { resolveModelPricing } from '../modelPricing';

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe('resolveModelPricing', () => {
  it('returns the base prices when nothing else applies', () => {
    const prices = resolveModelPricing({ inputPrice: 1, outputPrice: 2, cacheReadPrice: 0.1 });
    expect(prices).toEqual({ inputPrice: 1, outputPrice: 2, cacheReadPrice: 0.1 });
  });

  it('leaves unknown prices out instead of filling them with undefined', () => {
    expect(resolveModelPricing({})).toEqual({});
  });

  describe('context tiers', () => {
    const model = {
      inputPrice: 0.03,
      outputPrice: 0.13,
      cacheReadPrice: 0.006,
      contextPricingTiers: [
        { thresholdTokens: 32768, inputPrice: 0.1, outputPrice: 0.4, cacheReadPrice: 0.02 },
        { thresholdTokens: 262144, inputPrice: 0.2, outputPrice: 0.8 },
      ],
    };

    it('uses the base tier without a prompt size (the price the UI shows)', () => {
      expect(resolveModelPricing(model).inputPrice).toBe(0.03);
    });

    it('applies a tier only strictly above its threshold', () => {
      expect(resolveModelPricing(model, { promptTokens: 32768 }).inputPrice).toBe(0.03);
      expect(resolveModelPricing(model, { promptTokens: 32769 }).inputPrice).toBe(0.1);
    });

    it('picks the highest tier the prompt exceeds', () => {
      expect(resolveModelPricing(model, { promptTokens: 500_000 }).inputPrice).toBe(0.2);
    });

    it('falls back to the base price for fields a tier leaves unset', () => {
      // The top tier sets no cache read price
      expect(resolveModelPricing(model, { promptTokens: 500_000 }).cacheReadPrice).toBe(0.006);
    });

    it('does not depend on tier order', () => {
      const reversed = {
        ...model,
        contextPricingTiers: [...model.contextPricingTiers].reverse(),
      };
      expect(resolveModelPricing(reversed, { promptTokens: 500_000 }).inputPrice).toBe(0.2);
      expect(resolveModelPricing(reversed, { promptTokens: 100_000 }).inputPrice).toBe(0.1);
    });
  });

  describe('price schedules', () => {
    const model = {
      inputPrice: 2,
      outputPrice: 10,
      cacheReadPrice: 0.1,
      priceSchedule: [
        { effectiveFrom: '2027-01-01', outputPrice: 30 },
        { effectiveFrom: '2026-12-01', inputPrice: 4, outputPrice: 20, cacheReadPrice: 0.2 },
      ],
    };

    it('keeps the base price before the first change', () => {
      expect(resolveModelPricing(model, { now: day('2026-11-30') }).inputPrice).toBe(2);
    });

    it('switches on the effective UTC day', () => {
      const prices = resolveModelPricing(model, { now: day('2026-12-01') });
      expect(prices).toEqual({ inputPrice: 4, outputPrice: 20, cacheReadPrice: 0.2 });
    });

    it('layers later changes in date order, keeping fields they leave unset', () => {
      const prices = resolveModelPricing(model, { now: day('2027-03-01') });
      expect(prices).toEqual({ inputPrice: 4, outputPrice: 30, cacheReadPrice: 0.2 });
    });

    it('compares in UTC, not local time', () => {
      // 23:30 UTC on Nov 30 is already Dec 1 in UTC+8, but still Nov 30 in UTC
      const lateNovember = new Date('2026-11-30T23:30:00Z');
      expect(resolveModelPricing(model, { now: lateNovember }).inputPrice).toBe(2);
    });

    it('lets a scheduled change replace or clear the context tiers', () => {
      const routed = {
        inputPrice: 1.25,
        contextPricingTiers: [{ thresholdTokens: 200000, inputPrice: 2.5 }],
        priceSchedule: [{ effectiveFrom: '2026-12-01', inputPrice: 0.75, contextPricingTiers: [] }],
      };
      expect(
        resolveModelPricing(routed, { promptTokens: 300_000, now: day('2026-11-15') })
      ).toEqual({ inputPrice: 2.5 });
      expect(
        resolveModelPricing(routed, { promptTokens: 300_000, now: day('2026-12-15') })
      ).toEqual({ inputPrice: 0.75 });
    });

    it('applies a scheduled tier on top of the scheduled base', () => {
      const sol = {
        inputPrice: 4,
        contextPricingTiers: [{ thresholdTokens: 272000, inputPrice: 8 }],
        priceSchedule: [
          {
            effectiveFrom: '2026-11-30',
            inputPrice: 5,
            contextPricingTiers: [{ thresholdTokens: 272000, inputPrice: 10 }],
          },
        ],
      };
      const after = day('2026-12-02');
      expect(resolveModelPricing(sol, { now: after }).inputPrice).toBe(5);
      expect(resolveModelPricing(sol, { now: after, promptTokens: 300_000 }).inputPrice).toBe(10);
    });
  });
});
