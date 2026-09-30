import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CrashView, ErrorBoundary } from '../ErrorBoundary';

const state = { shouldThrow: true };

function Flaky() {
  if (state.shouldThrow) throw new Error('kaboom');
  return <div>recovered</div>;
}

function renderBoundary(resetKey: string, onError = vi.fn()) {
  const ui = (key: string) => (
    <ErrorBoundary
      resetKey={key}
      onError={onError}
      fallback={(error, reset) => <CrashView error={error} onRetry={reset} />}
    >
      <Flaky />
    </ErrorBoundary>
  );
  const view = render(ui(resetKey));
  return { onError, rerenderWith: (key: string) => view.rerender(ui(key)) };
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    state.shouldThrow = true;
    // React reports caught render errors on console.error
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the fallback with the error and reports it once', () => {
    const { onError } = renderBoundary('a');

    expect(screen.getByRole('alert')).toHaveTextContent('kaboom');
    expect(onError).toHaveBeenCalledTimes(1);
    const reported = onError.mock.calls[0][0] as Error;
    expect(reported.message).toBe('kaboom');
    expect(reported.stack).toContain('Component Stack:');
  });

  it('Try again renders the children again', () => {
    renderBoundary('a');
    state.shouldThrow = false;

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('recovered')).toBeInTheDocument();
  });

  it('shows the fallback again when the retry throws too', () => {
    const { onError } = renderBoundary('a');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('clears the error when the reset key changes', () => {
    const { rerenderWith } = renderBoundary('a');
    state.shouldThrow = false;

    rerenderWith('b');

    expect(screen.getByText('recovered')).toBeInTheDocument();
  });
});
