import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ErrorProvider } from '../ErrorProvider';
import { useError } from '../../hooks/useError';
import type { ErrorContextValue } from '../ErrorContext';

vi.mock('../../lib/stackTraceMapper', () => ({
  isProductionBuild: () => false,
  mapStackTrace: vi.fn(),
}));

describe('ErrorProvider', () => {
  it('keeps the context value until the errors change', () => {
    const values: ErrorContextValue[] = [];
    function Probe() {
      values.push(useError());
      return null;
    }
    function Harness() {
      const [ticks, setTicks] = useState(0);
      return (
        <>
          <button onClick={() => setTicks(t => t + 1)}>tick {ticks}</button>
          <ErrorProvider>
            <Probe />
          </ErrorProvider>
        </>
      );
    }
    render(<Harness />);

    fireEvent.click(screen.getByRole('button'));
    expect(values.length).toBeGreaterThan(1);
    expect(new Set(values).size).toBe(1);

    act(() => values[0].addError(new Error('boom')));
    expect(values.at(-1)).not.toBe(values[0]);
    expect(values.at(-1)!.errors).toHaveLength(1);
  });

  it('shows the crash screen when a child throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Thrower(): never {
      throw new Error('render exploded');
    }
    render(
      <ErrorProvider>
        <Thrower />
      </ErrorProvider>
    );

    expect(screen.getByRole('alert')).toHaveTextContent('render exploded');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
