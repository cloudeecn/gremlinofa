import { vi, beforeEach } from 'vitest';
import { Buffer } from 'buffer';
import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

// Polyfill Buffer for Node.js environment compatibility
if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};

  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => {
      const keys = Object.keys(store);
      return keys[index] || null;
    },
  };
})();

Object.defineProperty(global, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// Mock navigator.storage for IndexedDB tests
const storageMock = {
  persisted: () => Promise.resolve(true),
  persist: () => Promise.resolve(true),
  estimate: () => Promise.resolve({ usage: 0, quota: 1024 * 1024 * 1024 }),
};

// Create navigator mock if it doesn't exist (Node.js < 21)
if (typeof navigator === 'undefined') {
  (global as unknown as Record<string, unknown>).navigator = {};
}

Object.defineProperty(navigator, 'storage', {
  value: storageMock,
  writable: true,
});

// Reset mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
});
