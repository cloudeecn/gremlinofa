/**
 * Pure form <-> APIDefinition conversion for the API definition form.
 *
 * Its own module so ApiDefinitionForm.tsx exports only a component (fast
 * refresh), and so the save-side rules (which fields a provider type scrubs,
 * which advanced flags get written) are unit-testable without rendering.
 */

import type { APIDefinition, APIType, ReasoningDialect } from '../../../shared/protocol/types';

export type AdvancedSettings = NonNullable<APIDefinition['advancedSettings']>;

export interface ApiDefinitionFormState {
  apiType: APIType;
  name: string;
  icon: string;
  baseUrl: string;
  apiKey: string;
  isLocal: boolean;
  modelsEndpoint: string;
  modelsEndpointDisabled: boolean;
  proxyUrl: string;
  proxyAuthToken: string;
  /** One model id per line, as typed. */
  extraModelIds: string;
  binaryPath: string;
  extraArgs: string;
  // The rest are the advancedSettings flags.
  pruneThinking: boolean;
  pruneEmptyText: boolean;
  isSubscription: boolean;
  enforceGenuineAnthropic: boolean;
  reasoningDialect: ReasoningDialect;
  reasoningDialectOverride: boolean;
  nudgeThinking: boolean;
  mandateCoT: boolean;
  treatEmptyOutputAsError: boolean;
  treatFallbackAsError: boolean;
  useStreamAccumulator: boolean;
  flexTierSupported: boolean;
}

export const EMPTY_API_DEFINITION_FORM: ApiDefinitionFormState = {
  apiType: 'responses_api',
  name: '',
  icon: '',
  baseUrl: '',
  apiKey: '',
  isLocal: false,
  modelsEndpoint: '',
  modelsEndpointDisabled: false,
  proxyUrl: '',
  proxyAuthToken: '',
  extraModelIds: '',
  binaryPath: '',
  extraArgs: '',
  pruneThinking: false,
  pruneEmptyText: false,
  isSubscription: false,
  enforceGenuineAnthropic: false,
  reasoningDialect: 'openai',
  reasoningDialectOverride: false,
  nudgeThinking: false,
  mandateCoT: false,
  treatEmptyOutputAsError: false,
  treatFallbackAsError: false,
  useStreamAccumulator: false,
  flexTierSupported: false,
};

/**
 * The subscription providers bring their own endpoint and model discovery, so
 * base URL, Local, models endpoint and the generic extra-model list don't apply.
 * claude-agent's SDK never reads them; chatgpt-subscription has a fixed base URL
 * and lists models from the ChatGPT backend.
 */
export function hidesProviderFields(apiType: APIType): boolean {
  return apiType === 'claude-agent' || apiType === 'chatgpt-subscription';
}

/**
 * Bedrock signs its requests (the proxy config skips it) and claude-agent runs
 * the host CLI, so neither shows the CORS proxy fields.
 */
export function showsProxyFields(apiType: APIType): boolean {
  return apiType !== 'bedrock' && apiType !== 'claude-agent';
}

const ALL_REASONING_DIALECTS: readonly ReasoningDialect[] = [
  'openai',
  'thinking-object',
  'enable-thinking',
  'openrouter',
];

/** The advanced fields that only some provider types show. */
export interface TypeSpecificAdvancedFields {
  /** Dialects the type's client can send; empty hides the dialect picker and its override. */
  reasoningDialects: readonly ReasoningDialect[];
  enforceGenuineAnthropic: boolean;
  treatFallbackAsError: boolean;
  useStreamAccumulator: boolean;
  flexTierSupported: boolean;
}

/**
 * AdvancedFields renders exactly these and buildAdvancedSettings saves only
 * these. Otherwise a flag ticked under one type and carried over by a type
 * switch in the add form would be stored where no form shows it, and nobody
 * could untick it (a stray flex tier on chatgpt-subscription halves its
 * reported cost in any project with flex on; a stray dialect can change its
 * request shape).
 */
export function typeSpecificAdvancedFields(apiType: APIType): TypeSpecificAdvancedFields {
  const isChatgptSubscription = apiType === 'chatgpt-subscription';
  return {
    // Only the two OpenAI-compatible clients take a dialect; Anthropic, Google,
    // Bedrock and claude-agent have their own reasoning parameters, and the
    // ChatGPT backend speaks stock OpenAI. OpenRouter's object is Chat
    // Completions only: the Responses API has its own native reasoning field.
    reasoningDialects:
      apiType === 'chatgpt'
        ? ALL_REASONING_DIALECTS
        : apiType === 'responses_api'
          ? ALL_REASONING_DIALECTS.filter(d => d !== 'openrouter')
          : [],
    enforceGenuineAnthropic: !isChatgptSubscription,
    treatFallbackAsError: apiType === 'claude-agent',
    useStreamAccumulator: apiType === 'responses_api',
    flexTierSupported: !isChatgptSubscription,
  };
}

/** The dialect the form shows and saves: one the type can't send falls back to `openai`. */
export function effectiveReasoningDialect(form: ApiDefinitionFormState): ReasoningDialect {
  return typeSpecificAdvancedFields(form.apiType).reasoningDialects.includes(form.reasoningDialect)
    ? form.reasoningDialect
    : 'openai';
}

/** Stored dialect for a definition, reading the legacy `deFactoThinking` boolean. */
function reasoningDialectOf(def: APIDefinition): ReasoningDialect {
  const advanced = def.advancedSettings;
  if (advanced?.reasoningDialect) return advanced.reasoningDialect;
  return advanced?.deFactoThinking ? 'thinking-object' : 'openai';
}

