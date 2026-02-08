import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useIsKeyboardVisible } from '../useIsKeyboardVisible';

describe('useIsKeyboardVisible', () => {
  let resizeListeners: Array<() => void>;
  let mockViewport: { height: number; width: number };

  function createMockVisualViewport(height: number, width: number) {
    mockViewport = { height, width };
    resizeListeners = [];

    return {
      get height() {
        return mockViewport.height;
      },
      get width() {
        return mockViewport.width;
      },
      offsetLeft: 0,
      offsetTop: 0,
      pageLeft: 0,
      pageTop: 0,
      scale: 1,
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === 'resize') resizeListeners.push(handler);
      }),
      removeEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === 'resize') {
          const idx = resizeListeners.indexOf(handler);
          if (idx > -1) resizeListeners.splice(idx, 1);
        }
      }),
      dispatchEvent: vi.fn(),
      onresize: null,
      onscroll: null,
      onscrollend: null,
    } as unknown as VisualViewport;
  }

  function simulateResize(height: number, width?: number) {
    mockViewport.height = height;
    if (width !== undefined) mockViewport.width = width;
    act(() => {
      resizeListeners.forEach(listener => listener());
    });
  }

  beforeEach(() => {
    resizeListeners = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Keyboard Detection', () => {
    it('should return false initially', () => {
      Object.defineProperty(window, 'visualViewport', {
        writable: true,
        configurable: true,
        value: createMockVisualViewport(800, 390),
      });

      const { result } = renderHook(() => useIsKeyboardVisible());
      expect(result.current).toBe(false);
    });

    it('should detect keyboard open when height drops below 75% of max', () => {
      Object.defineProperty(window, 'visualViewport', {
        writable: true,
        configurable: true,
        value: createMockVisualViewport(800, 390),
      });

      const { result } = renderHook(() => useIsKeyboardVisible());

      // Keyboard opens: 800 → 450 (56% of max, below 75%)
      simulateResize(450);
      expect(result.current).toBe(true);
    });

    it('should detect keyboard close when height returns near max', () => {
      Object.defineProperty(window, 'visualViewport', {
        writable: true,
        configurable: true,
        value: createMockVisualViewport(800, 390),
      });

      const { result } = renderHook(() => useIsKeyboardVisible());

      simulateResize(450);
      expect(result.current).toBe(true);

      // Keyboard closes: back to 800
      simulateResize(800);
      expect(result.current).toBe(false);
    });

    it('should handle partial keyboard (e.g. emoji picker)', () => {
      Object.defineProperty(window, 'visualViewport', {
        writable: true,
        configurable: true,
        value: createMockVisualViewport(800, 390),
      });

      const { result } = renderHook(() => useIsKeyboardVisible());

      // Emoji picker takes less space: 800 → 550 (68%, still below 75%)
      simulateResize(550);
      expect(result.current).toBe(true);
    });
  });

  describe('Address Bar Changes', () => {
    it('should not false-positive on address bar show/hide (~5-10% change)', () => {
      Object.defineProperty(window, 'visualViewport', {
        writable: true,
        configurable: true,
        value: createMockVisualViewport(800, 390),
      });

      const { result } = renderHook(() => useIsKeyboardVisible());

      // Address bar appears: 800 → 760 (95% of max)
      simulateResize(760);
      expect(result.current).toBe(false);
    });

    it('should update max height when address bar hides (height increases)', () => {
      Object.defineProperty(window, 'visualViewport', {
        writable: true,
        configurable: true,
        value: createMockVisualViewport(760, 390),
      });

      const { result } = renderHook(() => useIsKeyboardVisible());

      // Address bar hides: 760 → 800 (new max)
      simulateResize(800);
      expect(result.current).toBe(false);

      // Now keyboard open: 800 → 450 (56% of new max)
      simulateResize(450);
      expect(result.current).toBe(true);
    });
  });

  describe('Orientation Change', () => {
    it('should reset baseline when width changes >100px', () => {
      Object.defineProperty(window, 'visualViewport', {
        writable: true,
        configurable: true,
        value: createMockVisualViewport(800, 390),
      });

      const { result } = renderHook(() => useIsKeyboardVisible());

      // Rotate to landscape: width 390→844, height 800→390
      // Without orientation reset, 390 < 800*0.75=600 would false-positive
      simulateResize(390, 844);
      expect(result.current).toBe(false);
    });

    it('should detect keyboard correctly after orientation change', () => {
      Object.defineProperty(window, 'visualViewport', {
        writable: true,
        configurable: true,
        value: createMockVisualViewport(800, 390),
      });

      const { result } = renderHook(() => useIsKeyboardVisible());

      // Rotate to landscape
      simulateResize(390, 844);
      expect(result.current).toBe(false);

      // Keyboard opens in landscape: 390 → 200 (51% of new 390 max)
      simulateResize(200);
      expect(result.current).toBe(true);
    });
  });

  describe('Missing VisualViewport API', () => {
    it('should return false when VisualViewport is unavailable', () => {
      Object.defineProperty(window, 'visualViewport', {
        writable: true,
        configurable: true,
        value: null,
      });

      const { result } = renderHook(() => useIsKeyboardVisible());
      expect(result.current).toBe(false);
    });
  });

  describe('Lifecycle', () => {
    it('should register resize listener on mount', () => {
      const vv = createMockVisualViewport(800, 390);
      Object.defineProperty(window, 'visualViewport', {
        writable: true,
        configurable: true,
        value: vv,
      });

      renderHook(() => useIsKeyboardVisible());
      expect(resizeListeners).toHaveLength(1);
    });

    it('should clean up resize listener on unmount', () => {
      const vv = createMockVisualViewport(800, 390);
      Object.defineProperty(window, 'visualViewport', {
        writable: true,
        configurable: true,
        value: vv,
      });

      const { unmount } = renderHook(() => useIsKeyboardVisible());
      expect(resizeListeners).toHaveLength(1);

      unmount();
      expect(resizeListeners).toHaveLength(0);
    });
  });
});
