import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useVirtualScroll } from '../useVirtualScroll';

describe('useVirtualScroll', () => {
  let mockObserver: {
    observe: ReturnType<typeof vi.fn>;
    unobserve: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
  let observerCallback: IntersectionObserverCallback;
  let observerOptions: IntersectionObserverInit | undefined;

  beforeEach(() => {
    // Mock IntersectionObserver
    mockObserver = {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    };

    global.IntersectionObserver = class IntersectionObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        observerCallback = callback;
        observerOptions = options;
      }
      observe = mockObserver.observe;
      unobserve = mockObserver.unobserve;
      disconnect = mockObserver.disconnect;
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
      const { result } = renderHook(() => useVirtualScroll());

      expect(result.current.visibleMessageIds).toBeInstanceOf(Set);
      expect(result.current.visibleMessageIds.size).toBe(0);
      expect(typeof result.current.registerMessage).toBe('function');
      expect(typeof result.current.measureHeight).toBe('function');
      expect(typeof result.current.getHeight).toBe('function');
    });

    it('should add elements to IntersectionObserver when registerMessage is called', () => {
      const { result } = renderHook(() => useVirtualScroll());

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);

      expect(mockObserver.observe).toHaveBeenCalledWith(mockElement);
      expect(mockElement.getAttribute('data-message-id')).toBe('msg-1');
    });

    it('should remove elements from IntersectionObserver when registerMessage is called with null', () => {
      const { result } = renderHook(() => useVirtualScroll());

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);
      expect(mockObserver.observe).toHaveBeenCalledWith(mockElement);

      result.current.registerMessage('msg-1', null);
      expect(mockObserver.unobserve).toHaveBeenCalledWith(mockElement);
    });

    it('should replace old elements when registerMessage is called with same messageId', () => {
      const { result } = renderHook(() => useVirtualScroll());

      const oldElement = document.createElement('div');
      const newElement = document.createElement('div');

      result.current.registerMessage('msg-1', oldElement);
      expect(mockObserver.observe).toHaveBeenCalledWith(oldElement);

      result.current.registerMessage('msg-1', newElement);
      expect(mockObserver.unobserve).toHaveBeenCalledWith(oldElement);
      expect(mockObserver.observe).toHaveBeenCalledWith(newElement);
    });

    it('should store height in cache when measureHeight is called', () => {
      const { result } = renderHook(() => useVirtualScroll());

      result.current.measureHeight('msg-1', 150);
      expect(result.current.getHeight('msg-1')).toBe(150);
    });

    it('should retrieve cached height correctly with getHeight', () => {
      const { result } = renderHook(() => useVirtualScroll());

      result.current.measureHeight('msg-1', 200);
      result.current.measureHeight('msg-2', 300);

      expect(result.current.getHeight('msg-1')).toBe(200);
      expect(result.current.getHeight('msg-2')).toBe(300);
    });

    it('should return undefined for unmeasured messages with getHeight', () => {
      const { result } = renderHook(() => useVirtualScroll());

      expect(result.current.getHeight('non-existent')).toBeUndefined();
    });
  });

  describe('Virtual Scrolling Specific', () => {
    it('should create IntersectionObserver with correct rootMargin for bufferScreens=1', () => {
      renderHook(() => useVirtualScroll(1));

      expect(observerOptions).toEqual({
        root: null,
        rootMargin: '100% 0px',
        threshold: 0,
      });
    });

    it('should create IntersectionObserver with correct rootMargin for bufferScreens=2', () => {
      renderHook(() => useVirtualScroll(2));

      expect(observerOptions).toEqual({
        root: null,
        rootMargin: '200% 0px',
        threshold: 0,
      });
    });

    it('should create IntersectionObserver with default bufferScreens=5 when not specified', () => {
      renderHook(() => useVirtualScroll());

      expect(observerOptions).toEqual({
        root: null,
        rootMargin: '500% 0px',
        threshold: 0,
      });
    });

    it('should add elements entering viewport to visibleMessageIds', async () => {
      const { result } = renderHook(() => useVirtualScroll());

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);

      // Simulate element entering viewport
      const entry: Partial<IntersectionObserverEntry> = {
        target: mockElement,
        isIntersecting: true,
      };

      observerCallback(
        [entry as unknown as IntersectionObserverEntry],
        mockObserver as unknown as IntersectionObserver
      );

      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(true);
      });
    });

    it('should remove elements leaving buffer zone from visibleMessageIds', async () => {
      const { result } = renderHook(() => useVirtualScroll());

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);

      // Simulate element entering viewport
      observerCallback(
        [
          {
            target: mockElement,
            isIntersecting: true,
          } as unknown as IntersectionObserverEntry,
        ],
        mockObserver as unknown as IntersectionObserver
      );

      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(true);
      });

      // Simulate element leaving viewport
      observerCallback(
        [
          {
            target: mockElement,
            isIntersecting: false,
          } as unknown as IntersectionObserverEntry,
        ],
        mockObserver as unknown as IntersectionObserver
      );

      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(false);
      });
    });

    it('should handle multiple elements being visible simultaneously', async () => {
      const { result } = renderHook(() => useVirtualScroll());

      const element1 = document.createElement('div');
      const element2 = document.createElement('div');
      const element3 = document.createElement('div');

      result.current.registerMessage('msg-1', element1);
      result.current.registerMessage('msg-2', element2);
      result.current.registerMessage('msg-3', element3);

      // Simulate all elements entering viewport
      observerCallback(
        [
          { target: element1, isIntersecting: true } as unknown as IntersectionObserverEntry,
          { target: element2, isIntersecting: true } as unknown as IntersectionObserverEntry,
          { target: element3, isIntersecting: true } as unknown as IntersectionObserverEntry,
        ],
        mockObserver as unknown as IntersectionObserver
      );

      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(true);
        expect(result.current.visibleMessageIds.has('msg-2')).toBe(true);
        expect(result.current.visibleMessageIds.has('msg-3')).toBe(true);
        expect(result.current.visibleMessageIds.size).toBe(3);
      });
    });

    it('should update visibleMessageIds Set correctly with multiple intersection changes', async () => {
      const { result } = renderHook(() => useVirtualScroll());

      const element1 = document.createElement('div');
      const element2 = document.createElement('div');

      result.current.registerMessage('msg-1', element1);
      result.current.registerMessage('msg-2', element2);

      // First batch: msg-1 enters, msg-2 leaves
      observerCallback(
        [
          { target: element1, isIntersecting: true } as unknown as IntersectionObserverEntry,
          { target: element2, isIntersecting: false } as unknown as IntersectionObserverEntry,
        ],
        mockObserver as unknown as IntersectionObserver
      );

      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(true);
        expect(result.current.visibleMessageIds.has('msg-2')).toBe(false);
      });

      // Second batch: msg-1 leaves, msg-2 enters
      observerCallback(
        [
          { target: element1, isIntersecting: false } as unknown as IntersectionObserverEntry,
          { target: element2, isIntersecting: true } as unknown as IntersectionObserverEntry,
        ],
        mockObserver as unknown as IntersectionObserver
      );

      await waitFor(() => {
        expect(result.current.visibleMessageIds.has('msg-1')).toBe(false);
        expect(result.current.visibleMessageIds.has('msg-2')).toBe(true);
      });
    });

    it('should disconnect observer on cleanup', () => {
      const { unmount } = renderHook(() => useVirtualScroll());

      unmount();

      expect(mockObserver.disconnect).toHaveBeenCalled();
    });

    it('should clear batching interval on unmount (no state updates after unmount)', async () => {
      vi.useFakeTimers();

      const { result, unmount } = renderHook(() => useVirtualScroll());

      const mockElement = document.createElement('div');
      result.current.registerMessage('msg-1', mockElement);

      // Trigger a visibility change that gets queued
      observerCallback(
        [{ target: mockElement, isIntersecting: true } as unknown as IntersectionObserverEntry],
        mockObserver as unknown as IntersectionObserver
      );

      // Unmount before the interval fires
      unmount();

      // Advance past the sync interval - should not cause errors
      vi.advanceTimersByTime(500);

      // Test passes if no "state update on unmounted component" errors occur
      vi.useRealTimers();
    });

    it('should clear and recreate interval when bufferScreens changes', () => {
      vi.useFakeTimers();
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      const { rerender } = renderHook(({ buffer }) => useVirtualScroll(buffer), {
        initialProps: { buffer: 2 },
      });

      // Change bufferScreens - should clear old interval and create new one
      rerender({ buffer: 3 });

      expect(clearIntervalSpy).toHaveBeenCalled();

      clearIntervalSpy.mockRestore();
      vi.useRealTimers();
    });
  });
});
