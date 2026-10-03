/// <reference types="vite-plugin-pwa/react" />
import { useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { activeLoopsStore } from '../client';
import { showConfirm } from '../lib/alerts';
import { getStorageConfig } from '../lib/localStorageBoot';

/**
 * A backgrounded phone PWA never navigates, so the browser's own update
 * check never runs. Check again on resume, at most this often.
 */
const RESUME_UPDATE_CHECK_MS = 10 * 60 * 1000;

function checkForUpdatesOnResume(registration: ServiceWorkerRegistration): void {
  let lastCheckAt = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastCheckAt < RESUME_UPDATE_CHECK_MS) return;
    lastCheckAt = Date.now();
    registration.update().catch(err => {
      console.debug('[UpdateBanner] Update check failed: %o', err);
    });
  });
}

/**
 * Registers the service worker and offers a reload once a new build is
 * waiting. The SW is in prompt mode: without this, a new build only took
 * over after every tab and installed PWA window had closed, which a phone
 * that just backgrounds the app never does. Mounted outside the boot and
 * OOBE screens, since stale cached files are a likely reason boot fails.
 */
export function UpdateBanner() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW: (_swUrl, registration) => {
      if (registration) checkForUpdatesOnResume(registration);
    },
    onRegisterError: err => {
      console.debug('[UpdateBanner] Service worker registration failed: %o', err);
    },
  });
  const [isDismissed, setIsDismissed] = useState(false);

  if (!needRefresh || isDismissed) return null;

  const reload = async () => {
    // Worker mode runs loops in this tab; server mode's survive a reload
    const runningLoops =
      getStorageConfig().type === 'server' ? 0 : activeLoopsStore.getSnapshot().length;
    if (runningLoops > 0) {
      const message =
        runningLoops === 1
          ? '1 loop is running in this tab. Reloading stops it.'
          : `${runningLoops} loops are running in this tab. Reloading stops them.`;
      if (!(await showConfirm('Reload now?', message, 'Reload'))) return;
    }
    await updateServiceWorker(true);
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
      <div
        role="status"
        className="pointer-events-auto flex items-center gap-3 rounded-full border border-blue-200 bg-blue-50 py-1.5 pr-2 pl-4 text-sm text-blue-900 shadow-md"
      >
        <span>A new version is ready</span>
        <button
          onClick={() => void reload()}
          className="rounded-full bg-blue-600 px-3 py-1 font-medium text-white hover:bg-blue-700"
        >
          Reload
        </button>
        <button
          onClick={() => setIsDismissed(true)}
          aria-label="Dismiss"
          className="flex h-7 w-7 items-center justify-center rounded-full text-blue-700 hover:bg-blue-100"
        >
          ×
        </button>
      </div>
    </div>
  );
}
