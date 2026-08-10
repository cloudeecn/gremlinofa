import type { APIDefinition, APIType } from '../../protocol/types';

/** Default base URLs per provider. Used as X-Proxy-Target when baseUrl is empty. */
const DEFAULT_BASE_URLS: Partial<Record<APIType, string>> = {
  chatgpt: 'https://api.openai.com/v1',
  responses_api: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
  'chatgpt-subscription': 'https://chatgpt.com/backend-api/codex',
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

  const headers: Record<string, string> = { 'X-Proxy-Target': targetUrl };
  if (apiDefinition.proxyAuthToken) {
    headers['X-Proxy-Auth'] = apiDefinition.proxyAuthToken;
  }

  return {
    baseURL: apiDefinition.proxyUrl,
    headers,
  };
}

export interface ProxiedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Route a raw `fetch` to an arbitrary absolute URL through the definition's
 * CORS proxy when one is configured. Unlike `getProxyConfig`, the target host
 * comes from the URL itself rather than the provider's base URL, so OAuth
 * calls to `auth.openai.com` ride the same proxy as the model endpoint. The
 * proxy rebuilds `target.origin + path`, so only the origin goes in the header
 * and the path + query stay on the proxied URL.
 */
export function buildProxiedRequest(
  apiDefinition: Pick<APIDefinition, 'apiType' | 'proxyUrl' | 'proxyAuthToken'>,
  absoluteUrl: string
): ProxiedRequest {
  if (!apiDefinition.proxyUrl || PROXY_UNSUPPORTED.has(apiDefinition.apiType)) {
    return { url: absoluteUrl, headers: {} };
  }
  const target = new URL(absoluteUrl);
  const proxyBase = apiDefinition.proxyUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'X-Proxy-Target': target.origin };
  if (apiDefinition.proxyAuthToken) {
    headers['X-Proxy-Auth'] = apiDefinition.proxyAuthToken;
  }
  return { url: `${proxyBase}${target.pathname}${target.search}`, headers };
}
