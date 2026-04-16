import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useIsMobile } from '../useIsMobile';

describe('useIsMobile', () => {
  let mockMatchMedia: ReturnType<typeof vi.fn>;
  let listeners: Array<(e: MediaQueryListEvent) => void>;

  beforeEach(() => {
    listeners = [];
    mockMatchMedia = vi.fn((query: string) => {
      // Parse the breakpoint from the query string
      const match = query.match(/max-width:\s*(\d+)px/);
      const breakpoint = match ? parseInt(match[1], 10) + 1 : 768;
      const matches = window.innerWidth < breakpoint;

      return {
        matches,
        media: query,
        addEventListener: vi.fn((event: string, handler: (e: MediaQueryListEvent) => void) => {
          if (event === 'change') {
            listeners.push(handler);
          }
        }),
        removeEventListener: vi.fn((event: string, handler: (e: MediaQueryListEvent) => void) => {
          if (event === 'change') {
            const index = listeners.indexOf(handler);
            if (index > -1) {
              listeners.splice(index, 1);
            }
          }
        }),
        dispatchEvent: vi.fn(),
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
      } as unknown as MediaQueryList;
    });

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: mockMatchMedia,
    });
  });

  afterEach(() => {
    listeners = [];
    vi.restoreAllMocks();
  });

  describe('Initial State', () => {
    it('should return false when window width >= 768px', () => {
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 1024,
      });

      const { result } = renderHook(() => useIsMobile());

      expect(result.current).toBe(false);
    });

    it('should return true when window width < 768px', () => {
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 375,
      });

      const { result } = renderHook(() => useIsMobile());

      expect(result.current).toBe(true);
    });

    it('should use custom breakpoint when provided', () => {
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 900,
      });

      const { result } = renderHook(() => useIsMobile(1024));

      expect(result.current).toBe(true);
      expect(mockMatchMedia).toHaveBeenCalledWith('(max-width: 1023px)');
    });
  });

  describe('Media Query Updates', () => {
    it('should update when media query changes to mobile', async () => {
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 1024,
      });

      const { result } = renderHook(() => useIsMobile());

      expect(result.current).toBe(false);

      // Simulate media query change
      const event = { matches: true } as MediaQueryListEvent;
      listeners.forEach(listener => listener(event));

      await waitFor(() => {
        expect(result.current).toBe(true);
      });
    });

    it('should update when media query changes to desktop', async () => {
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 375,
      });

      const { result } = renderHook(() => useIsMobile());

      expect(result.current).toBe(true);

      // Simulate media query change
      const event = { matches: false } as MediaQueryListEvent;
      listeners.forEach(listener => listener(event));

      await waitFor(() => {
        expect(result.current).toBe(false);
      });
    });

    it('should register event listener on mount', () => {
      renderHook(() => useIsMobile());

      expect(mockMatchMedia).toHaveBeenCalledWith('(max-width: 767px)');
      expect(listeners).toHaveLength(1);
    });

    it('should clean up event listener on unmount', () => {
      const { unmount } = renderHook(() => useIsMobile());

      expect(listeners).toHaveLength(1);

      unmount();

      expect(listeners).toHaveLength(0);
    });

    it('should re-register listener when breakpoint changes', async () => {
      const { rerender } = renderHook(({ breakpoint }) => useIsMobile(breakpoint), {
        initialProps: { breakpoint: 768 },
      });

      expect(mockMatchMedia).toHaveBeenCalledWith('(max-width: 767px)');

      rerender({ breakpoint: 1024 });

      await waitFor(() => {
        expect(mockMatchMedia).toHaveBeenCalledWith('(max-width: 1023px)');
      });
    });
  });

  describe('Multiple Instances', () => {
    it('should handle multiple hook instances independently', async () => {
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 800,
      });

      const { result: result1 } = renderHook(() => useIsMobile(768));
      const { result: result2 } = renderHook(() => useIsMobile(1024));

      expect(result1.current).toBe(false); // 800 >= 768
      expect(result2.current).toBe(true); // 800 < 1024

      // Both should update independently
      const event1 = { matches: true } as MediaQueryListEvent;
      const event2 = { matches: false } as MediaQueryListEvent;

      if (listeners[0]) listeners[0](event1);
      if (listeners[1]) listeners[1](event2);

      await waitFor(() => {
        expect(result1.current).toBe(true);
        expect(result2.current).toBe(false);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle very large breakpoint', () => {
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 5000,
      });

      const { result } = renderHook(() => useIsMobile(10000));

      expect(result.current).toBe(true);
      expect(mockMatchMedia).toHaveBeenCalledWith('(max-width: 9999px)');
    });

    it('should handle rapid changes without errors', async () => {
      const { result } = renderHook(() => useIsMobile());

      // Simulate rapid changes
      for (let i = 0; i < 10; i++) {
        const event = { matches: i % 2 === 0 } as MediaQueryListEvent;
        listeners.forEach(listener => listener(event));
      }

      await waitFor(() => {
        expect(result.current).toBe(false); // Last event was i=9 (odd), matches=false
      });
    });
  });
});
