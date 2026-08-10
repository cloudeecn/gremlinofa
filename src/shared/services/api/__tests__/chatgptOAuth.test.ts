import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIDefinition, ChatgptOAuthTokens } from '../../../protocol/types';
import {
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_PKCE_REDIRECT_URI,
  ChatgptOAuthError,
  REFRESH_LEEWAY_MS,
  buildAuthorizeUrl,
  createOAuthFetch,
  createPkcePair,
  decodeAccountClaims,
  describeOAuthFailure,
  ensureFreshTokens,
  exchangePkceCode,
  isPermanentRefreshFailure,
  parseRedirectUrl,
  pollDeviceAuth,
  refreshTokens,
  startDeviceAuth,
  tokensFromResponse,
  tokensNeedRefresh,
} from '../chatgptOAuth';

function base64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function makeJwt(payload: Record<string, unknown>): string {
  return `${base64Url('{"alg":"none"}')}.${base64Url(JSON.stringify(payload))}.sig`;
}

const ACCESS_JWT = makeJwt({
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123', chatgpt_plan_type: 'plus' },
});
const ID_JWT = makeJwt({ email: 'someone@example.com' });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeDef(overrides: Partial<APIDefinition> = {}): APIDefinition {
  return {
    id: 'def_chatgpt',
    apiType: 'chatgpt-subscription',
    name: 'ChatGPT',
    baseUrl: '',
    apiKey: '',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function makeTokens(overrides: Partial<ChatgptOAuthTokens> = {}): ChatgptOAuthTokens {
  return {
    accessToken: ACCESS_JWT,
    refreshToken: 'refresh_1',
    expiresAt: Date.now() + 60 * 60 * 1000,
    accountId: 'acct_123',
    ...overrides,
  };
}

describe('PKCE + authorize URL', () => {
  it('creates a verifier and an S256 challenge', async () => {
    const pair = await createPkcePair();
    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.codeChallenge).not.toBe(pair.codeVerifier);
  });

  it('builds the Codex authorize URL with every required parameter', () => {
    const url = new URL(buildAuthorizeUrl({ codeChallenge: 'chal', state: 'st' }));
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CHATGPT_OAUTH_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(CHATGPT_PKCE_REDIRECT_URI);
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
    expect(url.searchParams.get('id_token_add_organizations')).toBe('true');
    expect(url.searchParams.get('originator')).toBe('codex_cli_rs');
    expect(url.searchParams.get('scope')).toContain('offline_access');
  });

  it('parses a full redirect URL, a bare query, and rejects junk', () => {
    expect(parseRedirectUrl('http://localhost:1455/auth/callback?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
    });
    expect(parseRedirectUrl('?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
    expect(parseRedirectUrl('code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
    expect(parseRedirectUrl('http://localhost:1455/auth/callback?code=abc')).toBeNull();
    expect(parseRedirectUrl('   ')).toBeNull();
  });
});

describe('JWT claims + token parsing', () => {
  it('reads account id and plan from the access token and email from the id token', () => {
    expect(decodeAccountClaims(ACCESS_JWT, ID_JWT)).toEqual({
      accountId: 'acct_123',
      planType: 'plus',
      email: 'someone@example.com',
    });
  });

  it('returns null when no account id claim is present', () => {
    expect(decodeAccountClaims(makeJwt({ sub: 'x' }))).toBeNull();
    expect(decodeAccountClaims('not-a-jwt')).toBeNull();
  });

  it('tokensFromResponse computes expiry from expires_in', () => {
    const tokens = tokensFromResponse(
      { access_token: ACCESS_JWT, refresh_token: 'r', id_token: ID_JWT, expires_in: 120 },
      1000
    );
    expect(tokens.expiresAt).toBe(121000);
    expect(tokens.accountId).toBe('acct_123');
    expect(tokens.email).toBe('someone@example.com');
  });

  it('tokensFromResponse rejects a response without tokens', () => {
    expect(() => tokensFromResponse({ access_token: ACCESS_JWT })).toThrow(ChatgptOAuthError);
  });

  it('tokensNeedRefresh honors the leeway', () => {
    const now = 1_000_000;
    expect(tokensNeedRefresh(makeTokens({ expiresAt: now + REFRESH_LEEWAY_MS + 1 }), now)).toBe(
      false
    );
    expect(tokensNeedRefresh(makeTokens({ expiresAt: now + REFRESH_LEEWAY_MS }), now)).toBe(true);
  });
});

describe('device-code flow', () => {
  it('startDeviceAuth posts the client id and normalizes the response', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ device_auth_id: 'dev_1', usercode: 'ABCD-EFGH', interval: '7' })
    );
    const started = await startDeviceAuth(fetchImpl);
    expect(started).toEqual({
      deviceAuthId: 'dev_1',
      userCode: 'ABCD-EFGH',
      interval: 7,
      verificationUrl: 'https://auth.openai.com/codex/device',
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode');
    expect(JSON.parse(init.body as string)).toEqual({ client_id: CHATGPT_OAUTH_CLIENT_ID });
  });

  it('pollDeviceAuth treats 403/404 as pending and 200 as ready', async () => {
    const pending = vi.fn(async () => new Response('', { status: 404 }));
    expect(await pollDeviceAuth(pending, { deviceAuthId: 'd', userCode: 'u' })).toEqual({
      status: 'pending',
    });
    const ready = vi.fn(async () =>
      jsonResponse({ authorization_code: 'code_1', code_verifier: 'ver_1' })
    );
    expect(await pollDeviceAuth(ready, { deviceAuthId: 'd', userCode: 'u' })).toEqual({
      status: 'ready',
      authorizationCode: 'code_1',
      codeVerifier: 'ver_1',
    });
  });

  it('pollDeviceAuth surfaces other failures', async () => {
    const failing = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(pollDeviceAuth(failing, { deviceAuthId: 'd', userCode: 'u' })).rejects.toThrow(
      /500/
    );
  });
});

describe('token exchange + refresh', () => {
  it('exchangePkceCode sends a form-encoded authorization_code grant', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: ACCESS_JWT, refresh_token: 'r1', expires_in: 3600 })
    );
    const tokens = await exchangePkceCode(fetchImpl, { code: 'c', codeVerifier: 'v' });
    expect(tokens.refreshToken).toBe('r1');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://auth.openai.com/oauth/token');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('c');
    expect(body.get('code_verifier')).toBe('v');
    expect(body.get('redirect_uri')).toBe(CHATGPT_PKCE_REDIRECT_URI);
    expect(body.get('client_id')).toBe(CHATGPT_OAUTH_CLIENT_ID);
  });

  it('refreshTokens sends a JSON refresh_token grant and keeps the old refresh token if none is returned', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: ACCESS_JWT, expires_in: 3600 })
    );
    const tokens = await refreshTokens(fetchImpl, 'old_refresh');
    expect(tokens.refreshToken).toBe('old_refresh');
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: CHATGPT_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: 'old_refresh',
    });
  });

  it('classifies permanent vs transient refresh failures', () => {
    expect(isPermanentRefreshFailure(401, '')).toBe(true);
    expect(isPermanentRefreshFailure(400, '{"error":"refresh_token_reused"}')).toBe(true);
    expect(isPermanentRefreshFailure(400, '{"error":"invalid_grant"}')).toBe(true);
    expect(isPermanentRefreshFailure(400, '{"error":"something_else"}')).toBe(false);
    expect(isPermanentRefreshFailure(503, '')).toBe(false);
  });

  it('refreshTokens marks a reused refresh token as permanent', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":"refresh_token_reused"}', { status: 400 })
    );
    await expect(refreshTokens(fetchImpl, 'r')).rejects.toMatchObject({ permanent: true });
  });
});

