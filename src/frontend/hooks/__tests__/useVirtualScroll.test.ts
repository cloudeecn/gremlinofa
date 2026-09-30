import { act, renderHook, waitFor } from '@testing-library/react';
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
  let resizeCallbacks: ResizeObserverCallback[];
  let containerHeight: number;
  let mockScrollContainer: HTMLDivElement;
  let mockScrollContainerRef: RefObject<HTMLDivElement>;

  /** Outer observer of the latest build (larger rootMargin) */
  const getOuterObserver = () => capturedObservers[capturedObservers.length - 2];
  /** Inner observer of the latest build (smaller rootMargin) */
  const getInnerObserver = () => capturedObservers[capturedObservers.length - 1];

  /** Fire an intersection entry on a specific observer */
  const fireEntry = (observer: CapturedObserver, element: HTMLElement, isIntersecting: boolean) => {
    observer.callback(
      [{ target: element, isIntersecting } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
  };

  /** Register an element and move it out of the outer zone, waiting for the flush */
  const registerAndHide = async (
    result: { current: ReturnType<typeof useVirtualScroll> },
    messageId: string
  ) => {
    const element = document.createElement('div');
    act(() => result.current.registerMessage(messageId, element));
    fireEntry(getOuterObserver(), element, true); // initial detection
    fireEntry(getOuterObserver(), element, false); // scrolled far away
    await waitFor(() => expect(result.current.hiddenMessageIds.has(messageId)).toBe(true));
    return element;
  };

  const resizeContainer = (height: number) => {
    containerHeight = height;
    act(() => {
      resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver));
    });
  };

  beforeEach(() => {
    capturedObservers = [];
    resizeCallbacks = [];
    containerHeight = 800;

    mockScrollContainer = document.createElement('div');
    Object.defineProperty(mockScrollContainer, 'clientHeight', { get: () => containerHeight });
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

    global.ResizeObserver = class ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('Basic Functionality', () => {
    it('starts with nothing hidden', () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      expect(result.current.hiddenMessageIds.size).toBe(0);
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

      act(() => result.current.registerMessage('msg-1', null));
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

    it('should store and retrieve heights', () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      result.current.measureHeight('msg-1', 200);
      result.current.measureHeight('msg-2', 300);

      expect(result.current.getHeight('msg-1')).toBe(200);
      expect(result.current.getHeight('msg-2')).toBe(300);
      expect(result.current.getHeight('non-existent')).toBeUndefined();
    });

    it('returns the registered element of a mounted message', () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));
      const element = document.createElement('div');

      act(() => result.current.registerMessage('msg-1', element));
      expect(result.current.getElement('msg-1')).toBe(element);

      act(() => result.current.registerMessage('msg-1', null));
      expect(result.current.getElement('msg-1')).toBeUndefined();
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
      containerHeight = 400;

      renderHook(() => useVirtualScroll(mockScrollContainerRef, 1));

      expect(getOuterObserver().options?.rootMargin).toBe('600px 0px'); // MIN_VIEWPORT_HEIGHT * 1
      expect(getInnerObserver().options?.rootMargin).toBe('0px 0px'); // MIN_VIEWPORT_HEIGHT * 0
    });

    it('should use scroll container as root for both observers', () => {
      renderHook(() => useVirtualScroll(mockScrollContainerRef));

      expect(getOuterObserver().options?.root).toBe(mockScrollContainer);
      expect(getInnerObserver().options?.root).toBe(mockScrollContainer);
    });
  });

  describe('Hiding via Outer Observer', () => {
    it('hides elements leaving the outer zone', async () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));
      await registerAndHide(result, 'msg-1');
    });

    it('never hides a message that was only detected inside the buffer', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);
      fireEntry(getOuterObserver(), mockElement, true);
      fireEntry(getInnerObserver(), mockElement, true);
      act(() => vi.advanceTimersByTime(250));

      expect(result.current.hiddenMessageIds.has('msg-1')).toBe(false);
    });
  });

  describe('Showing via Inner Observer', () => {
    it('shows a hidden element again when it enters the inner zone', async () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));
      const element = await registerAndHide(result, 'msg-1');

      fireEntry(getInnerObserver(), element, true);
      await waitFor(() => expect(result.current.hiddenMessageIds.has('msg-1')).toBe(false));
    });

    it('should handle multiple elements entering inner zone', async () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));
      const el1 = await registerAndHide(result, 'msg-1');
      const el2 = await registerAndHide(result, 'msg-2');
      const el3 = await registerAndHide(result, 'msg-3');
      expect(result.current.hiddenMessageIds.size).toBe(3);

      getInnerObserver().callback(
        [
          { target: el1, isIntersecting: true } as unknown as IntersectionObserverEntry,
          { target: el2, isIntersecting: true } as unknown as IntersectionObserverEntry,
          { target: el3, isIntersecting: true } as unknown as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver
      );

      await waitFor(() => expect(result.current.hiddenMessageIds.size).toBe(0));
    });
  });

  describe('Hysteresis Behavior', () => {
    it('should ignore re-entry into outer zone after initialization (bounce protection)', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);
      fireEntry(getInnerObserver(), mockElement, true);
      fireEntry(getOuterObserver(), mockElement, false);
      act(() => vi.advanceTimersByTime(250));
      expect(result.current.hiddenMessageIds.has('msg-1')).toBe(true);

      // Back in the 4–5 screen range: outer fires true, but already initialized → ignored
      fireEntry(getOuterObserver(), mockElement, true);
      act(() => vi.advanceTimersByTime(250));
      expect(result.current.hiddenMessageIds.has('msg-1')).toBe(true);
    });

    it('should not toggle state when rapidly bouncing at outer boundary', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);
      fireEntry(getInnerObserver(), mockElement, true);
      fireEntry(getOuterObserver(), mockElement, false);
      act(() => vi.advanceTimersByTime(250));

      // Rapid bounce within one batch: the trues are ignored (initialized)
      fireEntry(getOuterObserver(), mockElement, true);
      fireEntry(getOuterObserver(), mockElement, false);
      fireEntry(getOuterObserver(), mockElement, true);
      act(() => vi.advanceTimersByTime(250));

      expect(result.current.hiddenMessageIds.has('msg-1')).toBe(true);
    });
  });

  describe('Batching', () => {
    it('keeps the same Set when a flush changes nothing (no re-render)', () => {
      vi.useFakeTimers();
      let renders = 0;
      const { result } = renderHook(() => {
        renders++;
        return useVirtualScroll(mockScrollContainerRef);
      });

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);
      const before = result.current.hiddenMessageIds;
      const rendersBefore = renders;

      // Visible → visible: nothing to change
      fireEntry(getOuterObserver(), mockElement, true);
      fireEntry(getInnerObserver(), mockElement, true);
      act(() => vi.advanceTimersByTime(250));

      expect(result.current.hiddenMessageIds).toBe(before);
      expect(renders).toBe(rendersBefore);
    });
  });

  describe('Unregistering', () => {
    it('forgets height, hidden flag and initialization of an unmounted message', async () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));
      await registerAndHide(result, 'msg-1');
      result.current.measureHeight('msg-1', 150);

      act(() => result.current.registerMessage('msg-1', null));

      expect(result.current.hiddenMessageIds.has('msg-1')).toBe(false);
      expect(result.current.getHeight('msg-1')).toBeUndefined();

      // A message coming back with the same id is detected from scratch
      const newElement = document.createElement('div');
      act(() => result.current.registerMessage('msg-1', newElement));
      fireEntry(getOuterObserver(), newElement, true);
      fireEntry(getOuterObserver(), newElement, false);
      await waitFor(() => expect(result.current.hiddenMessageIds.has('msg-1')).toBe(true));
    });

    it('drops pending updates for an unmounted message', () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);
      fireEntry(getOuterObserver(), mockElement, false);
      act(() => result.current.registerMessage('msg-1', null));
      act(() => vi.advanceTimersByTime(250));

      expect(result.current.hiddenMessageIds.has('msg-1')).toBe(false);
    });
  });

  describe('Rebuilds', () => {
    it('rebuilds the observers with new margins when the container resizes past the threshold', () => {
      const { result } = renderHook(() => useVirtualScroll(mockScrollContainerRef));
      const elements = [document.createElement('div'), document.createElement('div')];
      elements.forEach((element, i) => result.current.registerMessage(`msg-${i}`, element));
      expect(capturedObservers).toHaveLength(2);

      // 800 → 880 is within 15%: no rebuild
      resizeContainer(880);
      expect(capturedObservers).toHaveLength(2);

      // 800 → 1200: rebuild with new margins, re-observing every element
      resizeContainer(1200);
      expect(capturedObservers).toHaveLength(4);
      expect(getOuterObserver().options?.rootMargin).toBe('6000px 0px');
      expect(getInnerObserver().options?.rootMargin).toBe('4800px 0px');
      elements.forEach(element => {
        expect(getOuterObserver().observe).toHaveBeenCalledWith(element);
        expect(getInnerObserver().observe).toHaveBeenCalledWith(element);
      });
    });

    it('un-hides everything and re-classifies when resetKey changes', async () => {
      const { result, rerender } = renderHook(
        ({ resetKey }) => useVirtualScroll(mockScrollContainerRef, 5, resetKey),
        { initialProps: { resetKey: 'a' } }
      );
      const element = await registerAndHide(result, 'msg-1');

      rerender({ resetKey: 'b' });

      expect(result.current.hiddenMessageIds.size).toBe(0);
      expect(getOuterObserver().observe).toHaveBeenCalledWith(element);
      // Fresh classification: first outer detection counts as initial again
      fireEntry(getOuterObserver(), element, true);
      fireEntry(getOuterObserver(), element, false);
      await waitFor(() => expect(result.current.hiddenMessageIds.has('msg-1')).toBe(true));
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

      fireEntry(getOuterObserver(), mockElement, false);

      unmount();

      // Advance past the sync interval — should not cause errors
      vi.advanceTimersByTime(500);
    });

    it('should clear and recreate observers when bufferScreens changes', () => {
      vi.useFakeTimers();
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      const { rerender } = renderHook(({ ref, buffer }) => useVirtualScroll(ref, buffer), {
        initialProps: { ref: mockScrollContainerRef, buffer: 2 },
      });

      expect(capturedObservers).toHaveLength(2);

      rerender({ ref: mockScrollContainerRef, buffer: 3 });

      // Old observers disconnected, new ones created (total 4 captured)
      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(capturedObservers).toHaveLength(4);

      clearIntervalSpy.mockRestore();
    });

    it('should wait for scroll container ref before creating observers', () => {
      const nullRef = { current: null };

      renderHook(() => useVirtualScroll(nullRef));

      expect(capturedObservers).toHaveLength(0);
    });
  });

  describe('Pending Registration Queue', () => {
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
