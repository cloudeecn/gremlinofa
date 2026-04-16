import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

/**
 * Four-layer boundary rules (Phase 1.6 → Phase 1.8 tightened).
 *
 * The codebase is split into four runtime layers:
 *
 *   - `src/shared/**`   — pure (runs in browser worker, jsdom main thread,
 *                         and Node server). No browser-only / Node-only
 *                         globals; only universal Web APIs.
 *   - `src/frontend/**` — browser main-thread UI layer. React, hooks,
 *                         contexts, the gremlinClient transport setup,
 *                         plus `frontend/lib/` (frontend-only helpers).
 *   - `src/worker/**`   — Web Worker entry point and worker-only adapters.
 *   - `src/server/**`   — Phase 2 Node WebSocket server (placeholder).
 *
 * Cross-layer rules:
 *
 *   1. `src/shared/**` cannot import from `src/{frontend,worker,server}/**`
 *   2. `src/frontend/**` cannot import from `src/{worker,server}/**`
 *   3. `src/worker/**` cannot import from `src/{frontend,server}/**`
 *   4. `src/server/**` cannot import from `src/{frontend,worker}/**`
 *
 * Frontend service boundary (Phase 1.8):
 *   Frontend code may only import from `src/shared/protocol/**` or
 *   `src/frontend/**`. The backend engine + services are off-limits —
 *   route through `gremlinClient` RPCs or consume `LoopEvent`s.
 *
 * Tests under `**\/__tests__/**` are excluded from all rules so test
 * stubs that touch internal types stay simple.
 */

const FORBIDDEN_FROM_SHARED = [
  '*/frontend/*',
  '*/frontend/**',
  '*/worker/*',
  '*/worker/**',
  '*/server/*',
  '*/server/**',
];

const FORBIDDEN_FROM_FRONTEND_LAYER = ['*/worker/*', '*/worker/**', '*/server/*', '*/server/**'];

const FORBIDDEN_FROM_WORKER = ['*/frontend/*', '*/frontend/**', '*/server/*', '*/server/**'];

const FORBIDDEN_FROM_SERVER = ['*/frontend/*', '*/frontend/**', '*/worker/*', '*/worker/**'];

/**
 * Frontend service boundary — Phase 1.8 tightened rule.
 *
 * Frontend UI code may only import from:
 *   - `src/shared/protocol/**` (the RPC contract, protocol types)
 *   - `src/frontend/**` (frontend-own lib, hooks, components, contexts)
 *
 * Everything else (engine, services, worker, server, and the now-deleted
 * `src/lib/`, `src/utils/`, `src/constants/`) is off-limits. Route
 * through `gremlinClient` RPCs or consume `LoopEvent`s.
 *
 * The forbidden list blocks `shared/engine/**` and `shared/services/**`
 * explicitly. Top-level `src/shared/*` files that aren't under `protocol/`
 * don't exist today, so no catch-all is needed.
 */
const FORBIDDEN_FROM_FRONTEND_UI = [
  '*/shared/services/*',
  '*/shared/services/**',
  '*/shared/engine/*',
  '*/shared/engine/**',
];

const frontendServiceBoundary = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: FORBIDDEN_FROM_FRONTEND_UI,
          message:
            'Frontend code may only import from src/shared/protocol/** or src/frontend/**. Add a method to src/shared/protocol/methods.ts and route it through gremlinClient, or consume the relevant LoopEvent in your component instead.',
        },
      ],
    },
  ],
};

function layerBoundary(forbidden, layerLabel) {
  return {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: forbidden,
            message: `${layerLabel} code cannot import from other layer directories. See eslint.config.js four-layer rules.`,
          },
        ],
      },
    ],
  };
}

