/**
 * Top-of-app bootstrap. Reads the CEK + storage config from localStorage
 * on the main thread (the only main-thread localStorage read in the
 * frontend codepath) and posts them through `gremlinClient.init` to bring
 * up the backend.
 *
 * Three outcomes:
 *
 *   1. **`ready: true`** — both CEK and storage config existed and `init`
 *      succeeded. The app can start fetching data.
 *
 *   2. **`needsOOBE: true`** — no CEK. Render the OOBE wizard, which
 *      writes both to localStorage on its own and then calls
 *      `gremlinClient.init` directly.
 *
 *   3. **`error`** — the backend couldn't start or rejected the key (worker
 *      script failed to load, corrupted CEK, mismatched remote storage).
 *
 * React mounts before any of this settles: `main.tsx` calls
 * `startBootstrap()` without awaiting and hands the handle to `AppProvider`,
 * whose boot screen shows the current phase. A backend that never answers
 * leaves a boot screen saying so, not a blank page.
 *
 * Phase 1.8 leak fix: the CEK is posted as a base32 string (the same form
 * it lives at in localStorage). The backend's `EncryptionCore` accepts
 * both base32 and legacy base64 — the frontend never imports any CEK
 * format helpers.
 */

import { gremlinClient } from './index';
import {
  getCachedCEKString,
  getStorageConfig,
  setStorageConfig,
  type StorageConfig,
} from '../lib/localStorageBoot';

export interface BootstrapResult {
  ready: boolean;
  needsOOBE: boolean;
  error?: string;
}

/**
 * - `backend`: waiting for the worker's `worker_ready` (in server mode the
 *   socket state says more, so it moves on right away)
 * - `unlock`: `init` sent; storage opening and checking the key
 * - `done`: `init` succeeded
 *
 * A failed bootstrap stays on the phase that failed.
 */
export type BootPhase = 'backend' | 'unlock' | 'done';

/** A running bootstrap: its result plus the phase it's in, for the boot screen. */
export interface BootHandle {
  readonly result: Promise<BootstrapResult>;
  getPhase(): BootPhase;
  subscribe(listener: () => void): () => void;
}

/** Start the bootstrap and return right away; see `BootHandle`. */
export function startBootstrap(): BootHandle {
  let phase: BootPhase = 'backend';
  const listeners = new Set<() => void>();
  const result = bootstrap(next => {
    if (next === phase) return;
    phase = next;
    for (const listener of listeners) listener();
  });
  return {
    result,
    getPhase: () => phase,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Run the bootstrap. Calling it twice with the same CEK is a no-op success
 * (the backend's init handler short-circuits unchanged state). Never
 * rejects: failures come back as `{ error }`.
 */
export async function bootstrap(
  onPhase: (phase: BootPhase) => void = () => {}
): Promise<BootstrapResult> {
  const cekString = getCachedCEKString();
  if (!cekString) {
    console.debug('[bootstrap] No CEK in localStorage — needsOOBE');
    return { ready: false, needsOOBE: true };
  }

  try {
    const storageConfig = await fillStorageConfigUserId(getStorageConfig(), cekString);
    // Server mode: the Node backend reads its own config from env vars,
    // so configureWorker is a no-op. Worker/local modes still need the
    // out-of-band bootstrap channel.
    if (storageConfig.type !== 'server') {
      await gremlinClient.configureWorker(storageConfig);
    }
    onPhase('unlock');
    await gremlinClient.init({ cek: cekString });
    onPhase('done');
    return { ready: true, needsOOBE: false };
  } catch (err) {
    console.error('[bootstrap] Backend failed to start:', err);
    return {
      ready: false,
      needsOOBE: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Remote storage configs need a `userId` derived from the CEK. The
 * derivation runs backend-side via the dormant-callable
 * `deriveUserIdFromCEK` RPC so the frontend never imports the CEK
 * format helpers required to decode bytes off the localStorage string.
 *
 * The derivation is a 600k-iteration PBKDF2, so the result is written back:
 * configs saved before OOBE stored `userId` would otherwise pay it on every
 * boot.
 */
async function fillStorageConfigUserId(config: StorageConfig, cek: string): Promise<StorageConfig> {
  if (config.type !== 'remote') return config;
  if (config.userId && config.userId.length > 0) return config;

  const userId = await gremlinClient.deriveUserIdFromCEK(cek);
  const filled = { ...config, userId };
  try {
    setStorageConfig(filled);
  } catch (err) {
    console.debug('[bootstrap] Could not persist the derived userId: %o', err);
  }
  return filled;
}
