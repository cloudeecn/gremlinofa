import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** Interval for batching visibility updates to reduce re-renders during fast scrolling */
const VISIBILITY_SYNC_INTERVAL_MS = 200;

/** Minimum viewport height to use for buffer calculation (prevents tiny buffers on small screens) */
const MIN_VIEWPORT_HEIGHT = 600;

/**
 * Observers bake their pixel rootMargin in at construction, so they are rebuilt
 * when the container height (rotation, mobile keyboard, window resize) moves by
 * more than this fraction from the height they were built for.
 */
const RESIZE_REBUILD_THRESHOLD = 0.15;

const NO_HIDDEN_IDS: ReadonlySet<string> = new Set();

interface UseVirtualScrollReturn {
  /**
   * Messages the outer observer explicitly moved out of the buffer zone.
   * Anything not in here renders in full — including messages that were
   * never classified yet, so a new message can't flash as a placeholder.
   */
  hiddenMessageIds: ReadonlySet<string>;
  registerMessage: (messageId: string, element: HTMLElement | null) => void;
  measureHeight: (messageId: string, height: number) => void;
  getHeight: (messageId: string) => number | undefined;
  /** Registered element of a mounted message. */
  getElement: (messageId: string) => HTMLElement | undefined;
}

/** Pending registration that arrived before observers were ready */
interface PendingRegistration {
  messageId: string;
  element: HTMLElement;
}

function withoutId(ids: ReadonlySet<string>, messageId: string): ReadonlySet<string> {
  const next = new Set(ids);
  next.delete(messageId);
  return next;
}

/**
 * Hook for managing virtual scrolling of messages.
 * Uses two IntersectionObservers with asymmetric thresholds (hysteresis) to prevent
 * bounce at the buffer boundary. Messages virtualize when leaving the outer zone
 * and re-render when entering the inner zone, with a dead zone in between.
 *
 * @param scrollContainerRef - Ref to the scroll container element
 * @param bufferScreens - Number of screen heights for the outer buffer (default: 5). Inner buffer is bufferScreens - 1.
 * @param resetKey - Changing it un-hides everything and re-classifies every message.
 *   Pass the view options that change message heights, so placeholders never keep a stale height.
 */