export function apiDefinitionToForm(def: APIDefinition): ApiDefinitionFormState {
  const advanced = def.advancedSettings;
  return {
    apiType: def.apiType,
    name: def.name,
    icon: def.icon || '',
    baseUrl: def.baseUrl,
    apiKey: def.apiKey,
    isLocal: def.isLocal || false,
    modelsEndpoint: def.modelsEndpoint || '',
    modelsEndpointDisabled: def.modelsEndpointDisabled || false,
    proxyUrl: def.proxyUrl || '',
    proxyAuthToken: def.proxyAuthToken || '',
    extraModelIds: (def.extraModelIds || []).join('\n'),
    binaryPath: def.binaryPath || '',
    extraArgs: def.extraArgs || '',
    pruneThinking: advanced?.pruneThinking || false,
    pruneEmptyText: advanced?.pruneEmptyText || false,
    isSubscription: advanced?.isSubscription || false,
    enforceGenuineAnthropic: advanced?.enforceGenuineAnthropic || false,
    reasoningDialect: reasoningDialectOf(def),
    reasoningDialectOverride: advanced?.reasoningDialectOverride || false,
    nudgeThinking: advanced?.nudgeThinking || false,
    mandateCoT: advanced?.mandateCoT || false,
    treatEmptyOutputAsError: advanced?.treatEmptyOutputAsError || false,
    treatFallbackAsError: advanced?.treatFallbackAsError || false,
    useStreamAccumulator: advanced?.useStreamAccumulator || false,
    flexTierSupported: advanced?.flexTierSupported || false,
  };
}

/**
 * Only the flags that are on get a key, and a form with none on yields
 * `undefined`, so an untouched definition stores no `advancedSettings` at all.
 * Flags the form's API type doesn't show are dropped (see
 * `typeSpecificAdvancedFields`), which also clears stale ones on the next save.
 */
export function buildAdvancedSettings(form: ApiDefinitionFormState): AdvancedSettings | undefined {
  const shown = typeSpecificAdvancedFields(form.apiType);
  const reasoningDialect = effectiveReasoningDialect(form);
  const settings: AdvancedSettings = {
    ...(form.pruneThinking && { pruneThinking: true }),
    ...(form.pruneEmptyText && { pruneEmptyText: true }),
    ...(form.isSubscription && { isSubscription: true }),
    ...(shown.enforceGenuineAnthropic &&
      form.enforceGenuineAnthropic && { enforceGenuineAnthropic: true }),
    // Writing the enum drops any legacy `deFactoThinking` key on save, which is
    // the migration: the resolver reads both, we only write one.
    ...(reasoningDialect !== 'openai' && { reasoningDialect }),
    ...(shown.reasoningDialects.length > 0 &&
      form.reasoningDialectOverride && { reasoningDialectOverride: true }),
    ...(form.nudgeThinking && { nudgeThinking: true }),
    ...(form.mandateCoT && { mandateCoT: true }),
    ...(form.treatEmptyOutputAsError && { treatEmptyOutputAsError: true }),
    ...(shown.treatFallbackAsError && form.treatFallbackAsError && { treatFallbackAsError: true }),
    ...(shown.useStreamAccumulator && form.useStreamAccumulator && { useStreamAccumulator: true }),
    ...(shown.flexTierSupported && form.flexTierSupported && { flexTierSupported: true }),
  };
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * The definition a full form save writes. `existing` is the stored definition
 * when editing (it keeps `isDefault` and `createdAt`); omit it when adding.
 *
 * Fields the form hides for `form.apiType` are scrubbed, like the hidden
 * advanced flags: a value typed under another type in the add form, or stored
 * before the type hid it, would otherwise stay in effect with no field to
 * clear it (a leftover models endpoint replaces a subscription's model list).
 */
export function formToApiDefinition(
  form: ApiDefinitionFormState,
  { id, existing, now }: { id: string; existing?: APIDefinition; now: Date }
): APIDefinition {
  // chatgpt-subscription's credentials live in the backend-owned `oauth`
  // block, so it has no API key field.
  const isChatgptSubscription = form.apiType === 'chatgpt-subscription';
  const isClaudeAgent = form.apiType === 'claude-agent';
  const providerFieldsShown = !hidesProviderFields(form.apiType);
  const proxyFieldsShown = showsProxyFields(form.apiType);
  const extraModelIds = form.extraModelIds
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  return {
    id,
    apiType: form.apiType,
    name: form.name.trim(),
    icon: form.icon.trim() || undefined,
    baseUrl: providerFieldsShown ? form.baseUrl.trim() : '',
    apiKey: isChatgptSubscription ? '' : form.apiKey.trim(),
    isDefault: existing ? existing.isDefault : false,
    // The subscription providers have no Local checkbox; scrub stale values so
    // their own badges (not Local) win for keyless definitions.
    isLocal: providerFieldsShown ? form.isLocal : false,
    modelsEndpoint: (providerFieldsShown && form.modelsEndpoint.trim()) || undefined,
    modelsEndpointDisabled: form.modelsEndpointDisabled || undefined,
    proxyUrl: (proxyFieldsShown && form.proxyUrl.trim()) || undefined,
    proxyAuthToken: (proxyFieldsShown && form.proxyAuthToken.trim()) || undefined,
    extraModelIds: extraModelIds.length > 0 ? extraModelIds : undefined,
    binaryPath: (isClaudeAgent && form.binaryPath.trim()) || undefined,
    extraArgs: (isClaudeAgent && form.extraArgs.trim()) || undefined,
    advancedSettings: buildAdvancedSettings(form),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}
