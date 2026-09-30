import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { useImeSafeEnter } from '../useImeSafeEnter';

function Field({ onSubmit }: { onSubmit: () => void }) {
  const { onCompositionEnd, isImeEnter } = useImeSafeEnter();
  return (
    <input
      aria-label="field"
      onCompositionEnd={onCompositionEnd}
      onKeyDown={e => {
        if (isImeEnter(e)) return;
        if (e.key === 'Enter') onSubmit();
      }}
    />
  );
}

describe('useImeSafeEnter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets a plain Enter through', () => {
    const onSubmit = vi.fn();
    const { getByLabelText } = render(<Field onSubmit={onSubmit} />);
    fireEvent.keyDown(getByLabelText('field'), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('ignores an Enter while composing', () => {
    const onSubmit = vi.fn();
    const { getByLabelText } = render(<Field onSubmit={onSubmit} />);
    fireEvent.keyDown(getByLabelText('field'), { key: 'Enter', isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ignores the Enter right after compositionend, then recovers on the next frame', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
      frames.push(cb);
      return frames.length;
    });
    const onSubmit = vi.fn();
    const { getByLabelText } = render(<Field onSubmit={onSubmit} />);
    const field = getByLabelText('field');

    fireEvent.compositionEnd(field);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();

    act(() => frames.forEach(cb => cb(0)));
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
