/**
 * Storage adapter configuration. Lives under `shared/protocol/types/` so
 * both the frontend (which reads/writes the localStorage entry during
 * bootstrap) and the worker (which constructs the matching adapter from
 * the out-of-band `worker_config` envelope) refer to the same shape
 * without crossing layer boundaries.
 *
 * The runtime helpers (read/write/delete of the localStorage entry) live in
 * `src/frontend/lib/localStorageBoot.ts`; only the type lives here on the
 * protocol surface so backend imports don't reach into frontend territory.
 */
export type StorageConfig =
  | { type: 'local' }
  | { type: 'remote'; baseUrl: string; password: string; userId: string }
  | { type: 'server'; wsUrl: string };
