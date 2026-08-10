import { describe, it, expect } from 'vitest';
import { buildProxiedRequest, getProxyConfig } from '../proxyConfig';
import type { APIDefinition } from '../../../protocol/types';

const baseDef: APIDefinition = {
  id: 'sub',
  apiType: 'chatgpt-subscription',
  name: 'ChatGPT',
  baseUrl: '',
  apiKey: '',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('buildProxiedRequest', () => {
  it('passes the absolute URL through without a proxy', () => {
    expect(buildProxiedRequest(baseDef, 'https://auth.openai.com/oauth/token')).toEqual({
      url: 'https://auth.openai.com/oauth/token',
      headers: {},
    });
  });

  it('rewrites to the proxy and targets only the origin', () => {
    const proxied = buildProxiedRequest(
      { ...baseDef, proxyUrl: 'https://proxy.example/cors/', proxyAuthToken: 't' },
      'https://chatgpt.com/backend-api/codex/models?client_version=1'
    );
    expect(proxied).toEqual({
      url: 'https://proxy.example/cors/backend-api/codex/models?client_version=1',
      headers: { 'X-Proxy-Target': 'https://chatgpt.com', 'X-Proxy-Auth': 't' },
    });
  });

  it('never proxies bedrock', () => {
    const proxied = buildProxiedRequest(
      { ...baseDef, apiType: 'bedrock', proxyUrl: '/p' },
      'https://bedrock-runtime.us-east-1.amazonaws.com/x'
    );
    expect(proxied.url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/x');
  });
});

describe('getProxyConfig for chatgpt-subscription', () => {
  it('targets the ChatGPT backend by default', () => {
    expect(getProxyConfig({ ...baseDef, proxyUrl: '/proxy' })).toEqual({
      baseURL: '/proxy',
      headers: { 'X-Proxy-Target': 'https://chatgpt.com/backend-api/codex' },
    });
  });
});
