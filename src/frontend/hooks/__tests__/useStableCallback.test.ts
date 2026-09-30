import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStableCallback } from '../useStableCallback';

describe('useStableCallback', () => {
  it('keeps the same identity across renders', () => {
    const { result, rerender } = renderHook(({ n }) => useStableCallback(() => n), {
      initialProps: { n: 1 },
    });
    const first = result.current;
    rerender({ n: 2 });
    expect(result.current).toBe(first);
  });

  it('calls the latest function with the given arguments', () => {
    const { result, rerender } = renderHook(
      ({ offset }) => useStableCallback((a: number, b: number) => a + b + offset),
      { initialProps: { offset: 0 } }
    );
    expect(result.current(1, 2)).toBe(3);
    rerender({ offset: 10 });
    expect(result.current(1, 2)).toBe(13);
  });
});
