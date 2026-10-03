/**
 * Stand-in for `virtual:pwa-register/react`, which only vite-plugin-pwa can
 * resolve and vitest doesn't load it. Mirrors the plugin's dev build: no
 * service worker, never an update. Tests that need one `vi.mock` it.
 */
import { useState } from 'react';

export function useRegisterSW() {
  return {
    needRefresh: useState(false),
    offlineReady: useState(false),
    updateServiceWorker: async () => {},
  };
}
