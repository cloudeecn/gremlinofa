import { useEffect, useRef, useSyncExternalStore } from 'react';

const DRAFT_KEY_PREFIX = 'draft_';
const DEBOUNCE_MS = 500;
/** Drafts older than this are cleaned up automatically */
export const DRAFT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 1 day

interface DraftData {
  content: string;
  createdAt: number;
}

interface UseDraftPersistenceOptions {
  place: 'chatview' | 'project-chat' | 'system-prompt-modal';
  contextId: string; // chatId, projectId, etc.
  value: string;
  onChange: (value: string) => void;
  enabled?: boolean; // Allow disabling persistence (default: true)
  initialDbValue?: string; // Original value from DB (for detecting draft differences)
}

interface UseDraftPersistenceResult {
  /** True when a draft was restored that differs from the DB value */
  hasDraftDifference: boolean;
}

// Store for tracking draft differences (keyed by place|contextId)
const draftDifferenceStore = {
  subscribers: new Set<() => void>(),
  values: new Map<string, boolean>(),
  subscribe(callback: () => void) {
    draftDifferenceStore.subscribers.add(callback);
    return () => draftDifferenceStore.subscribers.delete(callback);
  },
  get(key: string): boolean {
    return draftDifferenceStore.values.get(key) ?? false;
  },
  set(key: string, value: boolean) {
    const prev = draftDifferenceStore.values.get(key);
    if (prev !== value) {
      draftDifferenceStore.values.set(key, value);
      draftDifferenceStore.subscribers.forEach(cb => cb());
    }
  },
  clear(key: string) {
    if (draftDifferenceStore.values.has(key)) {
      draftDifferenceStore.values.delete(key);
      draftDifferenceStore.subscribers.forEach(cb => cb());
    }
  },
};

/**
 * Build localStorage key for a draft.
 */
function buildDraftKey(place: string, contextId: string): string {
  return `${DRAFT_KEY_PREFIX}${place}_${contextId}`;
}

/**
 * Parse draft data from localStorage value.
 * Returns null if invalid or expired.
 */
