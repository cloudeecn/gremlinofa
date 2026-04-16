/**
 * Storage adapter configuration. Lives under `shared/protocol/types/` so
 * both the frontend (which reads/writes the localStorage entry during
 * bootstrap) and the worker (which constructs the matching adapter from
 * the out-of-band `worker_config` envelope) refer to the same shape
 * without crossing layer boundaries.
 *
 * Phase 1.8 hoist: previously this type lived in
 * `src/utils/localStorageBoot.ts`, which co-located the runtime
 * helpers (read/write/delete) with the type. The relocation puts the type
 * on the protocol surface so backend imports don't reach back into
 * frontend territory.
 */
export type StorageConfig =
  | { type: 'local' }
  | { type: 'remote'; baseUrl: string; password: string; userId: string };
