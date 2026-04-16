/**
 * User preferences for UI behavior.
 * Hardcoded defaults now - can be backed by localStorage/context later.
 */
export interface Preferences {
  /** Move tool icons to right side in backstage/tool result views */
  iconOnRight: boolean;
}

const DEFAULT_PREFERENCES: Preferences = {
  iconOnRight: true,
};

/**
 * Hook to access user preferences.
 * Returns hardcoded defaults for now - extensible for future preferences page/storage.
 */
export function usePreferences(): Preferences {
  return DEFAULT_PREFERENCES;
}
