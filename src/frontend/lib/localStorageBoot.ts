/**
 * Pure main-thread helpers for the small set of localStorage entries the
 * frontend has to read or write *before* the worker is initialized: the
 * Content Encryption Key and the storage configuration.
 *
 * The CEK is stored as a base32 (or legacy base64) string at
 * `chatbot_cek`. The storage config is stored as a JSON blob at
 * `gremlinofa_storage_config`.
 *
 * The frontend uses these helpers in two places:
 *   1. `bootstrapClient.ts` reads CEK + config to pass through `init`.
 *   2. OOBE / Data Manager write CEK + config when the user picks a flow.
 *
 * Anything that needs the *bytes* of the CEK (or any base32/base64 ↔ bytes
 * conversion) goes through the dormant-callable RPCs on `gremlinClient`
 * (`generateNewCEK`, `normalizeCEK`, `deriveUserIdFromCEK`). The frontend
 * never imports CEK format helpers — they live backend-side only.
 *
 * Phase 1.8 split: the `StorageConfig` type moved to
 * `src/shared/protocol/types/storageConfig.ts` so the worker side can
 * import the same shape without depending on this frontend module. The
 * runtime helpers (read/write/clear/hash) stay here under
 * `src/frontend/lib/`.
 */

import type { StorageConfig } from '../../shared/protocol/types/storageConfig';

export type { StorageConfig };

const CEK_KEY = 'chatbot_cek';
const STORAGE_CONFIG_KEY = 'gremlinofa_storage_config';

/** Read the CEK string (base32 or base64) from localStorage. `null` if missing. */
export function getCachedCEKString(): string | null {
  try {
    return localStorage.getItem(CEK_KEY);
  } catch (error) {
    console.error('[localStorageBoot] Failed to read CEK:', error);
    return null;
  }
}

/** Persist the CEK string to localStorage. Caller decides the encoding. */
export function setCachedCEKString(cek: string): void {
  localStorage.setItem(CEK_KEY, cek);
}

/** Remove the CEK from localStorage (used by detach / purge / wrong-CEK paths). */
export function clearCachedCEK(): void {
  try {
    localStorage.removeItem(CEK_KEY);
  } catch (error) {
    console.error('[localStorageBoot] Failed to clear CEK:', error);
  }
}

/** Read the storage config JSON. Defaults to `{ type: 'local' }` on error/missing. */
export function getStorageConfig(): StorageConfig {
  try {
    const stored = localStorage.getItem(STORAGE_CONFIG_KEY);
    if (stored) {
      return JSON.parse(stored) as StorageConfig;
    }
  } catch (error) {
    console.error('[localStorageBoot] Failed to read storage config:', error);
  }
  return { type: 'local' };
}

/** Persist the storage config JSON. */
export function setStorageConfig(config: StorageConfig): void {
  localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(config));
}

/** Remove the storage config from localStorage. */
export function clearStorageConfig(): void {
  localStorage.removeItem(STORAGE_CONFIG_KEY);
}

/**
 * Hash a password with SHA-512 and the gremlinofa salt. Pure crypto.subtle
 * call — no service dependency. Used by OOBE and the Data Manager when
 * configuring remote storage.
 */
export async function hashPassword(password: string): Promise<string> {
  if (!password) return '';

  const salted = `${password}|gremlinofa`;
  const data = new TextEncoder().encode(salted);
  const hashBuffer = await crypto.subtle.digest('SHA-512', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
