import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useViewOptions } from '../useViewOptions';

describe('useViewOptions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts with everything off', () => {
    const { result } = renderHook(() => useViewOptions());
    expect(result.current.options).toEqual({
      focusMode: false,
      expandMinions: false,
      disableMath: false,
      alwaysAutoScroll: false,
    });
  });

  it('remembers toggles across mounts', () => {
    const first = renderHook(() => useViewOptions());
    act(() => first.result.current.toggle('focusMode'));
    act(() => first.result.current.toggle('disableMath'));
    first.unmount();

    const { result } = renderHook(() => useViewOptions());

    expect(result.current.options).toMatchObject({ focusMode: true, disableMath: true });
    expect(result.current.options.expandMinions).toBe(false);
  });

  it('ignores stored junk', () => {
    localStorage.setItem('chatViewOptions', '{"focusMode":"yes","disableMath":true');
    expect(renderHook(() => useViewOptions()).result.current.options.disableMath).toBe(false);

    localStorage.setItem('chatViewOptions', '{"focusMode":"yes","disableMath":true}');
    expect(renderHook(() => useViewOptions()).result.current.options).toMatchObject({
      focusMode: false,
      disableMath: true,
    });
  });

  it('keeps working when storage throws', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    const { result } = renderHook(() => useViewOptions());
    act(() => result.current.toggle('alwaysAutoScroll'));

    expect(result.current.options.alwaysAutoScroll).toBe(true);
  });
});
