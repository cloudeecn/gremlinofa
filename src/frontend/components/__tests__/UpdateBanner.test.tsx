import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const pwa = vi.hoisted(() => ({
  needRefresh: false,
  updateServiceWorker: vi.fn(async () => {}),
  options: null as null | {
    onRegisteredSW?: (url: string, registration: ServiceWorkerRegistration | undefined) => void;
  },
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (options: typeof pwa.options) => {
    pwa.options = options;
    return {
      needRefresh: [pwa.needRefresh, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: pwa.updateServiceWorker,
    };
  },
}));

const loops = vi.hoisted(() => ({ snapshot: [] as unknown[] }));
vi.mock('../../client', () => ({
  activeLoopsStore: { getSnapshot: () => loops.snapshot },
}));

const alerts = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock('../../lib/alerts', () => ({ showConfirm: alerts.confirm }));

import { UpdateBanner } from '../UpdateBanner';
import { setStorageConfig } from '../../lib/localStorageBoot';

describe('UpdateBanner', () => {
  beforeEach(() => {
    localStorage.clear();
    pwa.needRefresh = false;
    pwa.updateServiceWorker.mockClear();
    loops.snapshot = [];
    alerts.confirm.mockClear();
    alerts.confirm.mockResolvedValue(true);
  });

  it('stays hidden until a new build is waiting', () => {
    render(<UpdateBanner />);
    expect(screen.queryByText('A new version is ready')).toBeNull();
  });

  it('reloads into the waiting build', async () => {
    pwa.needRefresh = true;
    render(<UpdateBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(pwa.updateServiceWorker).toHaveBeenCalledWith(true));
    expect(alerts.confirm).not.toHaveBeenCalled();
  });

  it('asks first when loops are running in this tab', async () => {
    pwa.needRefresh = true;
    loops.snapshot = [{ loopId: 'l1' }, { loopId: 'l2' }];
    alerts.confirm.mockResolvedValueOnce(false);
    render(<UpdateBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(alerts.confirm).toHaveBeenCalledWith(
        'Reload now?',
        '2 loops are running in this tab. Reloading stops them.',
        'Reload'
      )
    );
    expect(pwa.updateServiceWorker).not.toHaveBeenCalled();
  });

  it("doesn't ask in server mode, where loops outlive the tab", async () => {
    setStorageConfig({ type: 'server', wsUrl: 'wss://gremlin.example/ws' });
    pwa.needRefresh = true;
    loops.snapshot = [{ loopId: 'l1' }];
    render(<UpdateBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(pwa.updateServiceWorker).toHaveBeenCalled());
    expect(alerts.confirm).not.toHaveBeenCalled();
  });

  it('can be dismissed', () => {
    pwa.needRefresh = true;
    render(<UpdateBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('A new version is ready')).toBeNull();
  });

  it('checks for a new build when the app comes back after a while', () => {
    vi.useFakeTimers();
    render(<UpdateBanner />);
    const update = vi.fn(async () => {});
    pwa.options!.onRegisteredSW!('/sw.js', { update } as unknown as ServiceWorkerRegistration);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

    document.dispatchEvent(new Event('visibilitychange'));
    expect(update).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10 * 60 * 1000);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(update).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
