import { useEffect, useRef, useSyncExternalStore } from 'react';

const DRAFT_KEY = 'draft';
const DEBOUNCE_MS = 500;

interface UseDraftPersistenceOptions {
  place: 'chatview' | 'project-chat' | 'project-instructions' | 'system-prompt-modal';
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
 * Hook to persist draft text to localStorage with debouncing.
 *
 * Format: localStorage key='draft', value='<place>|<contextId>|<content>'
 *
 * Features:
 * - Saves to localStorage after 500ms of inactivity
 * - Restores draft when component mounts (if context matches)
 * - Clears draft when context changes
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
 *   clearDraft();
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

    const stored = localStorage.getItem(DRAFT_KEY);
    if (!stored) return;

    try {
      const [storedPlace, storedContextId, ...contentParts] = stored.split('|');
      const storedContent = contentParts.join('|'); // Handle content with pipes

      // Only restore if place and context match
      if (storedPlace === place && storedContextId === contextId && storedContent) {
        console.debug(`[useDraftPersistence] Restoring draft for ${place}/${contextId}`);
        onChange(storedContent);

        // Check if restored draft differs from DB value
        if (initialDbValue !== undefined && storedContent !== initialDbValue) {
          draftDifferenceStore.set(storeKey, true);
        }
      }
    } catch (error) {
      console.error('[useDraftPersistence] Failed to restore draft:', error);
    }
  }, [enabled, place, contextId, onChange, initialDbValue, storeKey]);

  // Clear draft when context changes
  useEffect(() => {
    if (!enabled) return;

    if (lastContextIdRef.current !== contextId) {
      console.debug(
        `[useDraftPersistence] Context changed from ${lastContextIdRef.current} to ${contextId}, clearing draft`
      );
      const oldKey = `${place}|${lastContextIdRef.current}`;
      draftDifferenceStore.clear(oldKey);
      clearDraft();
      lastContextIdRef.current = contextId;
      initializedRef.current = false; // Allow restoration for new context
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
        const draftValue = `${place}|${contextId}|${value}`;
        localStorage.setItem(DRAFT_KEY, draftValue);
        console.debug(`[useDraftPersistence] Saved draft for ${place}/${contextId}`);
      } else {
        // Clear if empty
        localStorage.removeItem(DRAFT_KEY);
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
  }, [enabled, place, contextId, value]);

  // Cleanup store entry on unmount
  useEffect(() => {
    return () => {
      draftDifferenceStore.clear(storeKey);
    };
  }, [storeKey]);

  return { hasDraftDifference };
}

/**
 * Clear the draft from localStorage.
 * Call this when the draft is submitted or should be discarded.
 */
export function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
  console.debug('[useDraftPersistence] Draft cleared');
}

/**
 * Clear draft difference flag for a specific context.
 * Call this when the draft is discarded or reset to DB value.
 */
export function clearDraftDifference(place: string, contextId: string) {
  const key = `${place}|${contextId}`;
  draftDifferenceStore.clear(key);
}
