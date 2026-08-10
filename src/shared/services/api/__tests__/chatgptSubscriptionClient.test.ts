import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MockedClass } from 'vitest';
import OpenAI from 'openai';
import type {
  APIDefinition,
  APIType,
  ChatgptOAuthTokens,
  ClientSideTool,
} from '../../../protocol/types';
import type { UnifiedStorage } from '../../storage/unifiedStorage';
import {
  CHATGPT_SUBSCRIPTION_DEFAULT_INSTRUCTIONS,
  CHATGPT_SUBSCRIPTION_FALLBACK_MODELS,
  ChatgptSubscriptionClient,
  rewriteSubscriptionError,
} from '../chatgptSubscriptionClient';
import { stubApiDeps } from './testStubs';

vi.mock('openai');

function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
  return `${b64('{"alg":"none"}')}.${b64(JSON.stringify(payload))}.sig`;
}

const ACCESS_JWT = makeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_9' } });

function makeTokens(): ChatgptOAuthTokens {
  return {
    accessToken: ACCESS_JWT,
    refreshToken: 'refresh',
    expiresAt: Date.now() + 3_600_000,
    accountId: 'acct_9',
  };
}

function makeDef(overrides: Partial<APIDefinition> = {}): APIDefinition {
  return {
    id: 'def_sub',
    apiType: 'chatgpt-subscription',
    name: 'ChatGPT',
    baseUrl: '',
    apiKey: '',
    oauth: makeTokens(),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

async function* emptyStream() {}

type SendArgs = Parameters<ChatgptSubscriptionClient['sendMessageStream']>;
type SendMessages = SendArgs[0];

describe('ChatgptSubscriptionClient', () => {
  let client: ChatgptSubscriptionClient;
  let apiDef: APIDefinition;
  const storage = {
    getAPIDefinition: vi.fn(async () => apiDef),
    saveAPIDefinition: vi.fn(async () => {}),
    getModel: vi.fn(async () => undefined),
  };
  const create = vi.fn(async () => emptyStream());
  let ctorArgs: Record<string, unknown> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    apiDef = makeDef();
    client = new ChatgptSubscriptionClient({
      ...stubApiDeps,
      storage: storage as unknown as UnifiedStorage,
    });
    (OpenAI as MockedClass<typeof OpenAI>).mockImplementation(function (
      this: unknown,
      args: Record<string, unknown>
    ) {
      ctorArgs = args;
      return { responses: { create }, models: { list: vi.fn() } } as unknown as OpenAI;
    } as unknown as () => OpenAI);
  });

  async function send(messages: SendMessages, options: Partial<SendArgs[3]> = {}) {
    const gen = client.sendMessageStream(messages, 'gpt-5.2', apiDef, {
      maxTokens: 4096,
      enableReasoning: true,
      reasoningBudgetTokens: 0,
      enabledTools: [],
      signal: new AbortController().signal,
      ...options,
    } as SendArgs[3]);
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    return next.value;
  }

  function sentParams(): Record<string, unknown> {
    return (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
  }

  function sentRequestOptions(): Record<string, unknown> {
    return (create.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
  }

  it('constructs the SDK client against the ChatGPT backend with the OAuth headers', async () => {
    await send([]);
    expect(ctorArgs).toMatchObject({
      apiKey: ACCESS_JWT,
      baseURL: 'https://chatgpt.com/backend-api/codex',
      defaultHeaders: {
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
        'chatgpt-account-id': 'acct_9',
      },
    });
  });

  it('routes through the CORS proxy while keeping the backend as the target', async () => {
    apiDef = makeDef({ proxyUrl: 'https://proxy.example/cors', baseUrl: 'https://ignored' });
    await send([]);
    expect(ctorArgs).toMatchObject({
      baseURL: 'https://proxy.example/cors',
      defaultHeaders: { 'X-Proxy-Target': 'https://chatgpt.com/backend-api/codex' },
    });
  });

  it('shapes the request for the backend: instructions, no max_output_tokens, ids stripped', async () => {
    const history: SendMessages = [
      {
        id: 'm1',
        chatId: 'c',
        role: 'assistant',
        timestamp: new Date(0),
        content: {
          content: 'earlier',
          modelFamily: 'chatgpt-subscription',
          fullContent: [
            { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'enc' },
            {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'earlier' }],
            },
          ],
        },
      } as unknown as SendMessages[number],
      {
        id: 'm2',
        chatId: 'c',
        role: 'user',
        timestamp: new Date(0),
        content: { content: 'hi', modelFamily: 'chatgpt-subscription' },
      } as unknown as SendMessages[number],
    ];
    await send(history, { systemPrompt: 'Be terse.', flexTierEnabled: true });

    const params = sentParams();
    expect(params.instructions).toBe('Be terse.');
    expect(params.max_output_tokens).toBeUndefined();
    expect(params.service_tier).toBeUndefined();
    expect(params.store).toBe(false);
    expect(params.stream).toBe(true);
    expect(params.include).toEqual(['reasoning.encrypted_content']);

    const input = params.input as Record<string, unknown>[];
    expect(input.some(item => item.role === 'system')).toBe(false);
    expect(input.every(item => !('id' in item))).toBe(true);
    // Own-family history is replayed verbatim (minus ids), so the encrypted
    // reasoning item survives.
    expect(input[0]).toMatchObject({ type: 'reasoning', encrypted_content: 'enc' });
  });

  it('sends the cache-affinity headers the ChatGPT backend keys its prompt cache on', async () => {
    const routingKey = 'a'.repeat(64);
    await send([], { cacheRoutingKey: routingKey });

    // Codex sets all three to the same conversation id; the headers are what
    // the backend actually reads, prompt_cache_key alone yields no hits.
    expect(sentRequestOptions().headers).toEqual({
      session_id: routingKey,
      conversation_id: routingKey,
    });
    expect(sentParams().prompt_cache_key).toBe(routingKey);
  });

  it('omits the cache-affinity headers rather than minting an id per request', async () => {
    await send([]);
    expect(sentRequestOptions().headers).toBeUndefined();
    expect(sentParams().prompt_cache_key).toBeUndefined();
  });

  it('downgrades as-file injection the backend has no input_file support for', async () => {
    const history: SendMessages = [
      {
        id: 'm1',
        chatId: 'c',
        role: 'user',
        timestamp: new Date(0),
        content: {
          content: 'look at this',
          modelFamily: 'chatgpt-subscription',
          injectionMode: 'as-file',
          injectedFiles: [{ path: '/notes.md', content: 'body', mimeType: 'text/markdown' }],
        },
      } as unknown as SendMessages[number],
    ];
    await send(history);

    const parts = (sentParams().input as Record<string, unknown>[])[0].content as Record<
      string,
      unknown
    >[];
    expect(parts.some(part => part.type === 'input_file')).toBe(false);
    expect(parts.some(part => part.type === 'input_text')).toBe(true);
  });

  it('falls back to default instructions when the project has no system prompt', async () => {
    await send([]);
    expect(sentParams().instructions).toBe(CHATGPT_SUBSCRIPTION_DEFAULT_INSTRUCTIONS);
  });

  it('reports a sign-in error instead of an API key error when not signed in', async () => {
    apiDef = makeDef({ oauth: undefined });
    const result = await send([]);
    expect(result.error?.message).toMatch(/Not signed in/);
    expect(result.error?.message).not.toMatch(/API Error/);
    expect(create).not.toHaveBeenCalled();
  });

  describe('discoverModels', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('returns the fallback list when not signed in', async () => {
      const models = await client.discoverModels(makeDef({ oauth: undefined }));
      expect(models.map(m => m.id)).toEqual(CHATGPT_SUBSCRIPTION_FALLBACK_MODELS);
      expect(models[0].apiType).toBe('chatgpt-subscription');
    });

    it('lists visible backend models with the auth headers and overlays the context window', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  slug: 'gpt-5.2',
                  display_name: 'GPT-5.2',
                  visibility: 'list',
                  context_window: 272000,
                  supported_reasoning_levels: [{ effort: 'low' }, { effort: 'bogus' }],
                },
                { slug: 'gpt-hidden', visibility: 'hide' },
              ],
            }),
            { status: 200 }
          )
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const models = await client.discoverModels(apiDef);
      expect(models.map(m => m.id)).toEqual(['gpt-5.2']);
      expect(models[0].name).toBe('GPT-5.2');
      expect(models[0].contextWindow).toBe(272000);

      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://chatgpt.com/backend-api/codex/models');
      expect(init.headers).toMatchObject({
        Authorization: `Bearer ${ACCESS_JWT}`,
        'chatgpt-account-id': 'acct_9',
        'OpenAI-Beta': 'responses=experimental',
      });
    });

    it('falls back when the backend errors', async () => {
      globalThis.fetch = vi.fn(
        async () => new Response('nope', { status: 500 })
      ) as unknown as typeof fetch;
      const models = await client.discoverModels(apiDef);
      expect(models.map(m => m.id)).toEqual(CHATGPT_SUBSCRIPTION_FALLBACK_MODELS);
    });
  });

  it('sends the GA web_search tool, never the legacy alias the backend rejects', async () => {
    await send([], { webSearchEnabled: true });
    expect(sentParams().tools).toEqual([{ type: 'web_search' }]);
  });

  it('keeps streaming on even when the project disables it', async () => {
    await send([], { disableStream: true });
    expect(sentParams().stream).toBe(true);
  });

  it('applies a chatgpt-subscription tool override', async () => {
    const override = { type: 'custom', name: 'ping', description: 'pong' };
    stubApiDeps.toolRegistry.registerAll([
      {
        name: 'ping',
        description: 'ping',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => ({ content: '' }),
        getApiOverride: (apiType: APIType) =>
          apiType === 'chatgpt-subscription' ? (override as OpenAI.Responses.Tool) : undefined,
      } as unknown as ClientSideTool,
    ]);

    await send([], { enabledTools: ['ping'] });
    expect(sentParams().tools).toEqual([override]);
  });
});

describe('rewriteSubscriptionError', () => {
  it('turns 401 into a sign-in message', () => {
    expect(rewriteSubscriptionError({ message: 'Invalid API key.', status: 401 }).message).toMatch(
      /sign in again/
    );
  });

  it('detects the quota 404 by body text', () => {
    const rewritten = rewriteSubscriptionError({
      message: 'Bad request: 404 {"error":{"type":"usage_limit_reached"}}',
      status: 404,
    });
    expect(rewritten.message).toMatch(/usage limit/);
  });

  it('strips the API Error prefix from sign-in errors and drops a NaN status', () => {
    const rewritten = rewriteSubscriptionError({
      message: 'API Error: Not signed in to ChatGPT — sign in from Settings',
      status: Number.NaN,
    });
    expect(rewritten.message).toBe('Not signed in to ChatGPT — sign in from Settings');
    expect(rewritten.status).toBeUndefined();
  });

  it('leaves unrelated errors alone', () => {
    expect(rewriteSubscriptionError({ message: 'API Error: boom', status: 500 })).toEqual({
      message: 'API Error: boom',
      status: 500,
    });
  });
});