export default defineConfig([
  globalIgnores([
    'dist',
    'dev-dist',
    'chatbot/**',
    'storage-backend/**',
    'cors-proxy/**',
    'vfs-backend/**',
    'touch-grass-backend/**',
    '**/__tests__/**',
    '**/*.test.ts',
    '**/*.test.tsx',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },

  // ==========================================================================
  // Four-layer boundary rules
  // ==========================================================================
  {
    files: ['src/shared/**/*.{ts,tsx}'],
    ignores: ['src/shared/**/__tests__/**'],
    rules: {
      // Browser/main-thread-only globals: shared code runs in workers,
      // jsdom, and the Phase 2 Node server. `localStorage` /
      // `sessionStorage` / `document` / `window` aren't available in any
      // of those, so they would crash at runtime. `crypto` and `fetch`
      // exist in workers and modern Node, so those stay allowed.
      //
      // Phase 1.65 added `indexedDB` and `navigator` to the ban list:
      // after the adapter move, no shared code reaches for either, and
      // the rule prevents regression. The Phase 2 Node server doesn't
      // have a Web `indexedDB` global; `navigator.storage` is also
      // unavailable there. Test files (`__tests__/**`) are excluded by
      // the `ignores` clause above so fake-indexeddb test setup can
      // still run inside `src/shared/engine/__tests__/`.
      'no-restricted-globals': [
        'error',
        {
          name: 'localStorage',
          message: 'localStorage is browser-main-thread only — keep this in src/frontend/.',
        },
        {
          name: 'sessionStorage',
          message: 'sessionStorage is browser-main-thread only — keep this in src/frontend/.',
        },
        {
          name: 'document',
          message: 'document is browser-main-thread only — keep this in src/frontend/.',
        },
        {
          name: 'window',
          message: 'window is browser-main-thread only — keep this in src/frontend/.',
        },
        {
          name: 'indexedDB',
          message:
            'indexedDB lives in the worker. Move adapters to src/worker/adapters/ and inject via BackendDeps.createStorageAdapter.',
        },
        {
          name: 'navigator',
          message:
            'navigator is browser-only. Storage quota / persistence checks belong in src/worker/adapters/IndexedDBAdapter.ts.',
        },
      ],
      // Combined: layer-boundary patterns (no `src/{frontend,worker,server}/**`)
      // PLUS node-only module bans. Two separate `no-restricted-imports`
      // rules in the same `rules` block would silently overwrite each other
      // (Phase 1.7 audit caught a real production bug — `unifiedStorage.ts`
      // reaching into `frontend/hooks/useDraftPersistence` — that the
      // overridden layer-boundary rule had been letting through).
      //
      // Test files (`__tests__/**`) are excluded by the `ignores` clause
      // above so the e2e harness in
      // `src/shared/engine/__tests__/dataRoundtrip.e2e.test.ts` can still
      // spawn the storage backend.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: FORBIDDEN_FROM_SHARED,
              message:
                'src/shared/** cannot import from src/{frontend,worker,server}/**. See four-layer rules in eslint.config.js.',
            },
          ],
          paths: [
            {
              name: 'fs',
              message:
                'Node fs is unavailable in browser workers. Backend filesystem code lives in src/server/** (Phase 2).',
            },
            {
              name: 'fs/promises',
              message:
                'Node fs/promises is unavailable in browser workers. Backend filesystem code lives in src/server/** (Phase 2).',
            },
            {
              name: 'node:fs',
              message:
                'Node fs is unavailable in browser workers. Backend filesystem code lives in src/server/** (Phase 2).',
            },
            {
              name: 'node:fs/promises',
              message:
                'Node fs is unavailable in browser workers. Backend filesystem code lives in src/server/** (Phase 2).',
            },
            {
              name: 'path',
              message:
                'Node path is unavailable in browser workers. Use string helpers (src/utils/, src/lib/vfsPaths.ts) instead.',
            },
            {
              name: 'node:path',
              message:
                'Node path is unavailable in browser workers. Use string helpers (src/utils/, src/lib/vfsPaths.ts) instead.',
            },
            {
              name: 'os',
              message: 'Node os is unavailable in browser workers.',
            },
            {
              name: 'node:os',
              message: 'Node os is unavailable in browser workers.',
            },
            {
              name: 'child_process',
              message:
                'Node child_process is unavailable in browser workers. Subprocess execution belongs in src/server/** (Phase 2).',
            },
            {
              name: 'node:child_process',
              message:
                'Node child_process is unavailable in browser workers. Subprocess execution belongs in src/server/** (Phase 2).',
            },
            {
              name: 'crypto',
              message:
                'Use globalThis.crypto / globalThis.crypto.subtle (Web Crypto), which is available in browser workers and modern Node.',
            },
            {
              name: 'node:crypto',
              message:
                'Use globalThis.crypto / globalThis.crypto.subtle (Web Crypto), which is available in browser workers and modern Node.',
            },
            {
              name: 'net',
              message: 'Node net is unavailable in browser workers.',
            },
            {
              name: 'node:net',
              message: 'Node net is unavailable in browser workers.',
            },
            {
              name: 'http',
              message: 'Node http is unavailable in browser workers. Use fetch() instead.',
            },
            {
              name: 'node:http',
              message: 'Node http is unavailable in browser workers. Use fetch() instead.',
            },
            {
              name: 'https',
              message: 'Node https is unavailable in browser workers. Use fetch() instead.',
            },
            {
              name: 'node:https',
              message: 'Node https is unavailable in browser workers. Use fetch() instead.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/frontend/**/*.{ts,tsx}'],
    rules: layerBoundary(FORBIDDEN_FROM_FRONTEND_LAYER, 'src/frontend/**'),
  },
  {
    files: ['src/worker/**/*.{ts,tsx}'],
    rules: layerBoundary(FORBIDDEN_FROM_WORKER, 'src/worker/**'),
  },
  {
    files: ['src/server/**/*.{ts,tsx}'],
    rules: layerBoundary(FORBIDDEN_FROM_SERVER, 'src/server/**'),
  },

  // ==========================================================================
  // Frontend service boundary (Phase 1.8 tightened).
  // All frontend code may only import from src/shared/protocol/** or
  // src/frontend/**. The backend engine, services, and any top-level
  // legacy helper directories are off-limits.
  // ==========================================================================
  {
    files: ['src/frontend/**/*.{ts,tsx}'],
    rules: frontendServiceBoundary,
  },
]);
