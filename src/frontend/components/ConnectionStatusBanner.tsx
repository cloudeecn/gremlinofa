import { useState, useEffect, useRef, useCallback } from 'react';
import { useConnectionState } from '../hooks/useConnectionState';
import type { ConnectionState } from '../../shared/protocol/transport';

/** Delay before showing the disconnected/reconnecting banner — avoids flicker on quick reconnects. */
const SHOW_DELAY_MS = 500;
/** How long the "Reconnected" flash stays visible. */
const RECONNECTED_FLASH_MS = 1_500;

/** States that mean "something is wrong with the connection". */
const BAD_STATES = new Set<ConnectionState>(['stale', 'disconnected', 'reconnecting']);

type BannerMode =
  | 'hidden'
  | 'stale'
  | 'disconnected'
  | 'reconnecting'
  | 'reconnected'
  | 'auth_failed';

const BANNERS: Record<
  Exclude<BannerMode, 'hidden'>,
  { tone: string; dot?: string; text: string }
> = {
  auth_failed: {
    tone: 'border-red-300 bg-red-50 text-red-800',
    dot: 'bg-red-500',
    text: 'The server rejected the stored encryption key — reload the page to re-authenticate.',
  },
  reconnected: { tone: 'border-green-300 bg-green-50 text-green-800', text: 'Reconnected' },
  stale: {
    tone: 'border-amber-300 bg-amber-50 text-amber-800',
    dot: 'animate-pulse bg-amber-500',
    text: 'Checking connection...',
  },
  disconnected: {
    tone: 'border-red-300 bg-red-50 text-red-800',
    dot: 'animate-pulse bg-red-500',
    text: 'Connection lost — reconnecting...',
  },
  reconnecting: {
    tone: 'border-amber-300 bg-amber-50 text-amber-800',
    dot: 'animate-pulse bg-amber-500',
    text: 'Reconnecting...',
  },
};

/**
 * App-wide banner that surfaces WebSocket connection problems.
 *
 * - Stale (no pong > 4s): amber "Checking connection..." — shown immediately
 *   (no debounce) so the user pauses before sending.
 * - Disconnected: red "Connection lost — reconnecting..."
 * - Reconnecting: amber "Reconnecting..."
 * - Just reconnected: brief green "Reconnected" flash.
 * - Connected (steady state): an empty live region.
 */
export function ConnectionStatusBanner() {
  const state = useConnectionState();
  const [mode, setMode] = useState<BannerMode>('hidden');
  const prevStateRef = useRef<ConnectionState>(state);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;

    if (state === 'auth_failed') {
      // Terminal — show immediately and never clear; the transport has
      // stopped reconnecting.
      clearTimers();
      showTimerRef.current = setTimeout(() => {
        showTimerRef.current = null;
        setMode('auth_failed');
      }, 0);
    } else if (state === 'stale') {
      // Stale shows immediately — the whole point is to warn before the user
      // clicks send, so debouncing would defeat the purpose.
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
      showTimerRef.current = setTimeout(() => {
        showTimerRef.current = null;
        setMode('stale');
      }, 0);
    } else if (state === 'disconnected' || state === 'reconnecting') {
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }

      // If banner is already showing a bad state, update it.
      // If hidden, debounce before showing.
      if (mode === 'disconnected' || mode === 'reconnecting' || mode === 'stale') {
        const target: BannerMode = state;
        if (mode !== target) {
          showTimerRef.current = setTimeout(() => {
            showTimerRef.current = null;
            setMode(target);
          }, 0);
        }
      } else if (!showTimerRef.current) {
        const target: BannerMode = state;
        showTimerRef.current = setTimeout(() => {
          showTimerRef.current = null;
          setMode(target);
        }, SHOW_DELAY_MS);
      }
    } else {
      // Connected or connecting — cancel pending show
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }

      // Show "Reconnected" flash if we were previously showing a banner
      if (
        BAD_STATES.has(prev) &&
        state === 'connected' &&
        mode !== 'hidden' &&
        mode !== 'reconnected'
      ) {
        flashTimerRef.current = setTimeout(() => {
          flashTimerRef.current = null;
          setMode('hidden');
        }, RECONNECTED_FLASH_MS);
        showTimerRef.current = setTimeout(() => {
          showTimerRef.current = null;
          setMode('reconnected');
        }, 0);
      } else if (mode !== 'hidden' && mode !== 'reconnected') {
        showTimerRef.current = setTimeout(() => {
          showTimerRef.current = null;
          setMode('hidden');
        }, 0);
      }
    }

    return () => {
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
    };
  }, [state, mode, clearTimers]);

  // Cleanup on unmount
  useEffect(() => clearTimers, [clearTimers]);

  const banner = mode === 'hidden' ? null : BANNERS[mode];

  // The live region stays mounted so screen readers announce each change.
  // data-visible lets index.css drop the page header's notch spacer: the
  // banner sits above the header and takes the notch area itself.
  return (
    <div
      role="status"
      aria-live="polite"
      className="connection-banner"
      data-visible={banner ? 'true' : undefined}
    >
      {banner && (
        <div
          className={`border-b px-4 pt-[calc(env(safe-area-inset-top)+0.5rem)] pb-2 text-center text-sm ${banner.tone}`}
        >
          {banner.dot && (
            <span
              aria-hidden="true"
              className={`mr-2 inline-block h-2 w-2 rounded-full ${banner.dot}`}
            />
          )}
          {banner.text}
          {mode === 'auth_failed' && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="ml-2 font-medium underline hover:text-red-900"
            >
              Reload
            </button>
          )}
        </div>
      )}
    </div>
  );
}
