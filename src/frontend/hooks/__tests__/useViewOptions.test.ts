import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useViewOptions } from '../useViewOptions';

describe('useViewOptions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('starts with everything off', () => {
    const { result } = renderHook(() => useViewOptions());
    expect(result.current.options).toEqual({ disableMath: false });
  });

  it('remembers toggles across mounts', () => {
    const first = renderHook(() => useViewOptions());
    act(() => first.result.current.toggle('disableMath'));
    first.unmount();

    const { result } = renderHook(() => useViewOptions());

    expect(result.current.options.disableMath).toBe(true);
  });

  it('ignores stored junk', () => {
    localStorage.setItem('chatViewOptions', '{"disableMath":true');
    expect(renderHook(() => useViewOptions()).result.current.options.disableMath).toBe(false);

    localStorage.setItem('chatViewOptions', '{"disableMath":"yes"}');
    expect(renderHook(() => useViewOptions()).result.current.options.disableMath).toBe(false);
  });

  it('drops options that no longer exist', () => {
    localStorage.setItem(
      'chatViewOptions',
      '{"focusMode":true,"expandMinions":true,"alwaysAutoScroll":true,"disableMath":true}'
    );

    const { result } = renderHook(() => useViewOptions());

    expect(result.current.options).toEqual({ disableMath: true });
    expect(JSON.parse(localStorage.getItem('chatViewOptions')!)).toEqual({ disableMath: true });
  });

  it('keeps working when storage throws', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    const { result } = renderHook(() => useViewOptions());
    act(() => result.current.toggle('disableMath'));

    expect(result.current.options.disableMath).toBe(true);
  });
});
