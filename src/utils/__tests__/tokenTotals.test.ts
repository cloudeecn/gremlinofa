import { describe, it, expect } from 'vitest';
import { createTokenTotals, addTokens, hasTokenUsage } from '../tokenTotals';
import type { TokenTotals } from '../../types/content';

describe('tokenTotals', () => {
  describe('createTokenTotals', () => {
    it('creates zero-initialized totals', () => {
      const totals = createTokenTotals();
      expect(totals).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        webSearchCount: 0,
        cost: 0,
        costUnreliable: false,
      });
    });
  });

  describe('addTokens', () => {
    it('accumulates all fields', () => {
      const target = createTokenTotals();
      const source: TokenTotals = {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 20,
        cacheCreationTokens: 10,
        cacheReadTokens: 30,
        webSearchCount: 2,
        cost: 0.05,
        costUnreliable: false,
      };

      addTokens(target, source);

      expect(target.inputTokens).toBe(100);
      expect(target.outputTokens).toBe(50);
      expect(target.reasoningTokens).toBe(20);
      expect(target.cacheCreationTokens).toBe(10);
      expect(target.cacheReadTokens).toBe(30);
      expect(target.webSearchCount).toBe(2);
      expect(target.cost).toBe(0.05);
    });

    it('propagates costUnreliable from source', () => {
      const target = createTokenTotals();
      const source: TokenTotals = { ...createTokenTotals(), costUnreliable: true };
      addTokens(target, source);
      expect(target.costUnreliable).toBe(true);
    });

    it('preserves costUnreliable on target', () => {
      const target: TokenTotals = { ...createTokenTotals(), costUnreliable: true };
      addTokens(target, createTokenTotals());
      expect(target.costUnreliable).toBe(true);
    });
  });

  describe('hasTokenUsage', () => {
    it('returns false for zero totals', () => {
      expect(hasTokenUsage(createTokenTotals())).toBe(false);
    });

    it('returns true when inputTokens > 0', () => {
      const totals = { ...createTokenTotals(), inputTokens: 1 };
      expect(hasTokenUsage(totals)).toBe(true);
    });

    it('returns true when outputTokens > 0', () => {
      const totals = { ...createTokenTotals(), outputTokens: 1 };
      expect(hasTokenUsage(totals)).toBe(true);
    });

    it('returns true when cost > 0', () => {
      const totals = { ...createTokenTotals(), cost: 0.001 };
      expect(hasTokenUsage(totals)).toBe(true);
    });
  });
});
