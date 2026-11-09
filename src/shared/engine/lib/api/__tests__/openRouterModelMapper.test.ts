import { describe, expect, it } from 'vitest';
import { populateFromOpenRouterModel } from '../model_metadatas/openRouterModelMapper';
import type { Model } from '../../../../protocol/types';

const model = (overrides: Partial<Model> = {}): Model => ({
  id: 'z-ai/glm-5.3',
  name: 'z-ai/glm-5.3',
  apiType: 'chatgpt',
  matchedMode: 'default',
  ...overrides,
});

describe('populateFromOpenRouterModel reasoning', () => {
  it('infers optional reasoning from supported_parameters', () => {
    const target = model();
    populateFromOpenRouterModel(target, {
      id: 'z-ai/glm-5.3',
      context_length: 200000,
      supported_parameters: ['reasoning', 'tools'],
    });
    expect(target.reasoningMode).toBe('optional');
  });

  it('turns reasoning.mandatory into always, over inference and hardcoded metadata', () => {
    const inferred = model();
    populateFromOpenRouterModel(inferred, {
      id: 'z-ai/glm-5.3',
      context_length: 200000,
      supported_parameters: ['reasoning'],
      reasoning: { mandatory: true, default_enabled: true },
    });
    expect(inferred.reasoningMode).toBe('always');

    const hardcoded = model({ reasoningMode: 'optional', matchedMode: 'fuzz' });
    populateFromOpenRouterModel(hardcoded, {
      id: 'z-ai/glm-5.3',
      context_length: 200000,
      reasoning: { mandatory: true },
    });
    expect(hardcoded.reasoningMode).toBe('always');
  });

  it('leaves the mode alone when reasoning is not mandatory', () => {
    const target = model({ reasoningMode: 'optional', matchedMode: 'fuzz' });
    populateFromOpenRouterModel(target, {
      id: 'deepseek/deepseek-v4-flash',
      context_length: 1000000,
      reasoning: { mandatory: false, default_enabled: true },
    });
    expect(target.reasoningMode).toBe('optional');
  });
});

describe('populateFromOpenRouterModel pricing', () => {
  it('drops hardcoded tiers and dated changes when OpenRouter supplies a live price', () => {
    const target = model({
      id: 'openai/gpt-5.6-sol',
      inputPrice: 4,
      contextPricingTiers: [{ thresholdTokens: 272000, inputPrice: 8 }],
      priceSchedule: [{ effectiveFrom: '2026-11-30', inputPrice: 5 }],
    });
    populateFromOpenRouterModel(target, {
      id: 'openai/gpt-5.6-sol',
      pricing: { prompt: '0.0000045', completion: '0.000025' },
    });
    expect(target.inputPrice).toBeCloseTo(4.5);
    expect(target.contextPricingTiers).toBeUndefined();
    expect(target.priceSchedule).toBeUndefined();
  });

  it('keeps them when the response carries no pricing', () => {
    const target = model({ priceSchedule: [{ effectiveFrom: '2026-12-01', inputPrice: 4 }] });
    populateFromOpenRouterModel(target, { id: 'z-ai/glm-5.3', context_length: 200000 });
    expect(target.priceSchedule).toHaveLength(1);
  });
});
