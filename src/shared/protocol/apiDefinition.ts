import type { APIDefinition } from './types';

/**
 * Whether an API definition works with an empty `apiKey`: local providers
 * (Ollama, LM Studio) and claude-agent, where an empty key falls back to the
 * host `claude` CLI's own credentials. Gates every "is this definition
 * configured?" check (model discovery, selector warnings, status badges) so
 * keyless claude-agent definitions aren't treated as unconfigured.
 */
export function apiKeyOptional(def: Pick<APIDefinition, 'isLocal' | 'apiType'>): boolean {
  return !!def.isLocal || def.apiType === 'claude-agent' || def.apiType === 'chatgpt-subscription';
}

/**
 * Whether any definition can serve requests: holds a key, or doesn't need
 * one. False on a fresh install, whose seeded defaults carry no keys.
 */
export function hasUsableApiDefinition(
  defs: readonly Pick<APIDefinition, 'isLocal' | 'apiType' | 'apiKey'>[]
): boolean {
  return defs.some(def => apiKeyOptional(def) || !!def.apiKey?.trim());
}

/**
 * Whether every call's cost is tracked as $0 because the definition bills a
 * flat-rate subscription. Opt-in through the Advanced `isSubscription`
 * checkbox for every apiType — including the subscription providers, which
 * default to metadata (API-list) prices so the user can see what the same
 * usage would have cost per token.
 */
export function isSubscriptionApiDefinition(
  def: Pick<APIDefinition, 'apiType' | 'advancedSettings'> | null | undefined
): boolean {
  return !!def?.advancedSettings?.isSubscription;
}

/** Whether a `chatgpt-subscription` definition currently holds sign-in tokens. */
export function isChatgptSignedIn(def: Pick<APIDefinition, 'oauth'>): boolean {
  return !!def.oauth?.accessToken && !!def.oauth?.refreshToken;
}

/**
 * Base URLs that ship on factory-seeded default definitions (see
 * `UnifiedStorage.initializeDefaults`). A default whose baseUrl still
 * matches one of these has not been pointed anywhere by the user.
 */
export const FACTORY_DEFAULT_BASE_URLS: ReadonlySet<string> = new Set(['https://api.x.ai/v1']);

/**
 * Whether the user has actually configured this definition — any field
 * beyond the factory-seeded template counts, not just credentials. A
 * definition can be fully usable with no API key (isLocal, claude-agent,
 * proxy-fronted providers), and losing proxy/model-list/CLI settings on
 * export is just as much data loss as losing a key.
 *
 * Used by data export (only configured defaults are exported) and import
 * (an unconfigured local default may be overwritten by the imported one).
 */
export function isConfiguredApiDefinition(def: APIDefinition): boolean {
  const hasCustomBaseUrl = !!def.baseUrl && !FACTORY_DEFAULT_BASE_URLS.has(def.baseUrl);
  const hasAdvancedSettings =
    !!def.advancedSettings && Object.values(def.advancedSettings).some(v => v !== undefined);
  return (
    !!def.apiKey ||
    hasCustomBaseUrl ||
    !!def.isLocal ||
    !!def.proxyUrl ||
    !!def.proxyAuthToken ||
    !!def.modelsEndpoint ||
    !!def.modelsEndpointDisabled ||
    (def.extraModelIds?.length ?? 0) > 0 ||
    !!def.binaryPath ||
    !!def.extraArgs ||
    !!def.oauth ||
    !!def.icon ||
    hasAdvancedSettings
  );
}
