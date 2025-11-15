/**
 * Storage Configuration Module
 * Manages storage type configuration in localStorage
 */

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
