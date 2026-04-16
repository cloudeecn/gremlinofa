import type { APIDefinition, APIType } from '../../protocol/types';

/** Default base URLs per provider. Used as X-Proxy-Target when baseUrl is empty. */
const DEFAULT_BASE_URLS: Partial<Record<APIType, string>> = {
  chatgpt: 'https://api.openai.com/v1',
  responses_api: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
};

const PROXY_UNSUPPORTED: Set<APIType> = new Set(['bedrock']);

export interface ProxyOverrides {
  baseURL: string;
  headers: Record<string, string>;
}

/**
 * Compute SDK constructor overrides for CORS proxy routing.
 * Returns null when proxy is not applicable.
 */
export function getProxyConfig(apiDefinition: APIDefinition): ProxyOverrides | null {
  if (!apiDefinition.proxyUrl) return null;
  if (PROXY_UNSUPPORTED.has(apiDefinition.apiType)) return null;

  const targetUrl = apiDefinition.baseUrl || DEFAULT_BASE_URLS[apiDefinition.apiType];
  if (!targetUrl) return null;

  return {
    baseURL: apiDefinition.proxyUrl,
    headers: { 'X-Proxy-Target': targetUrl },
  };
}
