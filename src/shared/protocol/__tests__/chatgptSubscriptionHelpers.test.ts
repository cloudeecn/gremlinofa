import { describe, it, expect } from 'vitest';
import type { APIDefinition } from '../types';
import {
  apiKeyOptional,
  isChatgptSignedIn,
  isConfiguredApiDefinition,
  isSubscriptionApiDefinition,
} from '../apiDefinition';
import { extractToolUseBlocks } from '../../engine/lib/apiHelpers';

const def: APIDefinition = {
  id: 'sub',
  apiType: 'chatgpt-subscription',
  name: 'ChatGPT',
  baseUrl: '',
  apiKey: '',
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe('chatgpt-subscription definition helpers', () => {
  it('needs no API key', () => {
    expect(apiKeyOptional(def)).toBe(true);
  });

  it('tracks $0 only when the advanced flag is on, even for the subscription apiType', () => {
    expect(isSubscriptionApiDefinition(def)).toBe(false);
    expect(
      isSubscriptionApiDefinition({ ...def, advancedSettings: { isSubscription: true } })
    ).toBe(true);
    expect(isSubscriptionApiDefinition({ ...def, apiType: 'responses_api' })).toBe(false);
    expect(
      isSubscriptionApiDefinition({
        ...def,
        apiType: 'responses_api',
        advancedSettings: { isSubscription: true },
      })
    ).toBe(true);
    expect(isSubscriptionApiDefinition(null)).toBe(false);
  });

  it('counts as configured once signed in', () => {
    expect(isConfiguredApiDefinition(def)).toBe(false);
    const signedIn = {
      ...def,
      oauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1, accountId: 'x' },
    };
    expect(isChatgptSignedIn(signedIn)).toBe(true);
    expect(isConfiguredApiDefinition(signedIn)).toBe(true);
  });

  it('extracts Responses-format tool blocks from stored fullContent', () => {
    const blocks = extractToolUseBlocks('chatgpt-subscription', [
      { type: 'function_call', call_id: 'call_1', name: 'memory', arguments: '{"a":1}' },
    ]);
    expect(blocks).toEqual([{ type: 'tool_use', id: 'call_1', name: 'memory', input: { a: 1 } }]);
  });
});
