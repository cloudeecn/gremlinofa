import { describe, it, expect } from 'vitest';
import { getProxyConfig } from '../proxyConfig';
import type { APIDefinition } from '../../../protocol/types';

const baseDef: APIDefinition = {
  id: 'test',
  apiType: 'chatgpt',
  name: 'Test',
  baseUrl: '',
  apiKey: 'sk-test',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('getProxyConfig', () => {
  it('returns null when proxyUrl is not set', () => {
    expect(getProxyConfig({ ...baseDef })).toBeNull();
  });

  it('returns null for bedrock even with proxyUrl', () => {
    expect(getProxyConfig({ ...baseDef, apiType: 'bedrock', proxyUrl: '/proxy' })).toBeNull();
  });

  it('uses OpenAI default for chatgpt when baseUrl is empty', () => {
    const result = getProxyConfig({ ...baseDef, apiType: 'chatgpt', proxyUrl: '/proxy' });
    expect(result).toEqual({
      baseURL: '/proxy',
      headers: { 'X-Proxy-Target': 'https://api.openai.com/v1' },
    });
  });

  it('uses OpenAI default for responses_api when baseUrl is empty', () => {
    const result = getProxyConfig({ ...baseDef, apiType: 'responses_api', proxyUrl: '/proxy' });
    expect(result?.headers['X-Proxy-Target']).toBe('https://api.openai.com/v1');
  });

  it('uses Anthropic default when baseUrl is empty', () => {
    const result = getProxyConfig({ ...baseDef, apiType: 'anthropic', proxyUrl: '/proxy' });
    expect(result?.headers['X-Proxy-Target']).toBe('https://api.anthropic.com');
  });

  it('uses Google default when baseUrl is empty', () => {
    const result = getProxyConfig({ ...baseDef, apiType: 'google', proxyUrl: '/proxy' });
    expect(result?.headers['X-Proxy-Target']).toBe('https://generativelanguage.googleapis.com');
  });

  it('prefers custom baseUrl over provider default', () => {
    const result = getProxyConfig({
      ...baseDef,
      apiType: 'anthropic',
      baseUrl: 'https://custom.example.com',
      proxyUrl: '/proxy',
    });
    expect(result?.headers['X-Proxy-Target']).toBe('https://custom.example.com');
  });

  it('uses proxyUrl as baseURL', () => {
    const result = getProxyConfig({
      ...baseDef,
      proxyUrl: 'https://my-proxy.example.com/cors-proxy',
    });
    expect(result?.baseURL).toBe('https://my-proxy.example.com/cors-proxy');
  });
});
