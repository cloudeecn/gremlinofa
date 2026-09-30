import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useIsMobile } from '../useIsMobile';

describe('useIsMobile', () => {
  let matches: boolean;
  let listeners: Set<() => void>;
  let mockMatchMedia: ReturnType<typeof vi.fn>;

  const setMatches = (next: boolean) => {
    matches = next;
    act(() => {
      for (const listener of listeners) listener();
    });
  };

  beforeEach(() => {
    matches = false;
    listeners = new Set();
    mockMatchMedia = vi.fn(
      (query: string) =>
        ({
          get matches() {
            return matches;
          },
          media: query,
          addEventListener: (event: string, handler: () => void) => {
            if (event === 'change') listeners.add(handler);
          },
          removeEventListener: (event: string, handler: () => void) => {
            if (event === 'change') listeners.delete(handler);
          },
        }) as unknown as MediaQueryList
    );
    Object.defineProperty(window, 'matchMedia', { writable: true, value: mockMatchMedia });
  });

  it("queries Tailwind's md breakpoint in rem, not px", () => {
    renderHook(() => useIsMobile());
    // rem follows the browser's default font size, like Tailwind's
    // `@media (width >= 48rem)`; a px query would disagree at other sizes
    expect(mockMatchMedia).toHaveBeenCalledWith('(width < 48rem)');
    expect(mockMatchMedia.mock.calls.every(([query]) => query === '(width < 48rem)')).toBe(true);
  });

  it('reads the first value from the media query', () => {
    matches = true;
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it('follows media query changes both ways', () => {
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    setMatches(true);
    expect(result.current).toBe(true);

    setMatches(false);
    expect(result.current).toBe(false);
  });

  it('removes its listener on unmount', () => {
    const { unmount } = renderHook(() => useIsMobile());
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });
});
