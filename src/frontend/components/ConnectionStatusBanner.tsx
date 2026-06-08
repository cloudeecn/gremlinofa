import { useState, useEffect, useRef, useCallback } from 'react';
import { useConnectionState } from '../hooks/useConnectionState';
import type { ConnectionState } from '../../shared/protocol/transport';

/** Delay before showing the disconnected/reconnecting banner — avoids flicker on quick reconnects. */
const SHOW_DELAY_MS = 500;
/** How long the "Reconnected" flash stays visible. */
const RECONNECTED_FLASH_MS = 1_500;

/** States that mean "something is wrong with the connection". */
const BAD_STATES = new Set<ConnectionState>(['stale', 'disconnected', 'reconnecting']);

type BannerMode = 'hidden' | 'stale' | 'disconnected' | 'reconnecting' | 'reconnected';

/**
 * App-wide banner that surfaces WebSocket connection problems.
 *
 * - Stale (no pong > 4s): amber "Checking connection..." — shown immediately
 *   (no debounce) so the user pauses before sending.
 * - Disconnected: red "Connection lost — reconnecting..."
 * - Reconnecting: amber "Reconnecting..."
 * - Just reconnected: brief green "Reconnected" flash.
 * - Connected (steady state): renders nothing.
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

    if (state === 'stale') {
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

  if (mode === 'hidden') return null;

  if (mode === 'reconnected') {
    return (
      <div className="border-b border-green-300 bg-green-50 px-4 py-2 text-center text-sm text-green-800">
        Reconnected
      </div>
    );
  }

  if (mode === 'stale') {
    return (
      <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-800">
        <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
        Checking connection...
      </div>
    );
  }

  if (mode === 'disconnected') {
    return (
      <div className="border-b border-red-300 bg-red-50 px-4 py-2 text-center text-sm text-red-800">
        <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
        Connection lost — reconnecting...
      </div>
    );
  }

  if (mode === 'reconnecting') {
    return (
      <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-800">
        <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
        Reconnecting...
      </div>
    );
  }

  return null;
}
