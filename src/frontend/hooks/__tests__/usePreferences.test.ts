import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePreferences } from '../usePreferences';

describe('usePreferences', () => {
  it('returns default preferences', () => {
    const { result } = renderHook(() => usePreferences());

    expect(result.current).toEqual({
      iconOnRight: true,
    });
  });

  it('returns stable reference across renders', () => {
    const { result, rerender } = renderHook(() => usePreferences());
    const firstResult = result.current;

    rerender();

    expect(result.current).toBe(firstResult);
  });
});