describe('createOAuthFetch', () => {
  it('routes through the CORS proxy with the target origin when configured', async () => {
    const baseFetch = vi.fn(async () => new Response('ok'));
    const fetchImpl = createOAuthFetch(
      makeDef({ proxyUrl: 'https://proxy.example/cors/', proxyAuthToken: 'secret' }),
      baseFetch as unknown as typeof fetch
    );
    await fetchImpl('https://auth.openai.com/oauth/token?x=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const [url, init] = baseFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://proxy.example/cors/oauth/token?x=1');
    const headers = new Headers(init.headers);
    expect(headers.get('X-Proxy-Target')).toBe('https://auth.openai.com');
    expect(headers.get('X-Proxy-Auth')).toBe('secret');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('hits the host directly without a proxy', async () => {
    const baseFetch = vi.fn(async () => new Response('ok'));
    const fetchImpl = createOAuthFetch(makeDef(), baseFetch as unknown as typeof fetch);
    await fetchImpl('https://auth.openai.com/oauth/token');
    const [url] = baseFetch.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://auth.openai.com/oauth/token');
  });
});

describe('ensureFreshTokens', () => {
  let rows: Map<string, APIDefinition>;
  const storage = {
    getAPIDefinition: vi.fn(async (id: string) => rows.get(id) ?? null),
    saveAPIDefinition: vi.fn(async (def: APIDefinition) => {
      rows.set(def.id, def);
    }),
  };

  beforeEach(() => {
    rows = new Map();
    storage.getAPIDefinition.mockClear();
    storage.saveAPIDefinition.mockClear();
  });

  it('returns stored tokens untouched when they are still fresh', async () => {
    const tokens = makeTokens();
    rows.set('a', makeDef({ id: 'a', oauth: tokens }));
    const baseFetch = vi.fn();
    const fresh = await ensureFreshTokens('a', storage, baseFetch as unknown as typeof fetch);
    expect(fresh).toEqual(tokens);
    expect(baseFetch).not.toHaveBeenCalled();
    expect(storage.saveAPIDefinition).not.toHaveBeenCalled();
  });

  it('throws a permanent error when not signed in', async () => {
    rows.set('b', makeDef({ id: 'b' }));
    await expect(ensureFreshTokens('b', storage)).rejects.toMatchObject({ permanent: true });
  });

  it('refreshes once for concurrent callers and persists the rotated pair', async () => {
    rows.set('c', makeDef({ id: 'c', oauth: makeTokens({ expiresAt: Date.now() }) }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const baseFetch = vi.fn(async () => {
      await gate;
      return jsonResponse({ access_token: ACCESS_JWT, refresh_token: 'rotated', expires_in: 3600 });
    });

    const first = ensureFreshTokens('c', storage, baseFetch as unknown as typeof fetch);
    const second = ensureFreshTokens('c', storage, baseFetch as unknown as typeof fetch);
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.refreshToken).toBe('rotated');
    expect(b).toBe(a);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(storage.saveAPIDefinition).toHaveBeenCalledTimes(1);
    expect(rows.get('c')?.oauth?.refreshToken).toBe('rotated');
  });

  it('reads the stored row rather than trusting a caller-held snapshot', async () => {
    // The row already carries rotated, fresh tokens (another loop refreshed);
    // a caller whose own copy is stale must not trigger a second refresh.
    rows.set('d', makeDef({ id: 'd', oauth: makeTokens({ refreshToken: 'already_rotated' }) }));
    const baseFetch = vi.fn();
    const tokens = await ensureFreshTokens('d', storage, baseFetch as unknown as typeof fetch);
    expect(tokens.refreshToken).toBe('already_rotated');
    expect(baseFetch).not.toHaveBeenCalled();
    expect(storage.getAPIDefinition).toHaveBeenCalledWith('d');
  });

  it('clears the stored tokens on a permanent refresh failure', async () => {
    rows.set('e', makeDef({ id: 'e', oauth: makeTokens({ expiresAt: Date.now() }) }));
    const baseFetch = vi.fn(
      async () => new Response('{"error":"refresh_token_expired"}', { status: 400 })
    );
    await expect(
      ensureFreshTokens('e', storage, baseFetch as unknown as typeof fetch)
    ).rejects.toMatchObject({ permanent: true });
    expect(rows.get('e')?.oauth).toBeUndefined();
  });

  it('keeps the stored tokens on a transient refresh failure', async () => {
    const stale = makeTokens({ expiresAt: Date.now() });
    rows.set('f', makeDef({ id: 'f', oauth: stale }));
    const baseFetch = vi.fn(async () => new Response('down', { status: 503 }));
    await expect(
      ensureFreshTokens('f', storage, baseFetch as unknown as typeof fetch)
    ).rejects.toMatchObject({ permanent: false });
    expect(rows.get('f')?.oauth).toEqual(stale);
  });
});

describe('describeOAuthFailure', () => {
  it('adds a CORS-proxy hint for a network-level TypeError', () => {
    expect(describeOAuthFailure(new TypeError('Failed to fetch'), makeDef())).toMatch(
      /configure a CORS proxy/
    );
    expect(
      describeOAuthFailure(new TypeError('Failed to fetch'), makeDef({ proxyUrl: '/p' }))
    ).toMatch(/ALLOWED_TARGETS/);
  });

  it('passes other errors through', () => {
    expect(describeOAuthFailure(new Error('boom'), makeDef())).toBe('boom');
  });
});
