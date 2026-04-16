/**
 * Backend dependency bundle.
 *
 * `GremlinServer.init()` constructs one of these from its `InitParams`
 * and threads it through `ChatRunner` → `AgenticLoopOptions` → `ToolContext`
 * so tools, the agentic loop, and API clients receive their collaborators
 * via injection instead of reaching for module-level singletons.
 *
 * After Phase 1.65 there is no eager / in-process production path: the
 * worker is the only place a real `BackendDeps` bundle gets constructed.
 * Tests that need an in-process server build a stub bundle directly (see
 * `GremlinClient.contract.test.ts`).
 */

import type { APIService } from '../services/api/apiService';
import type { EncryptionCore } from '../services/encryption/encryptionCore';
import type { UnifiedStorage } from '../services/storage/unifiedStorage';
import type { CachedStorageAdapter } from '../services/storage/adapters/CachedStorageAdapter';
import type { ClientSideToolRegistry } from '../services/tools/clientSideTools';
import type { VfsAdapter } from '../services/vfs/vfsAdapter';
import type { Project } from '../protocol/types';
import type { StorageConfig } from '../protocol/types/storageConfig';
import type { LoopRegistry } from './LoopRegistry';

/**
 * Build a storage adapter from a config. Phase 1.65 hoists this factory
 * out of `src/shared/services/storage/index.ts` so the browser-only inner
 * adapters (`IndexedDBAdapter`, `RemoteStorageAdapter`) can live in
 * `src/worker/adapters/` instead. The worker injects this via
 * `GremlinServer.setBootstrapAdapterFactories` at module load.
 */
export type CreateStorageAdapter = (config: StorageConfig) => CachedStorageAdapter;

/**
 * Build a VFS adapter for a project. Phase 1.65 hoists this dispatch out
 * of the shared VFS barrel for the same reason: the remote VFS flavor
 * wants to live alongside the worker so the shared layer's lint rule can
 * forbid `fetch`-based browser adapters.
 */
export type CreateVfsAdapter = (
  deps: BackendDeps,
  project: Project,
  userId: string,
  namespace?: string
) => VfsAdapter;

export interface BackendDeps {
  storage: UnifiedStorage;
  /**
   * Pure encryption primitives — no `localStorage` coupling. The worker
   * constructs an `EncryptionCore` directly inside `GremlinServer.init`
   * from the CEK bytes that crossed the boundary in `init({cek})`.
   */
  encryption: EncryptionCore;
  apiService: APIService;
  toolRegistry: ClientSideToolRegistry;
  /**
   * Per-server agentic-loop registry. The same instance held by
   * `GremlinServer.registry` — bundled here so tools that spawn child loops
   * (notably `minionTool`) can `register` / `end` / wire abort controllers
   * without reaching for the server directly.
   */
  loopRegistry: LoopRegistry;
  /**
   * Worker-side adapter factories injected via
   * `GremlinServer.setBootstrapAdapterFactories`. Optional in the type
   * because the contract test stubs and the in-process `GremlinServer`
   * test harness don't exercise factory-using code; production
   * (`gremlinWorker.ts`) always sets both.
   */
  createStorageAdapter?: CreateStorageAdapter;
  createVfsAdapter?: CreateVfsAdapter;
}
