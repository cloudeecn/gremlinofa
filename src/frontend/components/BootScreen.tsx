import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { BootStep } from '../contexts/createAppContext';
import { useConnectionState } from '../hooks/useConnectionState';
import { getStorageConfig, type StorageConfig } from '../lib/localStorageBoot';
import type { ConnectionState } from '../../shared/protocol/transport';
import Spinner from './ui/Spinner';

/** Seconds on one step before the screen shows the elapsed time. */
const SHOW_ELAPSED_SECONDS = 3;
/** Seconds on one step before the screen offers a hint and a way out. */
const SLOW_STEP_SECONDS = 10;

const STEPS: BootStep[] = ['backend', 'unlock', 'data'];

type StepState = 'done' | 'active' | 'failed' | 'waiting';

interface BootScreenProps {
  step: BootStep;
  /** Set once boot failed; `step` is then the step that failed. */
  error: string | null;
  /** Leave the boot screen for the shell (server mode's Data Manager escape). */
  onDismiss: () => void;
}

/**
 * What the app is waiting on while it boots, and where it stopped if boot
 * failed. "App loaded" is always ticked: a phone user with no devtools can
 * tell a dead frontend (no screen at all, or the index.html splash) from a
 * backend that isn't answering (this screen).
 */
export function BootScreen({ step, error, onDismiss }: BootScreenProps) {
  const navigate = useNavigate();
  const config = getStorageConfig();
  const connectionState = useConnectionState();

  // Server mode's bootstrap moves straight to `unlock`: until the socket
  // has reached the server, the backend step is the one actually running.
  const activeStep: BootStep =
    config.type === 'server' && step === 'unlock' && !hasReachedServer(connectionState)
      ? 'backend'
      : step;

  const [elapsed, setElapsed] = useState({ step: activeStep, seconds: 0 });
  if (elapsed.step !== activeStep) {
    setElapsed({ step: activeStep, seconds: 0 });
  }
  const failed = error !== null;
  useEffect(() => {
    if (failed) return;
    const timer = setInterval(() => setElapsed(e => ({ ...e, seconds: e.seconds + 1 })), 1000);
    return () => clearInterval(timer);
  }, [failed]);

  const isSlow = !failed && elapsed.seconds >= SLOW_STEP_SECONDS;
  const activeIndex = STEPS.indexOf(activeStep);
  const stateOf = (s: BootStep): StepState => {
    const index = STEPS.indexOf(s);
    if (index < activeIndex) return 'done';
    if (index > activeIndex) return 'waiting';
    return failed ? 'failed' : 'active';
  };

  return (
    <div className="flex h-dvh items-center justify-center bg-gray-50 p-4">
      <div role={failed ? 'alert' : 'status'} className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mb-4 text-4xl">{failed ? '🙀' : '⏳'}</div>
          <h2 className="text-xl font-semibold text-gray-800">
            {failed ? "Couldn't start" : 'Starting Gremlin Of The Friday Afternoon'}
          </h2>
        </div>

        <ol className="mb-6 space-y-3">
          <StepRow state="done" label="App loaded" />
          {STEPS.map(s => {
            const state = stateOf(s);
            return (
              <StepRow
                key={s}
                state={state}
                label={stepLabel(s, config)}
                detail={
                  state === 'failed'
                    ? (error ?? undefined)
                    : state === 'active' && s === 'backend' && config.type === 'server'
                      ? connectionDetail(connectionState)
                      : undefined
                }
                seconds={
                  state === 'active' && elapsed.seconds >= SHOW_ELAPSED_SECONDS
                    ? elapsed.seconds
                    : undefined
                }
              />
            );
          })}
        </ol>

        {isSlow && <p className="mb-6 text-sm text-gray-600">{slowHint(activeStep, config)}</p>}

        {(failed || isSlow) && (
          <div className="flex flex-col items-center gap-3">
            <button
              onClick={() => window.location.reload()}
              className="rounded-lg bg-gray-900 px-6 py-3 text-white transition-colors hover:bg-gray-800"
            >
              Reload
            </button>
            {/* Escape hatch: server mode's Disconnect Backend only clears this
              device, so it works without a backend. Worker-side Detach calls
              clearCek, which needs the backend that isn't up, so no button. */}
            {config.type === 'server' && (
              <button
                onClick={() => {
                  onDismiss();
                  navigate('/data');
                }}
                className="text-sm text-gray-600 underline hover:text-gray-800"
              >
                Open Data Manager
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StepRow({
  state,
  label,
  detail,
  seconds,
}: {
  state: StepState;
  label: string;
  detail?: string;
  seconds?: number;
}) {
  return (
    <li className="flex items-start gap-3" data-state={state}>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center">
        {state === 'done' && <span className="text-green-600">✓</span>}
        {state === 'active' && <Spinner size={16} colorClass="border-gray-500" />}
        {state === 'failed' && <span className="text-red-600">✗</span>}
        {state === 'waiting' && <span className="text-gray-300">○</span>}
      </span>
      <div className="min-w-0 flex-1">
        <p className={state === 'waiting' ? 'text-gray-400' : 'text-gray-800'}>
          {label}
          {seconds !== undefined && <span className="text-gray-500"> · {seconds}s</span>}
        </p>
        {detail && (
          <p
            className={`text-sm break-words ${state === 'failed' ? 'text-red-700' : 'text-gray-600'}`}
          >
            {detail}
          </p>
        )}
      </div>
    </li>
  );
}

/** The socket got an answer from the server, even if it was a rejection. */
function hasReachedServer(state: ConnectionState): boolean {
  return state === 'connected' || state === 'stale' || state === 'auth_failed';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function stepLabel(step: BootStep, config: StorageConfig): string {
  switch (step) {
    case 'backend':
      return config.type === 'server'
        ? `Reach the server at ${hostOf(config.wsUrl)}`
        : 'Start the local backend (Web Worker)';
    case 'unlock':
      if (config.type === 'server') return 'Unlock storage on the server';
      if (config.type === 'remote') return `Open remote storage at ${hostOf(config.baseUrl)}`;
      return 'Open the browser database';
    case 'data':
      return 'Load projects';
  }
}

function connectionDetail(state: ConnectionState): string | undefined {
  switch (state) {
    case 'connecting':
      return 'Connecting…';
    case 'disconnected':
    case 'reconnecting':
      return "Can't reach the server yet, retrying…";
    case 'connected':
    case 'stale':
    case 'auth_failed':
      // The server answered: the step is done and the row shows no detail
      return undefined;
  }
}

function slowHint(step: BootStep, config: StorageConfig): string {
  switch (step) {
    case 'backend':
      return config.type === 'server'
        ? `Check that the server is running and that ${config.wsUrl} is reachable from this device. The app connects on its own once it answers.`
        : "The backend worker hasn't started. If a reload doesn't fix it, the cached app files may be out of date.";
    case 'unlock':
      if (config.type === 'server') {
        return 'The server is connected but still opening its storage.';
      }
      if (config.type === 'remote') {
        return `Remote storage at ${hostOf(config.baseUrl)} isn't answering.`;
      }
      return 'Another GremlinOFA tab may be holding the database. Close other tabs, then reload.';
    case 'data':
      return 'Storage is open, but the first read is slow to come back.';
  }
}
