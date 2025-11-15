import { useCallback, useEffect, useRef, useState } from 'react';

/** Interval for batching visibility updates to reduce re-renders during fast scrolling */
const VISIBILITY_SYNC_INTERVAL_MS = 200;

interface UseVirtualScrollReturn {
  visibleMessageIds: Set<string>;
  registerMessage: (messageId: string, element: HTMLElement | null) => void;
  measureHeight: (messageId: string, height: number) => void;
  getHeight: (messageId: string) => number | undefined;
}

/**
 * Hook for managing virtual scrolling of messages.
 * Tracks which messages are visible (within viewport + buffer) and caches their heights.
 *
 * @param bufferScreens - Number of screen heights to buffer above/below viewport (default: 2)
 */
export function useVirtualScroll(bufferScreens: number = 2): UseVirtualScrollReturn {
  const [visibleMessageIds, setVisibleMessageIds] = useState<Set<string>>(new Set());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const elementMapRef = useRef<Map<string, HTMLElement>>(new Map());
  const heightsRef = useRef<Map<string, number>>(new Map());

  // Pending visibility updates accumulated between sync intervals
  const pendingUpdatesRef = useRef<Map<string, boolean>>(new Map());

  // Initialize IntersectionObserver with batched updates
  useEffect(() => {
    const rootMarginValue = `${bufferScreens * 100}% 0px`;

    // Apply pending updates to state
    const applyPendingUpdates = () => {
      if (pendingUpdatesRef.current.size === 0) return;

      const updates = pendingUpdatesRef.current;
      pendingUpdatesRef.current = new Map();

      setVisibleMessageIds(prev => {
        const next = new Set(prev);
        updates.forEach((isVisible, messageId) => {
          if (isVisible) {
            next.add(messageId);
          } else {
            next.delete(messageId);
          }
        });
        return next;
      });
    };

    // Set up interval for batched updates
    const intervalId = setInterval(applyPendingUpdates, VISIBILITY_SYNC_INTERVAL_MS);

    observerRef.current = new IntersectionObserver(
      entries => {
        // Accumulate updates in pending map instead of immediately updating state
        entries.forEach(entry => {
          const messageId = entry.target.getAttribute('data-message-id');
          if (messageId) {
            pendingUpdatesRef.current.set(messageId, entry.isIntersecting);
          }
        });
      },
      {
        root: null, // viewport
        rootMargin: rootMarginValue,
        threshold: 0,
      }
    );

    return () => {
      clearInterval(intervalId);
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [bufferScreens]);

  // Register a message element for observation
  const registerMessage = useCallback((messageId: string, element: HTMLElement | null) => {
    const observer = observerRef.current;
    if (!observer) return;

    // Unobserve and remove old element if it exists
    const oldElement = elementMapRef.current.get(messageId);
    if (oldElement) {
      observer.unobserve(oldElement);
      elementMapRef.current.delete(messageId);
    }

    // Observe new element
    if (element) {
      element.setAttribute('data-message-id', messageId);
      elementMapRef.current.set(messageId, element);
      observer.observe(element);
    }
  }, []);

  // Store measured height for a message
  const measureHeight = useCallback((messageId: string, height: number) => {
    heightsRef.current.set(messageId, height);
  }, []);

  // Get stored height for a message
  const getHeight = useCallback((messageId: string): number | undefined => {
    return heightsRef.current.get(messageId);
  }, []);

  return {
    visibleMessageIds,
    registerMessage,
    measureHeight,
    getHeight,
  };
}
