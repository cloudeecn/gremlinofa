import { useEffect, useRef } from 'react';

const DRAFT_KEY = 'draft';
const DEBOUNCE_MS = 500;

interface UseDraftPersistenceOptions {
  place: 'chatview' | 'project-chat' | 'project-instructions';
  contextId: string; // chatId, projectId, etc.
  value: string;
  onChange: (value: string) => void;
  enabled?: boolean; // Allow disabling persistence (default: true)
}

/**
 * Hook to persist draft text to localStorage with debouncing.
 *
 * Format: localStorage key='draft', value='<place>|<contextId>|<content>'
 *
 * Features:
 * - Saves to localStorage after 500ms of inactivity
 * - Restores draft when component mounts (if context matches)
 * - Clears draft when context changes
 *
 * Usage:
 * ```ts
 * const [inputMessage, setInputMessage] = useState('');
 * useDraftPersistence({
 *   place: 'chatview',
 *   contextId: chatId,
 *   value: inputMessage,
 *   onChange: setInputMessage,
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
}: UseDraftPersistenceOptions) {
  const debounceTimerRef = useRef<number | null>(null);
  const initializedRef = useRef(false);
  const lastContextIdRef = useRef<string>(contextId);

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
      }
    } catch (error) {
      console.error('[useDraftPersistence] Failed to restore draft:', error);
    }
  }, [enabled, place, contextId, onChange]);

  // Clear draft when context changes
  useEffect(() => {
    if (!enabled) return;

    if (lastContextIdRef.current !== contextId) {
      console.debug(
        `[useDraftPersistence] Context changed from ${lastContextIdRef.current} to ${contextId}, clearing draft`
      );
      clearDraft();
      lastContextIdRef.current = contextId;
      initializedRef.current = false; // Allow restoration for new context
    }
  }, [contextId, enabled]);

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

  return null; // Hook doesn't return anything
}

/**
 * Clear the draft from localStorage.
 * Call this when the draft is submitted or should be discarded.
 */
export function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
  console.debug('[useDraftPersistence] Draft cleared');
}
