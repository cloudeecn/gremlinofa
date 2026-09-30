import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ConnectionState } from '../../../shared/protocol/transport';

const fakeClient = vi.hoisted(() => {
  const listeners = new Set<(state: ConnectionState) => void>();
  return {
    state: undefined as ConnectionState | undefined,
    listeners,
    // Runs before the listener is registered, like a transport event that
    // fires between the hook's render and its subscription.
    beforeSubscribe: null as (() => void) | null,
    emit(state: ConnectionState) {
      this.state = state;
      for (const listener of listeners) listener(state);
    },
  };
});

vi.mock('../../client', () => ({
  gremlinClient: {
    get connectionState() {
      return fakeClient.state;
    },
    onConnectionStateChange(callback: (state: ConnectionState) => void) {
      fakeClient.beforeSubscribe?.();
      fakeClient.listeners.add(callback);
      return () => fakeClient.listeners.delete(callback);
    },
  },
}));

import { useConnectionState } from '../useConnectionState';

describe('useConnectionState', () => {
  beforeEach(() => {
    fakeClient.state = undefined;
    fakeClient.listeners.clear();
    fakeClient.beforeSubscribe = null;
  });

  it("reads 'connected' when the transport doesn't track connection state", () => {
    const { result } = renderHook(() => useConnectionState());
    expect(result.current).toBe('connected');
  });

  it('follows state changes', () => {
    fakeClient.state = 'connecting';
    const { result } = renderHook(() => useConnectionState());
    expect(result.current).toBe('connecting');

    act(() => fakeClient.emit('disconnected'));
    expect(result.current).toBe('disconnected');
  });

  it('picks up a change that lands between render and subscription', () => {
    fakeClient.state = 'connecting';
    fakeClient.beforeSubscribe = () => {
      fakeClient.state = 'disconnected';
    };
    const { result } = renderHook(() => useConnectionState());
    expect(result.current).toBe('disconnected');
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useConnectionState());
    expect(fakeClient.listeners.size).toBe(1);
    unmount();
    expect(fakeClient.listeners.size).toBe(0);
  });
});
