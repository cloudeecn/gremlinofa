/**
 * `chatgpt-subscription` provider: the OpenAI Responses wire format served by
 * the ChatGPT backend (`chatgpt.com/backend-api/codex`) and billed to a
 * ChatGPT Plus/Pro plan through Codex-login OAuth tokens.
 *
 * Everything the stock Responses client does still applies; this subclass
 * only swaps credentials and trims the request down to what that backend
 * accepts. Runs in both modes — worker mode needs the definition's CORS proxy
 * because neither chatgpt.com nor auth.openai.com answers browser preflights.
 */

import OpenAI from 'openai';
import type { APIDefinition, APIType, Model, ReasoningEffort } from '../../protocol/types';
import { isChatgptSignedIn } from '../../protocol/apiDefinition';
import { getModelMetadataFor } from '../../engine/lib/api/modelMetadata';
import type { StreamChunk, StreamResult } from './baseClient';
import { CODEX_BASE_URL, ensureFreshTokens } from './chatgptOAuth';
import { buildProxiedRequest, getProxyConfig } from './proxyConfig';
import { ResponsesClient } from './responsesClient';

/** Headers the ChatGPT backend expects on top of the bearer token. */
export const CHATGPT_SUBSCRIPTION_HEADERS: Readonly<Record<string, string>> = {
  'OpenAI-Beta': 'responses=experimental',
  originator: 'codex_cli_rs',
};

/**
 * Shown before sign-in and whenever the `/models` fetch fails, so the picker
 * is never empty. Refresh from a live `/models` response when slugs move on.
 */
export const CHATGPT_SUBSCRIPTION_FALLBACK_MODELS = [
  'gpt-5.3-codex',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
];

/** The backend rejects an empty `instructions` string; this stands in when the project has none. */
export const CHATGPT_SUBSCRIPTION_DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.';

const KNOWN_EFFORTS: ReadonlySet<string> = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

interface CodexModelEntry {
  slug?: string;
  display_name?: string;
  visibility?: string;
  context_window?: number;
  supported_reasoning_levels?: { effort?: string }[];
}

type SendArgs = Parameters<ResponsesClient['sendMessageStream']>;

export class ChatgptSubscriptionClient extends ResponsesClient {
  protected override readonly ownFamily: APIType = 'chatgpt-subscription';

  /**
   * Always bypass the SDK's `.stream()` wrapper: its strict snapshot
   * accumulator is exactly what breaks on a backend that isn't stock OpenAI.
   */
  protected override useStreamAccumulator(): boolean {
    return true;
  }

  /**
   * The backend only speaks SSE — `stream: false` comes back 400 — so the
   * project's disable-streaming toggle cannot apply here.
   */
  protected override supportsNonStreaming(): boolean {
    return false;
  }

  protected override async createClient(apiDefinition: APIDefinition): Promise<OpenAI> {
    const tokens = await ensureFreshTokens(apiDefinition.id, this.deps.storage);
    // The base URL is fixed for this backend; any stray `baseUrl` on the
    // definition must not redirect the proxy target either.
    const proxy = getProxyConfig({ ...apiDefinition, baseUrl: '' });
    return new OpenAI({
      dangerouslyAllowBrowser: true,
      apiKey: tokens.accessToken,
      baseURL: proxy?.baseURL ?? CODEX_BASE_URL,
      defaultHeaders: {
        ...proxy?.headers,
        ...CHATGPT_SUBSCRIPTION_HEADERS,
        'chatgpt-account-id': tokens.accountId,
      },
    });
  }

  /**
   * The ChatGPT backend does not derive prompt-cache affinity from
   * `prompt_cache_key` the way `api.openai.com` does — it keys off these
   * headers, which the Codex CLI sends on every `/responses` call set to its
   * conversation id. Without them every request lands in a fresh bucket and
   * `cached_tokens` comes back zero no matter how stable the prefix is.
   *
   * All three carry the same value, as Codex does. The routing key is a
   * 64-char sha256 hex digest and the backend 400s a `prompt_cache_key` over
   * 64 characters, so this sits exactly at the ceiling — don't swap in a
   * longer digest or a prefixed variant.
   *
   * With no routing key we send nothing: a fresh id per request is worse than
   * no id at all, because it guarantees a miss instead of merely risking one.
   */
  protected override requestHeaders(options: {
    cacheRoutingKey?: string;
  }): Record<string, string> | undefined {
    if (!options.cacheRoutingKey) return undefined;
    return {
      session_id: options.cacheRoutingKey,
      conversation_id: options.cacheRoutingKey,
    };
  }

