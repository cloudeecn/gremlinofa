/**
 * Storage Configuration Module
 * Manages storage type configuration in localStorage
 */

/**
 * Hash password with SHA-512 and salt for secure storage/transmission.
 * Prevents leaking user's original password if they reuse common passwords.
 *
 * @param password - The original password entered by user
 * @returns Hex-encoded SHA-512 hash of `${password}|gremlinofa`, or empty string if password is empty
 */
export async function hashPassword(password: string): Promise<string> {
  if (!password) return '';

  const salted = `${password}|gremlinofa`;
  const data = new TextEncoder().encode(salted);
  const hashBuffer = await crypto.subtle.digest('SHA-512', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export type StorageConfig =
  | { type: 'local' }
  | { type: 'remote'; baseUrl: string; password: string; userId: string };

const STORAGE_CONFIG_KEY = 'gremlinofa_storage_config';

/**
 * Get the current storage configuration from localStorage
 * Returns default `{ type: 'local' }` if not configured or on error
 */
export function getStorageConfig(): StorageConfig {
  try {
    const stored = localStorage.getItem(STORAGE_CONFIG_KEY);
    if (stored) {
      return JSON.parse(stored) as StorageConfig;
    }
  } catch (error) {
    console.error('Failed to read storage config:', error);
  }
  return { type: 'local' };
}

/**
 * Save storage configuration to localStorage
 */
export function setStorageConfig(config: StorageConfig): void {
  localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(config));
}

/**
 * Remove storage configuration from localStorage
 */
export function clearStorageConfig(): void {
  localStorage.removeItem(STORAGE_CONFIG_KEY);
}
