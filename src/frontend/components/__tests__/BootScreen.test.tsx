import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ConnectionState } from '../../../shared/protocol/transport';
import type { BootStep } from '../../contexts/createAppContext';

const harness = vi.hoisted(() => ({ connectionState: 'connected' as ConnectionState }));

vi.mock('../../hooks/useConnectionState', () => ({
  useConnectionState: () => harness.connectionState,
}));

import { BootScreen } from '../BootScreen';
import { setStorageConfig } from '../../lib/localStorageBoot';

function renderBoot(step: BootStep, error: string | null = null, onDismiss = vi.fn()) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<BootScreen step={step} error={error} onDismiss={onDismiss} />} />
        <Route path="/data" element={<div>Data manager page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

/** The `data-state` of the step row whose label contains `label`. */
function stateOf(label: string): string | null {
  return screen.getByText(label, { exact: false }).closest('li')!.getAttribute('data-state');
}

describe('BootScreen', () => {
  beforeEach(() => {
    localStorage.clear();
    harness.connectionState = 'connected';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks App loaded and marks the running step in worker mode', () => {
    renderBoot('unlock');
    expect(stateOf('App loaded')).toBe('done');
    expect(stateOf('Start the local backend')).toBe('done');
    expect(stateOf('Open the browser database')).toBe('active');
    expect(stateOf('Load projects')).toBe('waiting');
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
  });

  it('names the remote storage host', () => {
    setStorageConfig({
      type: 'remote',
      baseUrl: 'https://store.example:8443/api',
      password: '',
      userId: 'u',
    });
    renderBoot('unlock');
    expect(stateOf('Open remote storage at store.example:8443')).toBe('active');
  });

  it('holds server mode on the backend step until the socket reaches the server', () => {
    setStorageConfig({ type: 'server', wsUrl: 'wss://gremlin.example/ws' });
    harness.connectionState = 'reconnecting';
    renderBoot('unlock');
    expect(stateOf('Reach the server at gremlin.example')).toBe('active');
    expect(screen.getByText("Can't reach the server yet, retrying…")).toBeInTheDocument();
    expect(stateOf('Unlock storage on the server')).toBe('waiting');
  });

  it('moves server mode to the unlock step once connected', () => {
    setStorageConfig({ type: 'server', wsUrl: 'wss://gremlin.example/ws' });
    renderBoot('unlock');
    expect(stateOf('Reach the server at gremlin.example')).toBe('done');
    expect(stateOf('Unlock storage on the server')).toBe('active');
  });

  it('puts a rejected key on the unlock step, not the connection', () => {
    setStorageConfig({ type: 'server', wsUrl: 'wss://gremlin.example/ws' });
    harness.connectionState = 'auth_failed';
    renderBoot('unlock', 'init: server is already initialized with a different CEK');
    expect(stateOf('Reach the server at gremlin.example')).toBe('done');
    expect(stateOf('Unlock storage on the server')).toBe('failed');
  });

  it('shows the elapsed time, then a hint and a way out on a slow step', () => {
    vi.useFakeTimers();
    setStorageConfig({ type: 'server', wsUrl: 'wss://gremlin.example/ws' });
    harness.connectionState = 'reconnecting';
    renderBoot('unlock');

    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByText('· 3s')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();

    act(() => vi.advanceTimersByTime(7000));
    expect(screen.getByText(/wss:\/\/gremlin\.example\/ws is reachable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Data Manager' })).toBeInTheDocument();
  });

  it('restarts the clock when the step changes', () => {
    vi.useFakeTimers();
    const { rerender } = renderBoot('backend');
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText('· 5s')).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <BootScreen step="unlock" error={null} onDismiss={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.queryByText(/· \ds/)).toBeNull();
  });

  it('marks the failed step with the error, without Data Manager in worker mode', () => {
    renderBoot('backend', 'Backend worker failed to start: script failed to load');
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't start");
    expect(stateOf('Start the local backend')).toBe('failed');
    expect(
      screen.getByText('Backend worker failed to start: script failed to load')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Data Manager' })).toBeNull();
  });

  it('leaves for Data Manager in server mode', () => {
    setStorageConfig({ type: 'server', wsUrl: 'wss://gremlin.example/ws' });
    const onDismiss = vi.fn();
    renderBoot('unlock', 'boom', onDismiss);
    fireEvent.click(screen.getByRole('button', { name: 'Open Data Manager' }));
    expect(onDismiss).toHaveBeenCalled();
    expect(screen.getByText('Data manager page')).toBeInTheDocument();
  });
});