export function useVirtualScroll(
  scrollContainerRef: RefObject<HTMLDivElement | null>,
  bufferScreens: number = 5,
  resetKey: string = ''
): UseVirtualScrollReturn {
  const [hiddenMessageIds, setHiddenMessageIds] = useState<ReadonlySet<string>>(NO_HIDDEN_IDS);
  const outerObserverRef = useRef<IntersectionObserver | null>(null);
  const innerObserverRef = useRef<IntersectionObserver | null>(null);
  const elementMapRef = useRef<Map<string, HTMLElement>>(new Map());
  const heightsRef = useRef<Map<string, number>>(new Map());

  // Tracks messages that have had their initial outer-observer detection,
  // so we can distinguish first-mount from re-entry in the hysteresis zone
  const initializedIdsRef = useRef<Set<string>>(new Set());

  // Pending hidden/shown updates accumulated between sync intervals (true = hidden)
  const pendingUpdatesRef = useRef<Map<string, boolean>>(new Map());

  // Queue for registrations that arrived before observers were ready
  const pendingRegistrationsRef = useRef<PendingRegistration[]>([]);

  // Container height the current observers were built for; null before the first build
  const builtForHeightRef = useRef<number | null>(null);
  const [observerGeneration, setObserverGeneration] = useState(0);
  const lastResetKeyRef = useRef(resetKey);

  // A reset un-hides everything in the same render the new key arrives in.
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey);
    setHiddenMessageIds(NO_HIDDEN_IDS);
  }

  // Rebuild the observers when the container height moves past the threshold
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const resizeObserver = new ResizeObserver(() => {
      const builtFor = builtForHeightRef.current;
      if (builtFor === null) return;
      const height = Math.max(scrollContainer.clientHeight, MIN_VIEWPORT_HEIGHT);
      if (Math.abs(height - builtFor) / builtFor > RESIZE_REBUILD_THRESHOLD) {
        setObserverGeneration(generation => generation + 1);
      }
    });
    resizeObserver.observe(scrollContainer);
    return () => resizeObserver.disconnect();
  }, [scrollContainerRef]);

  // Initialize two IntersectionObservers with batched updates
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      console.debug('[VirtualScroll] Waiting for scroll container ref...');
      return;
    }

    if (lastResetKeyRef.current !== resetKey) {
      lastResetKeyRef.current = resetKey;
      // Re-classify from scratch: the fresh observers report every element again
      initializedIdsRef.current.clear();
      pendingUpdatesRef.current.clear();
    }

    const containerHeight = Math.max(scrollContainer.clientHeight, MIN_VIEWPORT_HEIGHT);
    builtForHeightRef.current = containerHeight;
    const outerMarginPx = Math.round(containerHeight * bufferScreens);
    const innerMarginPx = Math.round(containerHeight * (bufferScreens - 1));
    const outerRootMargin = `${outerMarginPx}px 0px`;
    const innerRootMargin = `${innerMarginPx}px 0px`;

    console.debug(
      '[VirtualScroll] Creating observers — outer: %s, inner: %s (container: %dpx, buffer: %dx)',
      outerRootMargin,
      innerRootMargin,
      scrollContainer.clientHeight,
      bufferScreens
    );

    // Apply pending updates to state. Returning `prev` when nothing changed
    // lets React skip the MessageList re-render entirely.
    const applyPendingUpdates = () => {
      if (pendingUpdatesRef.current.size === 0) return;

      const updates = pendingUpdatesRef.current;
      pendingUpdatesRef.current = new Map();

      setHiddenMessageIds(prev => {
        let next: Set<string> | null = null;
        updates.forEach((hidden, messageId) => {
          if (prev.has(messageId) === hidden) return;
          next ??= new Set(prev);
          if (hidden) {
            next.add(messageId);
          } else {
            next.delete(messageId);
          }
        });
        return next ?? prev;
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
            pendingUpdatesRef.current.set(messageId, true);
            console.debug('[VirtualScroll] Message %s LEAVING outer zone', messageId);
          } else if (!initializedIdsRef.current.has(messageId)) {
            // First detection within outer zone → render (handles 4–5 screen initial mount)
            initializedIdsRef.current.add(messageId);
            pendingUpdatesRef.current.set(messageId, false);
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
            pendingUpdatesRef.current.set(messageId, false);
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

    // A rebuild re-observes every registered element; the fresh observers
    // report each one's current position.
    for (const element of elementMapRef.current.values()) {
      outerObserver.observe(element);
      innerObserver.observe(element);
    }

    // Process any registrations that arrived before observers were ready
    const pending = pendingRegistrationsRef.current;
    if (pending.length > 0) {
      console.debug('[VirtualScroll] Processing %d pending registrations', pending.length);
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
      outerObserver.disconnect();
      innerObserver.disconnect();
      outerObserverRef.current = null;
      innerObserverRef.current = null;
    };
  }, [scrollContainerRef, bufferScreens, resetKey, observerGeneration]);

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
      // Unmounted (deleted, or truncated by a reconnect). Forget everything so a
      // message that comes back with the same id starts out rendered, not as a
      // placeholder with a stale height.
      pendingRegistrationsRef.current = pendingRegistrationsRef.current.filter(
        registration => registration.messageId !== messageId
      );
      initializedIdsRef.current.delete(messageId);
      pendingUpdatesRef.current.delete(messageId);
      heightsRef.current.delete(messageId);
      setHiddenMessageIds(prev => (prev.has(messageId) ? withoutId(prev, messageId) : prev));
    }
  }, []);

  const measureHeight = useCallback((messageId: string, height: number) => {
    heightsRef.current.set(messageId, height);
  }, []);

  const getHeight = useCallback((messageId: string): number | undefined => {
    return heightsRef.current.get(messageId);
  }, []);

  const getElement = useCallback((messageId: string): HTMLElement | undefined => {
    return elementMapRef.current.get(messageId);
  }, []);

  return {
    hiddenMessageIds,
    registerMessage,
    measureHeight,
    getHeight,
    getElement,
  };
}
