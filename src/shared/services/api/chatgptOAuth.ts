/**
 * Codex-login OAuth for the `chatgpt-subscription` provider.
 *
 * The ChatGPT backend accepts the same tokens the Codex CLI mints, so this
 * module speaks the CLI's public OAuth client: PKCE authorize + manual
 * redirect-URL paste, the device-code flow, and refresh. Everything is
 * fetch-injected and free of Node APIs so it runs in the Web Worker and the
 * Node server alike; worker-mode callers route through the CORS proxy via
 * `createOAuthFetch`.
 *
 * Token ownership: the stored `APIDefinition.oauth` block is written only by
 * the sign-in RPCs and `ensureFreshTokens`. Refresh tokens rotate on every
 * refresh, and the server rejects a reused one permanently, so the refresher
 * always re-reads the row before deciding and serializes concurrent refreshes
 * per definition.
 */

import type { APIDefinition, ChatgptOAuthTokens } from '../../protocol/types';
import { buildProxiedRequest } from './proxyConfig';

export const CHATGPT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_AUTH_ISSUER = 'https://auth.openai.com';
export const CHATGPT_DEVICE_VERIFY_URL = `${CHATGPT_AUTH_ISSUER}/codex/device`;
export const CHATGPT_PKCE_REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

const AUTHORIZE_URL = `${CHATGPT_AUTH_ISSUER}/oauth/authorize`;
const TOKEN_URL = `${CHATGPT_AUTH_ISSUER}/oauth/token`;
const DEVICE_USERCODE_URL = `${CHATGPT_AUTH_ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${CHATGPT_AUTH_ISSUER}/api/accounts/deviceauth/token`;
const DEVICE_REDIRECT_URI = `${CHATGPT_AUTH_ISSUER}/deviceauth/callback`;
const OAUTH_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
const ORIGINATOR = 'codex_cli_rs';
const AUTH_CLAIM_KEY = 'https://api.openai.com/auth';
const PROFILE_CLAIM_KEY = 'https://api.openai.com/profile';

/** Refresh this far ahead of `expiresAt` so an in-flight request never expires mid-stream. */
export const REFRESH_LEEWAY_MS = 5 * 60 * 1000;
/** Device-code polling gives up after this long, matching the Codex CLI. */
export const DEVICE_FLOW_TIMEOUT_MS = 15 * 60 * 1000;

export type OAuthFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class ChatgptOAuthError extends Error {
  readonly status?: number;
  /** True when the stored tokens are dead and only a fresh sign-in can recover. */
  readonly permanent: boolean;

  constructor(message: string, options: { status?: number; permanent?: boolean } = {}) {
    super(message);
    this.name = 'ChatgptOAuthError';
    this.status = options.status;
    this.permanent = options.permanent ?? false;
  }
}

/**
 * A `fetch` that honors the definition's CORS proxy. Server mode has no proxy
 * configured and hits the hosts directly.
 */
export function createOAuthFetch(
  apiDefinition: Pick<APIDefinition, 'apiType' | 'proxyUrl' | 'proxyAuthToken'>,
  baseFetch: typeof fetch = globalThis.fetch
): OAuthFetch {
  return (url, init) => {
    const proxied = buildProxiedRequest(apiDefinition, url);
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(proxied.headers)) headers.set(name, value);
    return baseFetch(proxied.url, { ...init, headers });
  };
}

// ============================================================================
// PKCE + authorize URL (manual-paste flow)
// ============================================================================

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function createPkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = randomBase64Url(64);
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(codeVerifier)
  );
  return { codeVerifier, codeChallenge: base64Url(new Uint8Array(digest)) };
}

export function createOAuthState(): string {
  return randomBase64Url(32);
}

export function buildAuthorizeUrl(params: { codeChallenge: string; state: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CHATGPT_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', CHATGPT_PKCE_REDIRECT_URI);
  url.searchParams.set('scope', OAUTH_SCOPE);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('state', params.state);
  url.searchParams.set('originator', ORIGINATOR);
  return url.toString();
}

/**
 * Pull `code` + `state` out of whatever the user pasted: the full
 * `http://localhost:1455/auth/callback?code=…&state=…` URL, or just its query
 * string with or without the leading `?`.
 */
export function parseRedirectUrl(pasted: string): { code: string; state: string } | null {
  const trimmed = pasted.trim();
  if (!trimmed) return null;
  let params: URLSearchParams;
  try {
    params = new URL(trimmed).searchParams;
  } catch {
    params = new URLSearchParams(trimmed.replace(/^\?/, ''));
  }
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return null;
  return { code, state };
}

// ============================================================================
// Device-code flow
// ============================================================================

export interface DeviceAuthStart {
  deviceAuthId: string;
  userCode: string;
  /** Seconds between polls, as suggested by the server. */
  interval: number;
  verificationUrl: string;
}

export type DeviceAuthPoll =
  | { status: 'pending' }
  | { status: 'ready'; authorizationCode: string; codeVerifier: string };

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export async function startDeviceAuth(fetchImpl: OAuthFetch): Promise<DeviceAuthStart> {
  const response = await fetchImpl(DEVICE_USERCODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CHATGPT_OAUTH_CLIENT_ID }),
  });
  if (!response.ok) {
    throw new ChatgptOAuthError(
      `Device sign-in could not start (${response.status}): ${await readBodyText(response)}`,
      { status: response.status }
    );
  }
  const json = (await response.json()) as {
    device_auth_id?: string;
    user_code?: string;
    usercode?: string;
    interval?: number | string;
  };
  const userCode = json.user_code ?? json.usercode;
  if (!json.device_auth_id || !userCode) {
    throw new ChatgptOAuthError('Device sign-in response is missing the device code');
  }
  const interval = Number(json.interval);
  return {
    deviceAuthId: json.device_auth_id,
    userCode,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 5,
    verificationUrl: CHATGPT_DEVICE_VERIFY_URL,
  };
}

