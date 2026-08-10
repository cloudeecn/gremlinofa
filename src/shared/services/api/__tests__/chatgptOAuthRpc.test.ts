import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIDefinition } from '../../../protocol/types';
import {
  chatgptOAuthAuthorizeUrl,
  chatgptOAuthDevicePoll,
  chatgptOAuthDeviceStart,
  chatgptOAuthExchange,
  chatgptOAuthSignOut,
} from '../chatgptOAuthRpc';
import { CHATGPT_OAUTH_CLIENT_ID } from '../chatgptOAuth';

function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
  return `${b64('{"alg":"none"}')}.${b64(JSON.stringify(payload))}.sig`;
}

const ACCESS_JWT = makeJwt({
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1', chatgpt_plan_type: 'pro' },
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('chatgptOAuth RPC handlers', () => {
  let rows: Map<string, APIDefinition>;
  const storage = {
    getAPIDefinition: vi.fn(async (id: string) => rows.get(id) ?? null),
    saveAPIDefinition: vi.fn(async (def: APIDefinition) => {
      rows.set(def.id, def);
    }),
  };

  beforeEach(() => {
    rows = new Map([
      [
        'sub',
        {
          id: 'sub',
          apiType: 'chatgpt-subscription',
          name: 'ChatGPT',
          baseUrl: '',
          apiKey: '',
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ],
      [
        'other',
        {
          id: 'other',
          apiType: 'responses_api',
          name: 'OpenAI',
          baseUrl: '',
          apiKey: 'sk',
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ],
    ]);
    storage.saveAPIDefinition.mockClear();
  });

  it('rejects definitions of any other apiType', async () => {
    await expect(chatgptOAuthAuthorizeUrl(storage, 'other')).rejects.toThrow(/not a ChatGPT/);
    await expect(chatgptOAuthAuthorizeUrl(storage, 'missing')).rejects.toThrow(/not found/);
  });

  it('device start returns the code and verification URL', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ device_auth_id: 'dev', user_code: 'CODE', interval: 5 })
    );
    const started = await chatgptOAuthDeviceStart(
      storage,
      'sub',
      fetchMock as unknown as typeof fetch
    );
    expect(started).toEqual({
      deviceAuthId: 'dev',
      userCode: 'CODE',
      interval: 5,
      verificationUrl: 'https://auth.openai.com/codex/device',
    });
  });

  it('device poll reports pending, then persists tokens on completion', async () => {
    const pending = vi.fn(async () => new Response('', { status: 403 }));
    expect(
      await chatgptOAuthDevicePoll(
        storage,
        { apiDefId: 'sub', deviceAuthId: 'dev', userCode: 'CODE' },
        pending as unknown as typeof fetch
      )
    ).toEqual({ status: 'pending' });

    const ready = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ authorization_code: 'code', code_verifier: 'ver' }))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: ACCESS_JWT, refresh_token: 'r', expires_in: 3600 })
      );
    const outcome = await chatgptOAuthDevicePoll(
      storage,
      { apiDefId: 'sub', deviceAuthId: 'dev', userCode: 'CODE' },
      ready as unknown as typeof fetch
    );
    expect(outcome).toEqual({ status: 'complete', accountId: 'acct_1', planType: 'pro' });
    expect(rows.get('sub')?.oauth).toMatchObject({ accountId: 'acct_1', refreshToken: 'r' });
  });

  it('device poll turns fetch failures into an error outcome with a proxy hint', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const outcome = await chatgptOAuthDevicePoll(
      storage,
      { apiDefId: 'sub', deviceAuthId: 'dev', userCode: 'CODE' },
      failing as unknown as typeof fetch
    );
    expect(outcome).toMatchObject({ status: 'error' });
    expect((outcome as { message: string }).message).toMatch(/CORS proxy/);
  });

  it('authorize URL carries the verifier + state back for the paste step', async () => {
    const authorize = await chatgptOAuthAuthorizeUrl(storage, 'sub');
    const url = new URL(authorize.url);
    expect(url.searchParams.get('client_id')).toBe(CHATGPT_OAUTH_CLIENT_ID);
    expect(url.searchParams.get('state')).toBe(authorize.state);
    expect(authorize.codeVerifier.length).toBeGreaterThan(40);
  });

  it('exchange validates the pasted URL and state before hitting the token endpoint', async () => {
    const fetchMock = vi.fn();
    expect(
      await chatgptOAuthExchange(
        storage,
        { apiDefId: 'sub', redirectUrl: 'garbage', codeVerifier: 'v', state: 's' },
        fetchMock as unknown as typeof fetch
      )
    ).toMatchObject({ status: 'error', message: expect.stringMatching(/redirect URL/) });
    expect(
      await chatgptOAuthExchange(
        storage,
        {
          apiDefId: 'sub',
          redirectUrl: 'http://localhost:1455/auth/callback?code=c&state=wrong',
          codeVerifier: 'v',
          state: 's',
        },
        fetchMock as unknown as typeof fetch
      )
    ).toMatchObject({ status: 'error', message: expect.stringMatching(/state mismatch/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exchange persists tokens on success', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: ACCESS_JWT, refresh_token: 'r2', expires_in: 3600 })
    );
    const outcome = await chatgptOAuthExchange(
      storage,
      {
        apiDefId: 'sub',
        redirectUrl: 'http://localhost:1455/auth/callback?code=c&state=s',
        codeVerifier: 'v',
        state: 's',
      },
      fetchMock as unknown as typeof fetch
    );
    expect(outcome).toMatchObject({ status: 'complete', accountId: 'acct_1' });
    expect(rows.get('sub')?.oauth?.refreshToken).toBe('r2');
  });

  it('sign out drops the tokens and keeps the definition', async () => {
    rows.set('sub', {
      ...rows.get('sub')!,
      oauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1, accountId: 'x' },
    });
    await chatgptOAuthSignOut(storage, 'sub');
    expect(rows.get('sub')?.oauth).toBeUndefined();
    expect(rows.get('sub')?.name).toBe('ChatGPT');
  });
});
