/**
 * Top-of-app bootstrap. Reads the CEK + storage config from localStorage
 * on the main thread (the only main-thread localStorage read in the
 * frontend codepath) and posts them through `gremlinClient.init` to bring
 * up the worker.
 *
 * Three outcomes:
 *
 *   1. **`ready: true`** — both CEK and storage config existed and `init`
 *      succeeded. The app can mount and start fetching data.
 *
 *   2. **`needsOOBE: true`** — CEK or storage config is missing. Render
 *      the OOBE wizard, which writes both to localStorage on its own and
 *      then calls `gremlinClient.init` directly.
 *
 *   3. **`error`** — `init` failed (e.g. corrupted CEK, mismatch with
 *      remote storage). The caller decides whether to render an error
 *      UI or fall back to OOBE.
 *
 * Phase 1.8 leak fix: the CEK is posted as a base32 string (the same form
 * it lives at in localStorage). The backend's `EncryptionCore` accepts
 * both base32 and legacy base64 — the frontend never imports any CEK
 * format helpers.
 */

import { gremlinClient } from './index';
import { getCachedCEKString, getStorageConfig, type StorageConfig } from '../lib/localStorageBoot';

export interface BootstrapResult {
  ready: boolean;
  needsOOBE: boolean;
  error?: string;
}

/**
 * Run the bootstrap. Idempotent — calling twice with the same CEK is a
 * no-op success (the worker's init handler short-circuits unchanged
 * state).
 */
export async function bootstrap(): Promise<BootstrapResult> {
  const cekString = getCachedCEKString();
  if (!cekString) {
    console.debug('[bootstrap] No CEK in localStorage — needsOOBE');
    return { ready: false, needsOOBE: true };
  }

  const storageConfig = await fillStorageConfigUserId(getStorageConfig(), cekString);

  try {
    // Phase 1.5: storage config flows through the worker's out-of-band
    // bootstrap channel, not through the typed `init` envelope. The
    // worker stashes it and reads it inside its `init` handler.
    await gremlinClient.configureWorker(storageConfig);
    await gremlinClient.init({ cek: cekString });
    return { ready: true, needsOOBE: false };
  } catch (err) {
    console.error('[bootstrap] gremlinClient.init failed:', err);
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
 * For local configs there's nothing to fill in.
 */
async function fillStorageConfigUserId(config: StorageConfig, cek: string): Promise<StorageConfig> {
  if (config.type !== 'remote') return config;
  if (config.userId && config.userId.length > 0) return config;

  const userId = await gremlinClient.deriveUserIdFromCEK(cek);
  return { ...config, userId };
}