function parseDraftData(stored: string | null): DraftData | null {
  if (!stored) return null;
  try {
    const data = JSON.parse(stored) as DraftData;
    if (typeof data.content !== 'string' || typeof data.createdAt !== 'number') {
      return null;
    }
    // Check expiry
    if (Date.now() - data.createdAt > DRAFT_EXPIRY_MS) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Hook to persist draft text to localStorage with debouncing.
 *
 * Format: localStorage key='draft_<place>_<contextId>', value=JSON {content, createdAt}
 *
 * Features:
 * - Saves to localStorage after 500ms of inactivity
 * - Restores draft when component mounts (if context matches and not expired)
 * - Multiple drafts can coexist (keyed by place+contextId)
 * - Returns `hasDraftDifference` when restored draft differs from initialDbValue
 *
 * Usage:
 * ```ts
 * const [inputMessage, setInputMessage] = useState('');
 * const { hasDraftDifference } = useDraftPersistence({
 *   place: 'chatview',
 *   contextId: chatId,
 *   value: inputMessage,
 *   onChange: setInputMessage,
 *   initialDbValue: '', // optional: for detecting draft differences
 * });
 *
 * // Clear draft on submit:
 * const handleSubmit = () => {
 *   clearDraft('chatview', chatId);
 *   // ... submit logic
 * };
 * ```
 */
export function useDraftPersistence({
  place,
  contextId,
  value,
  onChange,
  enabled = true,
  initialDbValue,
}: UseDraftPersistenceOptions): UseDraftPersistenceResult {
  const debounceTimerRef = useRef<number | null>(null);
  const initializedRef = useRef(false);
  const lastContextIdRef = useRef<string>(contextId);
  const storeKey = `${place}|${contextId}`;
  const localStorageKey = buildDraftKey(place, contextId);

  // Subscribe to draft difference store for re-renders
  const hasDraftDifference = useSyncExternalStore(
    draftDifferenceStore.subscribe,
    () => draftDifferenceStore.get(storeKey),
    () => false
  );

  // Restore draft on mount (only once)
  useEffect(() => {
    if (!enabled || initializedRef.current) return;
    initializedRef.current = true;

    // Run cleanup on init
    cleanupExpiredDrafts();

    const stored = localStorage.getItem(localStorageKey);
    const draftData = parseDraftData(stored);

    if (draftData && draftData.content) {
      console.debug(`[useDraftPersistence] Restoring draft for ${place}/${contextId}`);
      onChange(draftData.content);

      // Check if restored draft differs from DB value
      if (initialDbValue !== undefined && draftData.content !== initialDbValue) {
        draftDifferenceStore.set(storeKey, true);
      }
    } else if (stored) {
      // Remove invalid/expired entry
      localStorage.removeItem(localStorageKey);
    }
  }, [enabled, place, contextId, onChange, initialDbValue, storeKey, localStorageKey]);

  // Handle context changes - run cleanup when switching contexts
  useEffect(() => {
    if (!enabled) return;

    if (lastContextIdRef.current !== contextId) {
      console.debug(
        `[useDraftPersistence] Context changed from ${lastContextIdRef.current} to ${contextId}`
      );
      const oldKey = `${place}|${lastContextIdRef.current}`;
      draftDifferenceStore.clear(oldKey);
      lastContextIdRef.current = contextId;
      initializedRef.current = false; // Allow restoration for new context

      // Run cleanup on context change
      cleanupExpiredDrafts();
    }
  }, [contextId, enabled, place]);

  // Save draft with debouncing
  useEffect(() => {
    if (!enabled) return;

    // Clear existing timer
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }

    // Set new timer
    debounceTimerRef.current = window.setTimeout(() => {
      if (value.trim()) {
        const draftData: DraftData = {
          content: value,
          createdAt: Date.now(),
        };
        localStorage.setItem(localStorageKey, JSON.stringify(draftData));
        console.debug(`[useDraftPersistence] Saved draft for ${place}/${contextId}`);
      } else {
        // Clear if empty
        localStorage.removeItem(localStorageKey);
        console.debug(`[useDraftPersistence] Cleared draft (empty value)`);
      }
      debounceTimerRef.current = null;
    }, DEBOUNCE_MS);

    // Cleanup on unmount
    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
    };
  }, [enabled, place, contextId, value, localStorageKey]);

  // Cleanup store entry on unmount
  useEffect(() => {
    return () => {
      draftDifferenceStore.clear(storeKey);
    };
  }, [storeKey]);

  return { hasDraftDifference };
}

/**
 * Clear a specific draft from localStorage.
 * Call this when the draft is submitted or should be discarded.
 */
export function clearDraft(place: string, contextId: string) {
  const key = buildDraftKey(place, contextId);
  localStorage.removeItem(key);
  console.debug(`[useDraftPersistence] Draft cleared for ${place}/${contextId}`);
}

/**
 * Clear all drafts from localStorage.
 * Call this when purging data or detaching from storage.
 */
export function clearAllDrafts() {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(DRAFT_KEY_PREFIX)) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
  console.debug(`[useDraftPersistence] Cleared all drafts (${keysToRemove.length} entries)`);
}

/**
 * Remove drafts older than DRAFT_EXPIRY_MS.
 * Called automatically on app load and context changes.
 */
export function cleanupExpiredDrafts() {
  const now = Date.now();
  const keysToRemove: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(DRAFT_KEY_PREFIX)) {
      const stored = localStorage.getItem(key);
      const draftData = parseDraftData(stored);
      if (!draftData) {
        // Invalid or expired
        keysToRemove.push(key);
      } else if (now - draftData.createdAt > DRAFT_EXPIRY_MS) {
        keysToRemove.push(key);
      }
    }
  }

  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }

  if (keysToRemove.length > 0) {
    console.debug(`[useDraftPersistence] Cleaned up ${keysToRemove.length} expired drafts`);
  }
}

/**
 * Clear draft difference flag for a specific context.
 * Call this when the draft is discarded or reset to DB value.
 */
export function clearDraftDifference(place: string, contextId: string) {
  const key = `${place}|${contextId}`;
  draftDifferenceStore.clear(key);
}
