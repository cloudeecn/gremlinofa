import { createElement } from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConnectionState } from '../../../shared/protocol/transport';

// Mock the hook so we don't need a real gremlinClient
let mockState: ConnectionState = 'connected';
vi.mock('../../hooks/useConnectionState', () => ({
  useConnectionState: () => mockState,
}));

// Import after mock setup
const { ConnectionStatusBanner } = await import('../ConnectionStatusBanner');

describe('ConnectionStatusBanner', () => {
  beforeEach(() => {
    mockState = 'connected';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should render only an empty live region when connected', () => {
    mockState = 'connected';
    render(createElement(ConnectionStatusBanner));
    const region = screen.getByRole('status');
    expect(region).toBeEmptyDOMElement();
    expect(region).not.toHaveAttribute('data-visible');
  });

  it('should render only an empty live region when connecting (initial)', () => {
    mockState = 'connecting';
    render(createElement(ConnectionStatusBanner));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('announces problems through the live region and marks it visible', () => {
    mockState = 'disconnected';
    render(createElement(ConnectionStatusBanner));
    act(() => {
      vi.advanceTimersByTime(600);
    });

    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('data-visible', 'true');
    expect(region).toHaveTextContent(/Connection lost/);
  });

  it('offers a Reload button when the server rejects the key', () => {
    const reload = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, reload },
      configurable: true,
    });
    try {
      mockState = 'auth_failed';
      render(createElement(ConnectionStatusBanner));
      act(() => {
        vi.advanceTimersByTime(1);
      });

      screen.getByRole('button', { name: 'Reload' }).click();
      expect(reload).toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { value: originalLocation, configurable: true });
    }
  });

  it('should show red banner after debounce when disconnected', () => {
    mockState = 'disconnected';
    render(createElement(ConnectionStatusBanner));

    // Not visible immediately (debounce)
    expect(screen.queryByText(/Connection lost/)).not.toBeInTheDocument();

    // Advance past the 500ms debounce
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(screen.getByText(/Connection lost/)).toBeInTheDocument();
  });

  it('should show amber banner after debounce when reconnecting', () => {
    mockState = 'reconnecting';
    render(createElement(ConnectionStatusBanner));

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument();
  });

  it('should not show banner if reconnect completes within debounce window', () => {
    mockState = 'disconnected';
    const { rerender } = render(createElement(ConnectionStatusBanner));

    // Advance only 200ms (less than 500ms debounce)
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // Reconnect before debounce fires
    mockState = 'connected';
    rerender(createElement(ConnectionStatusBanner));

    // Advance past the original debounce time
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.queryByText(/Connection lost/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Reconnected/)).not.toBeInTheDocument();
  });

  it('should show "Reconnected" flash after recovery from visible banner', () => {
    mockState = 'disconnected';
    const { rerender } = render(createElement(ConnectionStatusBanner));

    // Show the banner
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByText(/Connection lost/)).toBeInTheDocument();

    // Reconnect
    mockState = 'connected';
    rerender(createElement(ConnectionStatusBanner));

    // The mode transition runs via setTimeout(…, 0) to satisfy the lint rule
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText(/Reconnected/)).toBeInTheDocument();

    // Flash disappears after 1.5s
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.queryByText(/Reconnected/)).not.toBeInTheDocument();
  });
});
