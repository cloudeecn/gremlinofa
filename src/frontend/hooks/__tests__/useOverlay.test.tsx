import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState, type ReactNode } from 'react';
import { overlayStackDepth, useOverlay } from '../useOverlay';

function Layer({
  name,
  onEscape,
  trapFocus = false,
  restoreFocus = false,
  children,
}: {
  name: string;
  onEscape: () => void;
  trapFocus?: boolean;
  restoreFocus?: boolean;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOverlay({ active: true, onEscape, containerRef: ref, trapFocus, restoreFocus });
  return (
    <div ref={ref} tabIndex={-1} data-testid={name}>
      {children}
    </div>
  );
}

describe('useOverlay', () => {
  afterEach(() => {
    cleanup();
    expect(overlayStackDepth()).toBe(0);
  });

  it('sends Escape only to the top layer', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <Layer name="outer" onEscape={outer}>
        <button>outer button</button>
      </Layer>
    );
    const { unmount } = render(<Layer name="inner" onEscape={inner} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();

    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape alone while an IME is composing or a field handled it', () => {
    const onEscape = vi.fn();
    render(
      <Layer name="layer" onEscape={onEscape}>
        <input
          aria-label="field"
          onKeyDown={e => {
            if (e.key === 'Escape') e.preventDefault();
          }}
        />
      </Layer>
    );

    fireEvent.keyDown(document, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(screen.getByLabelText('field'), { key: 'Escape' });

    expect(onEscape).not.toHaveBeenCalled();
  });

  it('calls the latest onEscape', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Layer name="layer" onEscape={first} />);
    rerender(<Layer name="layer" onEscape={second} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });

  it('focuses the layer, unless something inside already took focus', () => {
    render(<Layer name="plain" onEscape={vi.fn()} />);
    expect(screen.getByTestId('plain')).toHaveFocus();
    cleanup();

    render(
      <Layer name="with-autofocus" onEscape={vi.fn()}>
        <input aria-label="auto" autoFocus />
      </Layer>
    );
    expect(screen.getByLabelText('auto')).toHaveFocus();
  });

  it('wraps Tab and Shift+Tab inside a trapping layer', () => {
    render(
      <Layer name="trap" onEscape={vi.fn()} trapFocus>
        <button>first</button>
        <button disabled>disabled</button>
        <button>last</button>
      </Layer>
    );
    const first = screen.getByRole('button', { name: 'first' });
    const last = screen.getByRole('button', { name: 'last' });

    // From the layer itself, Shift+Tab lands on the last control
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('returns focus to where it was when the layer closes', () => {
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>open</button>
          {open && <Layer name="layer" onEscape={() => setOpen(false)} restoreFocus />}
        </>
      );
    }
    render(<Opener />);
    const opener = screen.getByRole('button', { name: 'open' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByTestId('layer')).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByTestId('layer')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