export async function pollDeviceAuth(
  fetchImpl: OAuthFetch,
  params: { deviceAuthId: string; userCode: string }
): Promise<DeviceAuthPoll> {
  const response = await fetchImpl(DEVICE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_auth_id: params.deviceAuthId, user_code: params.userCode }),
  });
  // The server answers 403/404 until the user has entered the code.
  if (response.status === 403 || response.status === 404) return { status: 'pending' };
  if (!response.ok) {
    throw new ChatgptOAuthError(
      `Device sign-in failed (${response.status}): ${await readBodyText(response)}`,
      { status: response.status }
    );
  }
  const json = (await response.json()) as { authorization_code?: string; code_verifier?: string };
  if (!json.authorization_code || !json.code_verifier) {
    throw new ChatgptOAuthError('Device sign-in response is missing the authorization code');
  }
  return {
    status: 'ready',
    authorizationCode: json.authorization_code,
    codeVerifier: json.code_verifier,
  };
}

// ============================================================================
// Token exchange / refresh
// ============================================================================

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const segments = jwt.split('.');
  if (segments.length < 2) return null;
  try {
    const base64 = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface AccountClaims {
  accountId: string;
  planType?: string;
  email?: string;
}

/**
 * The account id lives under the `https://api.openai.com/auth` claim of the
 * access token (the id token carries the same block). Email is a top-level
 * claim on the id token, or under the profile claim.
 */
export function decodeAccountClaims(accessToken: string, idToken?: string): AccountClaims | null {
  const payloads = [decodeJwtPayload(accessToken), idToken ? decodeJwtPayload(idToken) : null];
  let accountId: string | undefined;
  let planType: string | undefined;
  let email: string | undefined;
  for (const payload of payloads) {
    if (!payload) continue;
    const auth = payload[AUTH_CLAIM_KEY];
    if (auth && typeof auth === 'object') {
      const claims = auth as Record<string, unknown>;
      if (!accountId && typeof claims.chatgpt_account_id === 'string') {
        accountId = claims.chatgpt_account_id;
      }
      if (!planType && typeof claims.chatgpt_plan_type === 'string') {
        planType = claims.chatgpt_plan_type;
      }
    }
    if (!email && typeof payload.email === 'string') email = payload.email;
    const profile = payload[PROFILE_CLAIM_KEY];
    if (!email && profile && typeof profile === 'object') {
      const profileEmail = (profile as Record<string, unknown>).email;
      if (typeof profileEmail === 'string') email = profileEmail;
    }
  }
  if (!accountId) return null;
  return { accountId, planType, email };
}

export function tokensFromResponse(json: TokenResponse, now = Date.now()): ChatgptOAuthTokens {
  if (!json.access_token || !json.refresh_token) {
    throw new ChatgptOAuthError('Token response is missing access or refresh token');
  }
  const claims = decodeAccountClaims(json.access_token, json.id_token);
  if (!claims) {
    throw new ChatgptOAuthError('Token does not carry a ChatGPT account id');
  }
  const expiresIn = Number(json.expires_in);
  // Codex tokens last about an hour; a missing field falls back to that.
  const lifetimeMs = (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    idToken: json.id_token,
    expiresAt: now + lifetimeMs,
    accountId: claims.accountId,
    planType: claims.planType,
    email: claims.email,
  };
}

export async function exchangeCode(
  fetchImpl: OAuthFetch,
  params: { code: string; codeVerifier: string; redirectUri: string }
): Promise<ChatgptOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: CHATGPT_OAUTH_CLIENT_ID,
    code_verifier: params.codeVerifier,
  });
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new ChatgptOAuthError(
      `Token exchange failed (${response.status}): ${await readBodyText(response)}`,
      { status: response.status }
    );
  }
  return tokensFromResponse((await response.json()) as TokenResponse);
}

/** Exchange the device flow's authorization code (the server supplied the verifier). */
export function exchangeDeviceCode(
  fetchImpl: OAuthFetch,
  params: { authorizationCode: string; codeVerifier: string }
): Promise<ChatgptOAuthTokens> {
  return exchangeCode(fetchImpl, {
    code: params.authorizationCode,
    codeVerifier: params.codeVerifier,
    redirectUri: DEVICE_REDIRECT_URI,
  });
}

