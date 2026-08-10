import { describe, it, expect } from 'vitest';
import { getModelMetadataFor } from '../modelMetadata';
import type { APIDefinition } from '../../../../protocol/types';

const subscriptionDef: APIDefinition = {
  id: 'sub',
  apiType: 'chatgpt-subscription',
  name: 'ChatGPT',
  baseUrl: '',
  apiKey: '',
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe('model metadata for chatgpt-subscription', () => {
  it('borrows the responses_api knowledge for the same slugs', () => {
    const viaResponses = getModelMetadataFor(
      { ...subscriptionDef, apiType: 'responses_api' },
      'gpt-5.2'
    );
    const viaSubscription = getModelMetadataFor(subscriptionDef, 'gpt-5.2');
    expect(viaResponses.matchedMode).not.toBe('default');
    expect(viaSubscription.matchedMode).toBe(viaResponses.matchedMode);
    expect(viaSubscription.contextWindow).toBe(viaResponses.contextWindow);
    expect(viaSubscription.apiType).toBe('chatgpt-subscription');
  });
});
