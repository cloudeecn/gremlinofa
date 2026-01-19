import type { APIType, APIDefinition } from '../types';

/** Display names for API types (shorter names for UI) */
const API_TYPE_DISPLAY_NAMES: Record<APIType, string> = {
  chatgpt: 'Chat Completion',
  responses_api: 'Responses',
  anthropic: 'Anthropic',
  webllm: 'WebLLM',
};

/** Default emoji icons for API types */
const API_TYPE_DEFAULT_ICONS: Record<APIType, string> = {
  responses_api: '⚡',
  chatgpt: '💬',
  anthropic: '✨',
  webllm: '🏠',
};

/** Get the display name for an API type */
export function getApiTypeDisplayName(apiType: APIType): string {
  return API_TYPE_DISPLAY_NAMES[apiType];
}

/** Get the default icon for an API type */
export function getApiTypeDefaultIcon(apiType: APIType): string {
  return API_TYPE_DEFAULT_ICONS[apiType];
}

/** Get the icon for an API definition (custom icon or apiType default) */
export function getApiDefinitionIcon(apiDef: APIDefinition): string {
  return apiDef.icon || getApiTypeDefaultIcon(apiDef.apiType);
}
