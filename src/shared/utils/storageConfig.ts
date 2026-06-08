/**
 * Storage adapter configuration — the small piece of frontend state that
 * crosses the worker boundary at bootstrap time.
 *
 * The runtime helpers that read/write this from `localStorage` live in the
 * main thread (`src/frontend/utils/localStorageBoot.ts`) because shared code
 * can't touch browser-only globals. Only the *type* needs to be visible to
 * both layers, so it lives here.
 */

export type StorageConfig =
  | { type: 'local' }
  | { type: 'remote'; baseUrl: string; password: string; userId: string };