/** Exchange a code from the manual-paste PKCE flow. */
export function exchangePkceCode(
  fetchImpl: OAuthFetch,
  params: { code: string; codeVerifier: string }
): Promise<ChatgptOAuthTokens> {
  return exchangeCode(fetchImpl, {
    code: params.code,
    codeVerifier: params.codeVerifier,
    redirectUri: CHATGPT_PKCE_REDIRECT_URI,
  });
}

const PERMANENT_REFRESH_ERRORS = [
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
  'invalid_grant',
];

export function isPermanentRefreshFailure(status: number, bodyText: string): boolean {
  if (status === 401) return true;
  if (status === 400) return PERMANENT_REFRESH_ERRORS.some(code => bodyText.includes(code));
  return false;
}

export async function refreshTokens(
  fetchImpl: OAuthFetch,
  refreshToken: string
): Promise<ChatgptOAuthTokens> {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CHATGPT_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    const bodyText = await readBodyText(response);
    const permanent = isPermanentRefreshFailure(response.status, bodyText);
    throw new ChatgptOAuthError(
      permanent
        ? `ChatGPT sign-in expired — sign in again in Settings (${response.status}: ${bodyText})`
        : `ChatGPT token refresh failed (${response.status}): ${bodyText}`,
      { status: response.status, permanent }
    );
  }
  const json = (await response.json()) as TokenResponse;
  // Some refresh responses omit the rotated refresh token; the old one stays valid then.
  return tokensFromResponse({ ...json, refresh_token: json.refresh_token ?? refreshToken });
}

// ============================================================================
// Refresh-on-demand with per-definition serialization
// ============================================================================

export interface OAuthTokenStorage {
  getAPIDefinition(id: string): Promise<APIDefinition | null>;
  saveAPIDefinition(definition: APIDefinition): Promise<void>;
}

const inFlightRefreshes = new Map<string, Promise<ChatgptOAuthTokens>>();

export function tokensNeedRefresh(tokens: ChatgptOAuthTokens, now = Date.now()): boolean {
  return tokens.expiresAt - now <= REFRESH_LEEWAY_MS;
}

/**
 * Return tokens that are good for at least `REFRESH_LEEWAY_MS`, refreshing
 * and persisting when needed. Always re-reads the stored row: the definition a
 * caller holds is a loop-time snapshot, and a sibling loop (a minion) may have
 * rotated the refresh token since. Concurrent callers for the same definition
 * share one refresh so the rotated token is never used twice.
 */
export async function ensureFreshTokens(
  apiDefId: string,
  storage: OAuthTokenStorage,
  baseFetch: typeof fetch = globalThis.fetch,
  now: () => number = Date.now
): Promise<ChatgptOAuthTokens> {
  const inFlight = inFlightRefreshes.get(apiDefId);
  if (inFlight) return inFlight;

  // The lock must be taken before the first `await`, or two callers arriving
  // in the same tick both pass the check above and refresh twice — the
  // second refresh then presents an already-rotated token.
  const task = (async () => {
    const stored = await storage.getAPIDefinition(apiDefId);
    if (!stored) throw new ChatgptOAuthError(`API definition ${apiDefId} not found`);
    const current = stored.oauth;
    if (!current?.accessToken || !current.refreshToken) {
      throw new ChatgptOAuthError('Not signed in to ChatGPT — sign in from Settings', {
        permanent: true,
      });
    }
    if (!tokensNeedRefresh(current, now())) return current;

    const fetchImpl = createOAuthFetch(stored, baseFetch);
    try {
      const next = await refreshTokens(fetchImpl, current.refreshToken);
      await storage.saveAPIDefinition({ ...stored, oauth: next, updatedAt: new Date(now()) });
      console.debug('[chatgptOAuth] refreshed tokens for', apiDefId);
      return next;
    } catch (error) {
      if (error instanceof ChatgptOAuthError && error.permanent) {
        await storage.saveAPIDefinition({
          ...stored,
          oauth: undefined,
          updatedAt: new Date(now()),
        });
        console.debug('[chatgptOAuth] cleared dead tokens for', apiDefId);
      }
      throw error;
    }
  })();

  inFlightRefreshes.set(apiDefId, task);
  try {
    return await task;
  } finally {
    inFlightRefreshes.delete(apiDefId);
  }
}

/**
 * Human-readable failure for the sign-in RPCs. A `TypeError` from `fetch` is
 * the browser's shape for a blocked cross-origin request, which in worker
 * mode means the CORS proxy is missing or misconfigured.
 */
export function describeOAuthFailure(
  error: unknown,
  apiDefinition: Pick<APIDefinition, 'proxyUrl'>
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TypeError) {
    return apiDefinition.proxyUrl
      ? `${message} — the CORS proxy at ${apiDefinition.proxyUrl} did not answer; check that its ALLOWED_TARGETS includes chatgpt.com and auth.openai.com`
      : `${message} — the browser cannot reach auth.openai.com directly; configure a CORS proxy on this API definition (server mode does not need one)`;
  }
  return message;
}
