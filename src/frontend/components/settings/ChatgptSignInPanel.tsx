import { useCallback, useEffect, useRef, useState } from 'react';
import Spinner from '../ui/Spinner';
import { gremlinClient } from '../../client';
import type { APIDefinition } from '../../../shared/protocol/types';
import type { ChatgptOAuthOutcome } from '../../../shared/protocol/methods';
import { isChatgptSignedIn } from '../../../shared/protocol/apiDefinition';

/** Matches the Codex CLI's give-up window for the device flow. */
const DEVICE_FLOW_TIMEOUT_MS = 15 * 60 * 1000;

interface DeviceState {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  startedAt: number;
}

interface PasteState {
  url: string;
  codeVerifier: string;
  state: string;
  pasted: string;
}

interface ChatgptSignInPanelProps {
  apiDef: APIDefinition;
  /** Called after tokens change (sign-in completed or signed out). */
  onChanged: () => Promise<void>;
}

/**
 * Sign-in controls for a `chatgpt-subscription` definition. The backend owns
 * the tokens; this panel only drives the two flows (device code, manual
 * redirect-URL paste) and shows who is signed in.
 */
export default function ChatgptSignInPanel({ apiDef, onChanged }: ChatgptSignInPanelProps) {
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [paste, setPaste] = useState<PasteState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

  const stopPolling = useCallback(() => {
    cancelled.current = true;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const finish = useCallback(
    async (outcome: ChatgptOAuthOutcome) => {
      if (outcome.status === 'error') {
        setError(outcome.message);
        return false;
      }
      if (outcome.status === 'complete') {
        setDevice(null);
        setPaste(null);
        setError(null);
        await onChanged();
        return true;
      }
      return false;
    },
    [onChanged]
  );

  const startDevice = async () => {
    setError(null);
    setPaste(null);
    setBusy(true);
    try {
      const started = await gremlinClient.chatgptOAuthDeviceStart(apiDef.id);
      const state: DeviceState = { ...started, startedAt: Date.now() };
      setDevice(state);
      cancelled.current = false;
      const poll = async () => {
        if (cancelled.current) return;
        if (Date.now() - state.startedAt > DEVICE_FLOW_TIMEOUT_MS) {
          setDevice(null);
          setError('Sign-in timed out after 15 minutes. Start again when you are ready.');
          return;
        }
        try {
          const outcome = await gremlinClient.chatgptOAuthDevicePoll(
            apiDef.id,
            state.deviceAuthId,
            state.userCode
          );
          if (cancelled.current) return;
          if (outcome.status === 'pending') {
            pollTimer.current = setTimeout(poll, state.interval * 1000);
            return;
          }
          if (!(await finish(outcome))) setDevice(null);
        } catch (pollError) {
          if (cancelled.current) return;
          setDevice(null);
          setError(pollError instanceof Error ? pollError.message : String(pollError));
        }
      };
      pollTimer.current = setTimeout(poll, state.interval * 1000);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setBusy(false);
    }
  };

  const startPaste = async () => {
    setError(null);
    stopPolling();
    setDevice(null);
    setBusy(true);
    try {
      const authorize = await gremlinClient.chatgptOAuthAuthorizeUrl(apiDef.id);
      setPaste({ ...authorize, pasted: '' });
    } catch (urlError) {
      setError(urlError instanceof Error ? urlError.message : String(urlError));
    } finally {
      setBusy(false);
    }
  };

  const completePaste = async () => {
    if (!paste) return;
    setBusy(true);
    try {
      const outcome = await gremlinClient.chatgptOAuthExchange(
        apiDef.id,
        paste.pasted,
        paste.codeVerifier,
        paste.state
      );
      await finish(outcome);
    } catch (exchangeError) {
      setError(exchangeError instanceof Error ? exchangeError.message : String(exchangeError));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    stopPolling();
    setDevice(null);
    setPaste(null);
    setError(null);
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await gremlinClient.chatgptOAuthSignOut(apiDef.id);
      setError(null);
      await onChanged();
    } catch (signOutError) {
      setError(signOutError instanceof Error ? signOutError.message : String(signOutError));
    } finally {
      setBusy(false);
    }
  };

  const signedIn = isChatgptSignedIn(apiDef);
  const inputClass =
    'mb-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-500';
  const secondaryButton =
    'rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60';
  const primaryButton =
    'flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400';

  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="mb-1.5 text-sm font-medium text-gray-700">ChatGPT account</div>
      {signedIn ? (
        <p className="mb-3 text-xs text-gray-600">
          Signed in{apiDef.oauth?.email ? ` as ${apiDef.oauth.email}` : ''}
          {apiDef.oauth?.planType ? ` (${apiDef.oauth.planType} plan)` : ''}. Tokens refresh
          themselves; sign out to drop them.
        </p>
      ) : (
        <p className="mb-3 text-xs text-gray-600">
          Not signed in. Sign in with your ChatGPT account to bill this provider to your
          subscription. In worker mode this needs the CORS proxy below.
        </p>
      )}

      {device && (
        <div className="mb-3 rounded-lg border border-blue-200 bg-white p-3">
          <p className="mb-2 text-sm text-gray-700">
            Open{' '}
            <a
              href={device.verificationUrl}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 underline"
            >
              {device.verificationUrl}
            </a>{' '}
            and enter this code:
          </p>
          <div className="mb-2 rounded bg-gray-100 px-3 py-2 text-center font-mono text-xl tracking-widest text-gray-900 select-all">
            {device.userCode}
          </div>
          <p className="flex items-center gap-2 text-xs text-gray-500">
            <Spinner size={12} /> Waiting for you to approve the sign-in…
          </p>
        </div>
      )}

      {paste && (
        <div className="mb-3 rounded-lg border border-blue-200 bg-white p-3">
          <p className="mb-2 text-sm text-gray-700">
            1.{' '}
            <a
              href={paste.url}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 underline"
            >
              Open the sign-in page
            </a>{' '}
            and log in. The browser will end up on a{' '}
            <code className="rounded bg-gray-100 px-1">localhost:1455</code> page that fails to load
            — that is expected.
          </p>
          <p className="mb-2 text-sm text-gray-700">
            2. Copy that page's full URL and paste it here:
          </p>
          <textarea
            className={`${inputClass} font-mono text-xs`}
            rows={3}
            placeholder="http://localhost:1455/auth/callback?code=…&state=…"
            value={paste.pasted}
            onChange={e => setPaste({ ...paste, pasted: e.target.value })}
          />
        </div>
      )}

      {error && <p className="mb-3 text-xs text-red-600">{error}</p>}

      <div className="flex flex-wrap gap-2">
        {device || paste ? (
          <>
            {paste && (
              <button
                onClick={completePaste}
                disabled={busy || !paste.pasted.trim()}
                className={primaryButton}
              >
                {busy && <Spinner size={12} colorClass="border-white" />}
                Complete sign-in
              </button>
            )}
            <button onClick={cancel} disabled={busy} className={secondaryButton}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button onClick={startDevice} disabled={busy} className={primaryButton}>
              {busy && <Spinner size={12} colorClass="border-white" />}
              {signedIn ? 'Sign in again (device code)' : 'Sign in with device code'}
            </button>
            <button onClick={startPaste} disabled={busy} className={secondaryButton}>
              Sign in via browser (paste URL)
            </button>
            {signedIn && (
              <button
                onClick={signOut}
                disabled={busy}
                className="rounded-lg border border-red-600 px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Sign out
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