  protected override finalizeRequestParams(
    requestParams: OpenAI.Responses.ResponseCreateParams,
    options: { systemPrompt?: string },
    _model: Model | undefined
  ): void {
    const input = Array.isArray(requestParams.input) ? requestParams.input : [];

    // System prompt rides `instructions`; the backend does not take a
    // system-role input item. The base builder always puts it first.
    let instructions = options.systemPrompt?.trim() ?? '';
    const rest = input.filter((item, index) => {
      const isLeadingSystem = index === 0 && 'role' in item && item.role === 'system';
      if (isLeadingSystem && !instructions) {
        instructions = extractItemText(item);
      }
      return !isLeadingSystem;
    });
    requestParams.instructions = instructions || CHATGPT_SUBSCRIPTION_DEFAULT_INSTRUCTIONS;

    // Stored history items carry server-minted ids (`rs_…`, `msg_…`, `fc_…`)
    // that a `store: false` backend refuses to see again.
    requestParams.input = rest.map(item => {
      if ('id' in item) {
        const { id: _id, ...withoutId } = item as { id?: string };
        return withoutId as OpenAI.Responses.ResponseInputItem;
      }
      return item;
    });

    delete requestParams.max_output_tokens;
    delete requestParams.service_tier;
    requestParams.store = false;
    requestParams.include = ['reasoning.encrypted_content'];
  }

  override async *sendMessageStream(
    ...args: SendArgs
  ): AsyncGenerator<StreamChunk, StreamResult<OpenAI.Responses.ResponseInputItem[]>, unknown> {
    const result = yield* super.sendMessageStream(...args);
    if (result.error) {
      result.error = rewriteSubscriptionError(result.error);
    }
    return result;
  }

  override async discoverModels(apiDefinition: APIDefinition): Promise<Model[]> {
    const fallback = () =>
      CHATGPT_SUBSCRIPTION_FALLBACK_MODELS.map(id => ({
        ...getModelMetadataFor(apiDefinition, id),
        id,
        name: id,
      }));

    if (!isChatgptSignedIn(apiDefinition)) return fallback();

    try {
      const tokens = await ensureFreshTokens(apiDefinition.id, this.deps.storage);
      const proxied = buildProxiedRequest(apiDefinition, `${CODEX_BASE_URL}/models`);
      const response = await fetch(proxied.url, {
        headers: {
          ...proxied.headers,
          ...CHATGPT_SUBSCRIPTION_HEADERS,
          Authorization: `Bearer ${tokens.accessToken}`,
          'chatgpt-account-id': tokens.accountId,
        },
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      const json = (await response.json()) as { models?: CodexModelEntry[] };
      const listed = (json.models ?? []).filter(
        entry => !!entry.slug && (entry.visibility === undefined || entry.visibility === 'list')
      );
      if (listed.length === 0) return fallback();
      return listed.map(entry => modelFromCodexEntry(apiDefinition, entry));
    } catch (error) {
      console.debug('[chatgptSubscription] /models failed, using fallback list:', error);
      return fallback();
    }
  }
}

function extractItemText(item: OpenAI.Responses.ResponseInputItem): string {
  if (!('content' in item)) return '';
  const content = item.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

function modelFromCodexEntry(apiDefinition: APIDefinition, entry: CodexModelEntry): Model {
  const slug = entry.slug!;
  const known = getModelMetadataFor(apiDefinition, slug);
  const efforts = (entry.supported_reasoning_levels ?? [])
    .map(level => level.effort)
    .filter((effort): effort is ReasoningEffort => !!effort && KNOWN_EFFORTS.has(effort));
  const model: Model = {
    ...known,
    id: slug,
    name: entry.display_name || slug,
  };
  // The backend's context window is authoritative for this backend; curated
  // effort lists win over the backend's when both exist.
  if (typeof entry.context_window === 'number' && entry.context_window > 0) {
    model.contextWindow = entry.context_window;
  }
  if (efforts.length > 0 && !known.supportedReasoningEfforts?.length) {
    model.supportedReasoningEfforts = efforts;
    if (!known.reasoningMode || known.reasoningMode === 'none') model.reasoningMode = 'optional';
  }
  return model;
}

const QUOTA_PATTERN = /usage_limit_reached|rate_limit_exceeded|usage limit/i;

/**
 * Map the base client's API-key-flavored errors onto what actually went
 * wrong for a signed-in subscription: dead tokens, or the plan's quota.
 */
export function rewriteSubscriptionError(error: {
  message: string;
  status?: number;
  stack?: string;
}): { message: string; status?: number; stack?: string } {
  const status = Number.isFinite(error.status) ? error.status : undefined;
  const stripped = error.message.replace(/^API Error: /, '');
  if (/not signed in|sign in again/i.test(stripped)) {
    return { ...error, status, message: stripped };
  }
  if (status === 401) {
    return {
      ...error,
      status,
      message: 'ChatGPT sign-in was rejected (401) — sign in again in Settings.',
    };
  }
  if (status === 429 || QUOTA_PATTERN.test(error.message)) {
    return {
      ...error,
      status,
      message:
        'ChatGPT subscription usage limit reached — wait for the window to reset or switch providers.',
    };
  }
  return { ...error, status };
}
