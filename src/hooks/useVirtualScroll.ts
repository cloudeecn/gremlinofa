import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** Interval for batching visibility updates to reduce re-renders during fast scrolling */
const VISIBILITY_SYNC_INTERVAL_MS = 200;

/** Minimum viewport height to use for buffer calculation (prevents tiny buffers on small screens) */
const MIN_VIEWPORT_HEIGHT = 600;

interface UseVirtualScrollReturn {
  visibleMessageIds: Set<string>;
  registerMessage: (messageId: string, element: HTMLElement | null) => void;
  measureHeight: (messageId: string, height: number) => void;
  getHeight: (messageId: string) => number | undefined;
}

/** Pending registration that arrived before observer was ready */
interface PendingRegistration {
  messageId: string;
  element: HTMLElement;
}

/**
 * Hook for managing virtual scrolling of messages.
 * Tracks which messages are visible (within viewport + buffer) and caches their heights.
 *
 * @param scrollContainerRef - Ref to the scroll container element (required for proper buffer calculation)
 * @param bufferScreens - Number of screen heights to buffer above/below viewport (default: 5)
 */
export function useVirtualScroll(
  scrollContainerRef: RefObject<HTMLDivElement | null>,
  bufferScreens: number = 5
): UseVirtualScrollReturn {
  const [visibleMessageIds, setVisibleMessageIds] = useState<Set<string>>(new Set());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const elementMapRef = useRef<Map<string, HTMLElement>>(new Map());
  const heightsRef = useRef<Map<string, number>>(new Map());

  // Pending visibility updates accumulated between sync intervals
  const pendingUpdatesRef = useRef<Map<string, boolean>>(new Map());

  // Queue for registrations that arrived before observer was ready
  const pendingRegistrationsRef = useRef<PendingRegistration[]>([]);

  // Initialize IntersectionObserver with batched updates
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      console.debug('[VirtualScroll] Waiting for scroll container ref...');
      return;
    }

    // Use scroll container height for buffer calculation (more accurate than window.innerHeight)
    const containerHeight = Math.max(scrollContainer.clientHeight, MIN_VIEWPORT_HEIGHT);
    const rootMarginPx = Math.round(containerHeight * bufferScreens);
    const rootMarginValue = `${rootMarginPx}px 0px`;

    console.debug(
      `[VirtualScroll] Creating observer with root: scrollContainer, rootMargin: ${rootMarginValue}`,
      `(container: ${scrollContainer.clientHeight}px, buffer: ${bufferScreens}x)`
    );

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

    const observer = new IntersectionObserver(
      entries => {
        // Accumulate updates in pending map instead of immediately updating state
        entries.forEach(entry => {
          const messageId = entry.target.getAttribute('data-message-id');
          if (messageId) {
            const isIntersecting = entry.isIntersecting;
            pendingUpdatesRef.current.set(messageId, isIntersecting);

            // Debug logging to verify buffer behavior
            if (isIntersecting) {
              console.debug(
                `[VirtualScroll] Message ${messageId} ENTERING buffer zone`,
                entry.boundingClientRect
              );
            } else {
              console.debug(
                `[VirtualScroll] Message ${messageId} LEAVING buffer zone`,
                entry.boundingClientRect
              );
            }
          }
        });
      },
      {
        root: scrollContainer, // Use scroll container as root for accurate buffer calculation
        rootMargin: rootMarginValue,
        threshold: 0,
      }
    );

    observerRef.current = observer;

    // Process any registrations that arrived before observer was ready
    const pending = pendingRegistrationsRef.current;
    if (pending.length > 0) {
      console.debug(`[VirtualScroll] Processing ${pending.length} pending registrations`);
      for (const { messageId, element } of pending) {
        element.setAttribute('data-message-id', messageId);
        elementMapRef.current.set(messageId, element);
        observer.observe(element);
      }
      pendingRegistrationsRef.current = [];
    }

    return () => {
      clearInterval(intervalId);
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [scrollContainerRef, bufferScreens]);

  // Register a message element for observation
  const registerMessage = useCallback((messageId: string, element: HTMLElement | null) => {
    const observer = observerRef.current;

    // Unobserve and remove old element if it exists
    const oldElement = elementMapRef.current.get(messageId);
    if (oldElement && observer) {
      observer.unobserve(oldElement);
    }
    if (oldElement) {
      elementMapRef.current.delete(messageId);
    }

    // Handle new element registration
    if (element) {
      if (observer) {
        // Observer ready - register immediately
        element.setAttribute('data-message-id', messageId);
        elementMapRef.current.set(messageId, element);
        observer.observe(element);
      } else {
        // Observer not ready - queue for later
        pendingRegistrationsRef.current.push({ messageId, element });
      }
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
