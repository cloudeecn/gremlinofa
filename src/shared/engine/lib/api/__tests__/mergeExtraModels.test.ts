import { describe, it, expect } from 'vitest';
import { mergeExtraModels } from '../mergeExtraModels';
import type { APIDefinition, Model } from '../../../../protocol/types';

function createApiDef(overrides: Partial<APIDefinition> = {}): APIDefinition {
  return {
    id: 'test-api-def',
    apiType: 'chatgpt',
    name: 'Test API',
    baseUrl: '',
    apiKey: 'test-key',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createModel(id: string): Model {
  return {
    id,
    name: id,
    apiType: 'chatgpt',
    matchedMode: 'exact',
  };
}

describe('mergeExtraModels', () => {
  it('returns discovered models unchanged when extraModelIds is undefined', () => {
    const discovered = [createModel('gpt-4o'), createModel('gpt-4o-mini')];
    const apiDef = createApiDef();

    const result = mergeExtraModels(discovered, apiDef);

    expect(result).toBe(discovered); // same reference, no copy
  });

  it('returns discovered models unchanged when extraModelIds is empty', () => {
    const discovered = [createModel('gpt-4o')];
    const apiDef = createApiDef({ extraModelIds: [] });

    const result = mergeExtraModels(discovered, apiDef);

    expect(result).toBe(discovered);
  });

  it('appends extra models not in discovered list', () => {
    const discovered = [createModel('gpt-4o')];
    const apiDef = createApiDef({ extraModelIds: ['preview-model-1', 'preview-model-2'] });

    const result = mergeExtraModels(discovered, apiDef);

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('gpt-4o');
    expect(result[1].id).toBe('preview-model-1');
    expect(result[2].id).toBe('preview-model-2');
  });

  it('deduplicates extra models already present in discovered list', () => {
    const discovered = [createModel('gpt-4o'), createModel('gpt-4o-mini')];
    const apiDef = createApiDef({ extraModelIds: ['gpt-4o', 'preview-model'] });

    const result = mergeExtraModels(discovered, apiDef);

    expect(result).toHaveLength(3);
    expect(result.map(m => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini', 'preview-model']);
  });

  it('deduplicates within extraModelIds itself', () => {
    const apiDef = createApiDef({ extraModelIds: ['model-a', 'model-a', 'model-b'] });

    const result = mergeExtraModels([], apiDef);

    expect(result).toHaveLength(2);
    expect(result.map(m => m.id)).toEqual(['model-a', 'model-b']);
  });

  it('trims whitespace and skips empty lines', () => {
    const apiDef = createApiDef({
      extraModelIds: ['  preview-model  ', '', '  ', 'another-model'],
    });

    const result = mergeExtraModels([], apiDef);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('preview-model');
    expect(result[1].id).toBe('another-model');
  });

  it('unknown extra models get matchedMode default', () => {
    const apiDef = createApiDef({
      extraModelIds: ['totally-unknown-model-xyz'],
    });

    const result = mergeExtraModels([], apiDef);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('totally-unknown-model-xyz');
    expect(result[0].matchedMode).toBe('default');
  });

  it('known extra models get metadata enrichment', () => {
    const apiDef = createApiDef({ apiType: 'chatgpt', extraModelIds: ['gpt-4o'] });

    const result = mergeExtraModels([], apiDef);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('gpt-4o');
    expect(result[0].matchedMode).toBe('exact');
    expect(result[0].inputPrice).toBeDefined();
  });
});
