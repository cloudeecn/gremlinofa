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

/** Pending registration that arrived before observers were ready */
interface PendingRegistration {
  messageId: string;
  element: HTMLElement;
}

/**
 * Hook for managing virtual scrolling of messages.
 * Uses two IntersectionObservers with asymmetric thresholds (hysteresis) to prevent
 * bounce at the buffer boundary. Messages virtualize when leaving the outer zone
 * and re-render when entering the inner zone, with a dead zone in between.
 *
 * @param scrollContainerRef - Ref to the scroll container element
 * @param bufferScreens - Number of screen heights for the outer buffer (default: 5). Inner buffer is bufferScreens - 1.
 */
export function useVirtualScroll(
  scrollContainerRef: RefObject<HTMLDivElement | null>,
  bufferScreens: number = 5
): UseVirtualScrollReturn {
  const [visibleMessageIds, setVisibleMessageIds] = useState<Set<string>>(new Set());
  const outerObserverRef = useRef<IntersectionObserver | null>(null);
  const innerObserverRef = useRef<IntersectionObserver | null>(null);
  const elementMapRef = useRef<Map<string, HTMLElement>>(new Map());
  const heightsRef = useRef<Map<string, number>>(new Map());

  // Tracks messages that have had their initial outer-observer detection,
  // so we can distinguish first-mount from re-entry in the hysteresis zone
  const initializedIdsRef = useRef<Set<string>>(new Set());

  // Pending visibility updates accumulated between sync intervals
  const pendingUpdatesRef = useRef<Map<string, boolean>>(new Map());

  // Queue for registrations that arrived before observers were ready
  const pendingRegistrationsRef = useRef<PendingRegistration[]>([]);

  // Initialize two IntersectionObservers with batched updates
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      console.debug('[VirtualScroll] Waiting for scroll container ref...');
      return;
    }

    const containerHeight = Math.max(scrollContainer.clientHeight, MIN_VIEWPORT_HEIGHT);
    const outerMarginPx = Math.round(containerHeight * bufferScreens);
    const innerMarginPx = Math.round(containerHeight * (bufferScreens - 1));
    const outerRootMargin = `${outerMarginPx}px 0px`;
    const innerRootMargin = `${innerMarginPx}px 0px`;

    console.debug(
      `[VirtualScroll] Creating observers — outer: ${outerRootMargin}, inner: ${innerRootMargin}`,
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

    const intervalId = setInterval(applyPendingUpdates, VISIBILITY_SYNC_INTERVAL_MS);

    // Outer observer (bufferScreens zone): handles virtualization and initial detection
    const outerObserver = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          const messageId = entry.target.getAttribute('data-message-id');
          if (!messageId) return;

          if (!entry.isIntersecting) {
            // Left the outer zone → virtualize
            pendingUpdatesRef.current.set(messageId, false);
            console.debug('[VirtualScroll] Message %s LEAVING outer zone', messageId);
          } else if (!initializedIdsRef.current.has(messageId)) {
            // First detection within outer zone → render (handles 4–5 screen initial mount)
            initializedIdsRef.current.add(messageId);
            pendingUpdatesRef.current.set(messageId, true);
            console.debug('[VirtualScroll] Message %s INITIAL detection in outer zone', messageId);
          }
          // else: re-entering outer zone after initialization → ignore (hysteresis)
        });
      },
      {
        root: scrollContainer,
        rootMargin: outerRootMargin,
        threshold: 0,
      }
    );

    // Inner observer (bufferScreens-1 zone): handles re-rendering after virtualization
    const innerObserver = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          const messageId = entry.target.getAttribute('data-message-id');
          if (!messageId) return;

          if (entry.isIntersecting) {
            // Entered inner zone → render
            initializedIdsRef.current.add(messageId);
            pendingUpdatesRef.current.set(messageId, true);
            console.debug('[VirtualScroll] Message %s ENTERING inner zone', messageId);
          }
          // Leaving inner zone → ignore (outer observer handles virtualization)
        });
      },
      {
        root: scrollContainer,
        rootMargin: innerRootMargin,
        threshold: 0,
      }
    );

    outerObserverRef.current = outerObserver;
    innerObserverRef.current = innerObserver;

    // Process any registrations that arrived before observers were ready
    const pending = pendingRegistrationsRef.current;
    if (pending.length > 0) {
      console.debug(`[VirtualScroll] Processing ${pending.length} pending registrations`);
      for (const { messageId, element } of pending) {
        element.setAttribute('data-message-id', messageId);
        elementMapRef.current.set(messageId, element);
        outerObserver.observe(element);
        innerObserver.observe(element);
      }
      pendingRegistrationsRef.current = [];
    }

    return () => {
      clearInterval(intervalId);
      outerObserverRef.current?.disconnect();
      innerObserverRef.current?.disconnect();
      outerObserverRef.current = null;
      innerObserverRef.current = null;
    };
  }, [scrollContainerRef, bufferScreens]);

  // Register a message element for observation on both observers
  const registerMessage = useCallback((messageId: string, element: HTMLElement | null) => {
    const outerObserver = outerObserverRef.current;
    const innerObserver = innerObserverRef.current;

    // Unobserve and remove old element if it exists
    const oldElement = elementMapRef.current.get(messageId);
    if (oldElement) {
      outerObserver?.unobserve(oldElement);
      innerObserver?.unobserve(oldElement);
      elementMapRef.current.delete(messageId);
    }

    // Handle new element registration
    if (element) {
      if (outerObserver && innerObserver) {
        element.setAttribute('data-message-id', messageId);
        elementMapRef.current.set(messageId, element);
        outerObserver.observe(element);
        innerObserver.observe(element);
      } else {
        // Observers not ready — queue for later
        pendingRegistrationsRef.current.push({ messageId, element });
      }
    } else {
      // Unregistering — remove from initialized tracking
      initializedIdsRef.current.delete(messageId);
    }
  }, []);

  const measureHeight = useCallback((messageId: string, height: number) => {
    heightsRef.current.set(messageId, height);
  }, []);

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
