import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useVirtualScroll } from '../useVirtualScroll';
import type { RefObject } from 'react';

// Note: The hook uses MIN_VIEWPORT_HEIGHT = 600 internally

/** Captured observer instance with its callback and options */
interface CapturedObserver {
  callback: IntersectionObserverCallback;
  options: IntersectionObserverInit | undefined;
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

describe('useVirtualScroll', () => {
  let capturedObservers: CapturedObserver[];
  let mockScrollContainer: HTMLDivElement;
  let mockScrollContainerRef: RefObject<HTMLDivElement>;

  /** Get outer observer (first created, larger rootMargin) */
  const getOuterObserver = () => capturedObservers[0];
  /** Get inner observer (second created, smaller rootMargin) */
  const getInnerObserver = () => capturedObservers[1];

  /** Fire an intersection entry on a specific observer */
  const fireEntry = (observer: CapturedObserver, element: HTMLElement, isIntersecting: boolean) => {
    observer.callback(
      [{ target: element, isIntersecting } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
  };

  beforeEach(() => {
    capturedObservers = [];

    mockScrollContainer = document.createElement('div');
    Object.defineProperty(mockScrollContainer, 'clientHeight', { value: 800 });
    mockScrollContainerRef = { current: mockScrollContainer };

    global.IntersectionObserver = class IntersectionObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        const captured: CapturedObserver = {
          callback,
          options,
          observe: vi.fn(),
          unobserve: vi.fn(),
          disconnect: vi.fn(),
        };
        capturedObservers.push(captured);
        this.observe = captured.observe;
        this.unobserve = captured.unobserve;
        this.disconnect = captured.disconnect;
      }
      observe: ReturnType<typeof vi.fn>;
      unobserve: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      takeRecords = vi.fn();
      root = null;
      rootMargin = '';
      thresholds = [];
    } as unknown as typeof IntersectionObserver;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic Functionality', () => {
    it('should return correct initial state (empty visibleMessageIds Set)', () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      expect(result.current.visibleMessageIds).toBeInstanceOf(Set);
      expect(result.current.visibleMessageIds.size).toBe(0);
      expect(typeof result.current.registerMessage).toBe('function');
      expect(typeof result.current.measureHeight).toBe('function');
      expect(typeof result.current.getHeight).toBe('function');
    });

    it('should add elements to both IntersectionObservers when registerMessage is called', () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);

      expect(getOuterObserver().observe).toHaveBeenCalledWith(mockElement);
      expect(getInnerObserver().observe).toHaveBeenCalledWith(mockElement);
      expect(mockElement.getAttribute('data-message-id')).toBe('msg-1');
    });

    it('should remove elements from both observers when registerMessage is called with null', () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);

      result.current.registerMessage('msg-1', null);
      expect(getOuterObserver().unobserve).toHaveBeenCalledWith(mockElement);
      expect(getInnerObserver().unobserve).toHaveBeenCalledWith(mockElement);
    });

    it('should replace old elements when registerMessage is called with same messageId', () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      const oldElement = document.createElement('div');
      const newElement = document.createElement('div');

      result.current.registerMessage('msg-1', oldElement);
      result.current.registerMessage('msg-1', newElement);

      expect(getOuterObserver().unobserve).toHaveBeenCalledWith(oldElement);
      expect(getInnerObserver().unobserve).toHaveBeenCalledWith(oldElement);
      expect(getOuterObserver().observe).toHaveBeenCalledWith(newElement);
      expect(getInnerObserver().observe).toHaveBeenCalledWith(newElement);
    });

    it('should store height in cache when measureHeight is called', () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      result.current.measureHeight('msg-1', 150);
      expect(result.current.getHeight('msg-1')).toBe(150);
    });

    it('should retrieve cached height correctly with getHeight', () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      result.current.measureHeight('msg-1', 200);
      result.current.measureHeight('msg-2', 300);

      expect(result.current.getHeight('msg-1')).toBe(200);
      expect(result.current.getHeight('msg-2')).toBe(300);
    });

    it('should return undefined for unmeasured messages with getHeight', () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      expect(result.current.getHeight('non-existent')).toBeUndefined();
    });
  });

  describe('Two-Observer Setup', () => {
    // With container clientHeight of 800px:
    // bufferScreens=5 -> outer: 4000px, inner: 3200px
    // bufferScreens=2 -> outer: 1600px, inner: 800px
    // bufferScreens=1 -> outer: 800px, inner: 0px (degenerate, but valid)

    it('should create two IntersectionObservers', () => {
      renderHook(() => useVirtualScroll(mockScrollContainerRef));
      expect(capturedObservers).toHaveLength(2);
    });

    it('should create outer observer with bufferScreens rootMargin and inner with bufferScreens-1', () => {
      renderHook(() => useVirtualScroll(mockScrollContainerRef));

      expect(getOuterObserver().options).toEqual({
        root: mockScrollContainer,
        rootMargin: '4000px 0px', // 800 * 5
        threshold: 0,
      });
      expect(getInnerObserver().options).toEqual({
        root: mockScrollContainer,
        rootMargin: '3200px 0px', // 800 * 4
        threshold: 0,
      });
    });

    it('should create correct rootMargins for bufferScreens=2', () => {
      renderHook(() => useVirtualScroll(mockScrollContainerRef, 2));

      expect(getOuterObserver().options?.rootMargin).toBe('1600px 0px'); // 800 * 2
      expect(getInnerObserver().options?.rootMargin).toBe('800px 0px'); // 800 * 1
    });

    it('should create correct rootMargins for bufferScreens=1', () => {
      renderHook(() => useVirtualScroll(mockScrollContainerRef, 1));

      expect(getOuterObserver().options?.rootMargin).toBe('800px 0px'); // 800 * 1
      expect(getInnerObserver().options?.rootMargin).toBe('0px 0px'); // 800 * 0
    });

    it('should use minimum height (600) when container clientHeight is smaller', () => {
      const smallContainer = document.createElement('div');
      Object.defineProperty(smallContainer, 'clientHeight', { value: 400 });
      const smallRef = { current: smallContainer };

      renderHook(() => useVirtualScroll(smallRef, 1));

      expect(getOuterObserver().options?.rootMargin).toBe('600px 0px'); // MIN_VIEWPORT_HEIGHT * 1
      expect(getInnerObserver().options?.rootMargin).toBe('0px 0px'); // MIN_VIEWPORT_HEIGHT * 0
    });

    it('should use scroll container as root for both observers', () => {
      renderHook(() => useVirtualScroll(mockScrollContainerRef));

      expect(getOuterObserver().options?.root).toBe(mockScrollContainer);
      expect(getInnerObserver().options?.root).toBe(mockScrollContainer);
    });
  });

  describe('Visibility via Inner Observer', () => {
    it('should add elements entering inner zone to visibleMessageIds', async () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);

      fireEntry(getInnerObserver(), mockElement, true);

      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(true);
      });
    });

    it('should handle multiple elements entering inner zone', async () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      const el1 = document.createElement('div');
      const el2 = document.createElement('div');
      const el3 = document.createElement('div');

      result.current.registerMessage('msg-1', el1);
      result.current.registerMessage('msg-2', el2);
      result.current.registerMessage('msg-3', el3);

      getInnerObserver().callback(
        [
          { target: el1, isIntersecting: true } as unknown as IntersectionObserverEntry,
          { target: el2, isIntersecting: true } as unknown as IntersectionObserverEntry,
          { target: el3, isIntersecting: true } as unknown as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver
      );

      await waitFor(() => {
        expect(result.current.visibleMessageIds.size).toBe(3);
      });
    });
  });

  describe('Virtualization via Outer Observer', () => {
    it('should remove elements leaving outer zone from visibleMessageIds', async () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);

      // Make visible via inner observer
      fireEntry(getInnerObserver(), mockElement, true);
      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(true);
      });

      // Virtualize via outer observer
      fireEntry(getOuterObserver(), mockElement, false);
      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(false);
      });
    });

    it('should make initially detected messages visible (first mount in 4–5 screen zone)', async () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);

      // Outer observer fires true for the first time → initial detection
      fireEntry(getOuterObserver(), mockElement, true);

      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(true);
      });
    });
  });

  describe('Hysteresis Behavior', () => {
    it('should ignore re-entry into outer zone after initialization (bounce protection)', async () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);

      // 1. Initial mount in inner zone → visible
      fireEntry(getInnerObserver(), mockElement, true);
      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(true);
      });

      // 2. Scroll away — leaves outer zone → virtualized
      fireEntry(getOuterObserver(), mockElement, false);
      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(false);
      });

      // 3. Scroll back to 4–5 screen range — outer fires true, but already initialized → ignored
      fireEntry(getOuterObserver(), mockElement, true);

      // Wait a tick and verify it stayed invisible
      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(false);
      });
    });

    it('should re-render when re-entering inner zone after virtualization', async () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);

      // 1. Make visible
      fireEntry(getInnerObserver(), mockElement, true);
      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(true);
      });

      // 2. Virtualize
      fireEntry(getOuterObserver(), mockElement, false);
      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(false);
      });

      // 3. Re-enter inner zone → visible again
      fireEntry(getInnerObserver(), mockElement, true);
      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(true);
      });
    });

    it('should not toggle state when rapidly bouncing at outer boundary', async () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);

      // Initial detection
      fireEntry(getInnerObserver(), mockElement, true);
      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(true);
      });

      // Virtualize
      fireEntry(getOuterObserver(), mockElement, false);
      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(false);
      });

      // Rapid bounce: outer true → outer false → outer true (all within one batch)
      fireEntry(getOuterObserver(), mockElement, true); // ignored (initialized)
      fireEntry(getOuterObserver(), mockElement, false); // virtualize
      fireEntry(getOuterObserver(), mockElement, true); // ignored (initialized)

      // The last effective update was the false, but the true after it is ignored,
      // so the pending update should be false
      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(false);
      });
    });

    it('should reset initialization tracking when unregistering a message', async () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);

      // Initialize
      fireEntry(getOuterObserver(), mockElement, true);
      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(true);
      });

      // Unregister — clears initialization tracking
      result.current.registerMessage('msg-1', null);

      // Re-register with new element
      const newElement = document.createElement('div');
      result.current.registerMessage('msg-1', newElement);

      // Outer true should work as initial detection again (not ignored)
      fireEntry(getOuterObserver(), newElement, true);
      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(true);
      });
    });
  });

  describe('Lifecycle', () => {
    it('should disconnect both observers on cleanup', () => {
      const { unmount } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      unmount();

      expect(getOuterObserver().disconnect).toHaveBeenCalled();
      expect(getInnerObserver().disconnect).toHaveBeenCalled();
    });

    it('should clear batching interval on unmount (no state updates after unmount)', async () => {
      vi.useFakeTimers();

      const { result, unmount } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);

      fireEntry(getInnerObserver(), mockElement, true);

      unmount();

      // Advance past the sync interval — should not cause errors
      vi.advanceTimersByTime(500);

      vi.useRealTimers();
    });

    it('should clear and recreate observers when bufferScreens changes', () => {
      vi.useFakeTimers();
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      const { rerender } = renderHook(({ ref, buffer }) => useVirtualScroll(ref, buffer), {
        initialProps: { ref: mockScrollContainerRef, buffer: 2 },
      });

      // Should have 2 observers initially
      expect(capturedObservers).toHaveLength(2);

      rerender({ ref: mockScrollContainerRef, buffer: 3 });

      // Old observers disconnected, new ones created (total 4 captured)
      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(capturedObservers).toHaveLength(4);

      clearIntervalSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should wait for scroll container ref before creating observers', () => {
      const nullRef = { current: null };

      renderHook(() => useVirtualScroll(nullRef));

      expect(capturedObservers).toHaveLength(0);
    });
  });

  describe('Pending Registration Queue', () => {
    it('should observe elements registered after observers are ready', () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);

      expect(getOuterObserver().observe).toHaveBeenCalledWith(mockElement);
      expect(getInnerObserver().observe).toHaveBeenCalledWith(mockElement);
      expect(mockElement.getAttribute('data-message-id')).toBe('msg-1');
    });

    it('should observe multiple elements registered sequentially', () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      const elements = [
        document.createElement('div'),
        document.createElement('div'),
        document.createElement('div'),
      ];

      elements.forEach((el, i) => {
        result.current.registerMessage(`msg-${i}`, el);
      });

      expect(getOuterObserver().observe).toHaveBeenCalledTimes(3);
      expect(getInnerObserver().observe).toHaveBeenCalledTimes(3);
      elements.forEach(el => {
        expect(getOuterObserver().observe).toHaveBeenCalledWith(el);
        expect(getInnerObserver().observe).toHaveBeenCalledWith(el);
      });
    });
  });
});
