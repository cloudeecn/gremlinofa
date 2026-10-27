import { useEffect, useRef } from 'react';

const DRAFT_KEY_PREFIX = 'draft_';
const DEBOUNCE_MS = 500;
/** Drafts older than this are cleaned up automatically */
export const DRAFT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 1 day

interface DraftData {
  content: string;
  createdAt: number;
}

interface UseDraftPersistenceOptions {
  place:
    'chatview' | 'project-chat' | 'system-prompt-modal' | 'vfs-editor' | 'tool-option-longtext';
  contextId: string; // chatId, projectId, or composite key like "projectId|toolName|optionId"
  value: string;
  onChange: (value: string) => void;
  enabled?: boolean; // Allow disabling persistence (default: true)
}

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

interface PendingDraft {
  value: string;
  timer: number;
}

/**
 * Debounced writes not yet in localStorage, by storage key. Module-level so a
 * pending write outlives the component that scheduled it: unmount, a key
 * change and leaving the page flush it instead of dropping the last 500 ms of
 * typing, and `clearDraft` can cancel it.
 */
const pendingDrafts = new Map<string, PendingDraft>();
let flushOnLeaveRegistered = false;

function writeDraft(storageKey: string, value: string): void {
  try {
    if (value.trim()) {
      const draftData: DraftData = { content: value, createdAt: Date.now() };
      localStorage.setItem(storageKey, JSON.stringify(draftData));
    } else {
      localStorage.removeItem(storageKey);
    }
  } catch (err) {
    // Full storage or private mode: the text is still in the input
    console.debug('[useDraftPersistence] draft write failed: %o', err);
  }
}

function cancelDraft(storageKey: string): void {
  const pending = pendingDrafts.get(storageKey);
  if (!pending) return;
  window.clearTimeout(pending.timer);
  pendingDrafts.delete(storageKey);
}

function flushDraft(storageKey: string): void {
  const pending = pendingDrafts.get(storageKey);
  if (!pending) return;
  cancelDraft(storageKey);
  writeDraft(storageKey, pending.value);
}

function flushAllDrafts(): void {
  for (const storageKey of [...pendingDrafts.keys()]) flushDraft(storageKey);
}

function scheduleDraft(storageKey: string, value: string): void {
  cancelDraft(storageKey);
  const timer = window.setTimeout(() => {
    pendingDrafts.delete(storageKey);
    writeDraft(storageKey, value);
  }, DEBOUNCE_MS);
  pendingDrafts.set(storageKey, { value, timer });

  // Closing or backgrounding the tab doesn't unmount anything; mobile browsers
  // may kill a hidden tab without another event
  if (!flushOnLeaveRegistered) {
    flushOnLeaveRegistered = true;
    window.addEventListener('pagehide', flushAllDrafts);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushAllDrafts();
    });
  }
}

/**
 * Hook to persist draft text to localStorage with debouncing.
 *
 * Format: localStorage key='draft_<place>_<contextId>', value=JSON {content, createdAt}
 *
 * - Saves to localStorage after 500ms of inactivity; unmount, a context change,
 *   `enabled` turning off and leaving the page write a pending save right away
 * - Restores the draft whenever the storage key changes (mount included), if
 *   there is one and it hasn't expired
 * - Multiple drafts can coexist (keyed by place+contextId)
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
}: UseDraftPersistenceOptions): void {
  const storageKey = buildDraftKey(place, contextId);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  // The input's value when the current key took over. It belongs to the
  // previous key (or the initial state), so it isn't saved under this one
  // until it changes.
  const inheritedValueRef = useRef<string | null>(null);

  // Declared first: the effects below read the latest value and callback
  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
  });

  // Restore on mount and on every key change. Declared before the save effect
  // so the inherited value is recorded before that effect looks at it.
  useEffect(() => {
    if (!enabled) return;
    cleanupExpiredDrafts();

    inheritedValueRef.current = valueRef.current;
    const stored = localStorage.getItem(storageKey);
    const draftData = parseDraftData(stored);
    if (draftData && draftData.content) {
      console.debug('[useDraftPersistence] Restoring draft for %s', storageKey);
      onChangeRef.current(draftData.content);
    } else if (stored) {
      // Remove invalid/expired entry
      localStorage.removeItem(storageKey);
    }

    return () => flushDraft(storageKey);
  }, [enabled, storageKey]);

  // Save with debouncing
  useEffect(() => {
    if (!enabled) return;
    if (inheritedValueRef.current !== null) {
      if (value === inheritedValueRef.current) return;
      // One-shot: once the value moves, every later value is this key's own,
      // including an empty box after a restore (which deletes the draft)
      inheritedValueRef.current = null;
    }
    scheduleDraft(storageKey, value);
  }, [enabled, storageKey, value]);
}

/**
 * Clear a specific draft from localStorage, along with a pending write that
 * would otherwise bring it back. Call this when the draft is submitted or
 * should be discarded.
 */
export function clearDraft(place: string, contextId: string) {
  const key = buildDraftKey(place, contextId);
  cancelDraft(key);
  localStorage.removeItem(key);
  console.debug('[useDraftPersistence] Draft cleared for %s', key);
}

/**
 * Clear all drafts from localStorage.
 * Call this when purging data or detaching from storage.
 */
export function clearAllDrafts() {
  for (const storageKey of [...pendingDrafts.keys()]) cancelDraft(storageKey);
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
  console.debug('[useDraftPersistence] Cleared all drafts (%d entries)', keysToRemove.length);
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
    console.debug('[useDraftPersistence] Cleaned up %d expired drafts', keysToRemove.length);
  }
}
