/**
 * Backend handlers for the `chatgptOAuth*` RPCs. Stateless by design: the
 * device flow returns its own code verifier, and the PKCE flow hands the
 * verifier to the frontend to carry back with the pasted redirect URL. The
 * frontend owns the polling loop and the give-up timer.
 */

import type { APIDefinition } from '../../protocol/types';
import {
  CHATGPT_DEVICE_VERIFY_URL,
  ChatgptOAuthError,
  buildAuthorizeUrl,
  createOAuthFetch,
  createOAuthState,
  createPkcePair,
  describeOAuthFailure,
  exchangeDeviceCode,
  exchangePkceCode,
  parseRedirectUrl,
  pollDeviceAuth,
  startDeviceAuth,
  type OAuthTokenStorage,
} from './chatgptOAuth';

export type ChatgptOAuthOutcome =
  | { status: 'pending' }
  | { status: 'complete'; accountId: string; planType?: string; email?: string }
  | { status: 'error'; message: string };

async function loadDefinition(
  storage: OAuthTokenStorage,
  apiDefId: string
): Promise<APIDefinition> {
  const def = await storage.getAPIDefinition(apiDefId);
  if (!def) throw new ChatgptOAuthError(`API definition ${apiDefId} not found`);
  if (def.apiType !== 'chatgpt-subscription') {
    throw new ChatgptOAuthError(`${def.name} is not a ChatGPT subscription definition`);
  }
  return def;
}

export async function chatgptOAuthDeviceStart(
  storage: OAuthTokenStorage,
  apiDefId: string,
  baseFetch: typeof fetch = globalThis.fetch
): Promise<{ deviceAuthId: string; userCode: string; verificationUrl: string; interval: number }> {
  const def = await loadDefinition(storage, apiDefId);
  try {
    const started = await startDeviceAuth(createOAuthFetch(def, baseFetch));
    return { ...started, verificationUrl: CHATGPT_DEVICE_VERIFY_URL };
  } catch (error) {
    throw new ChatgptOAuthError(describeOAuthFailure(error, def));
  }
}

export async function chatgptOAuthDevicePoll(
  storage: OAuthTokenStorage,
  params: { apiDefId: string; deviceAuthId: string; userCode: string },
  baseFetch: typeof fetch = globalThis.fetch
): Promise<ChatgptOAuthOutcome> {
  const def = await loadDefinition(storage, params.apiDefId);
  const fetchImpl = createOAuthFetch(def, baseFetch);
  try {
    const polled = await pollDeviceAuth(fetchImpl, params);
    if (polled.status === 'pending') return { status: 'pending' };
    const tokens = await exchangeDeviceCode(fetchImpl, polled);
    await persistTokens(storage, params.apiDefId, tokens);
    return {
      status: 'complete',
      accountId: tokens.accountId,
      planType: tokens.planType,
      email: tokens.email,
    };
  } catch (error) {
    return { status: 'error', message: describeOAuthFailure(error, def) };
  }
}

export async function chatgptOAuthAuthorizeUrl(
  storage: OAuthTokenStorage,
  apiDefId: string
): Promise<{ url: string; codeVerifier: string; state: string }> {
  await loadDefinition(storage, apiDefId);
  const { codeVerifier, codeChallenge } = await createPkcePair();
  const state = createOAuthState();
  return { url: buildAuthorizeUrl({ codeChallenge, state }), codeVerifier, state };
}

export async function chatgptOAuthExchange(
  storage: OAuthTokenStorage,
  params: { apiDefId: string; redirectUrl: string; codeVerifier: string; state: string },
  baseFetch: typeof fetch = globalThis.fetch
): Promise<ChatgptOAuthOutcome> {
  const def = await loadDefinition(storage, params.apiDefId);
  const parsed = parseRedirectUrl(params.redirectUrl);
  if (!parsed) {
    return {
      status: 'error',
      message: 'That does not look like the redirect URL — it needs both code= and state=.',
    };
  }
  if (parsed.state !== params.state) {
    return {
      status: 'error',
      message:
        'The pasted URL belongs to a different sign-in attempt (state mismatch). Start over.',
    };
  }
  try {
    const tokens = await exchangePkceCode(createOAuthFetch(def, baseFetch), {
      code: parsed.code,
      codeVerifier: params.codeVerifier,
    });
    await persistTokens(storage, params.apiDefId, tokens);
    return {
      status: 'complete',
      accountId: tokens.accountId,
      planType: tokens.planType,
      email: tokens.email,
    };
  } catch (error) {
    return { status: 'error', message: describeOAuthFailure(error, def) };
  }
}

export async function chatgptOAuthSignOut(
  storage: OAuthTokenStorage,
  apiDefId: string
): Promise<{ ok: true }> {
  const def = await loadDefinition(storage, apiDefId);
  await storage.saveAPIDefinition({ ...def, oauth: undefined, updatedAt: new Date() });
  return { ok: true };
}

/** Re-read before writing so a concurrent field edit isn't clobbered. */
async function persistTokens(
  storage: OAuthTokenStorage,
  apiDefId: string,
  tokens: APIDefinition['oauth']
): Promise<void> {
  const latest = await loadDefinition(storage, apiDefId);
  await storage.saveAPIDefinition({ ...latest, oauth: tokens, updatedAt: new Date() });
}
