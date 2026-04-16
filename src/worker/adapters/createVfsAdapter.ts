/**
 * Worker-side VFS adapter factory.
 *
 * Dispatches to `RemoteVfsAdapter` (when the project has `remoteVfsUrl`
 * set) or `LocalVfsAdapter` wrapping a per-server `VfsService`. Phase 1.65
 * absorbs the old `vfsFacade.getAdapter` dispatch into this file so the
 * remote flavor can live under `src/worker/adapters/` next to its storage
 * counterparts and `src/shared/services/vfs/` no longer references the
 * remote adapter.
 *
 * Wired up via `GremlinServer.setBootstrapAdapterFactories`. Call sites
 * read it off `deps.createVfsAdapter` (see `GremlinServer.getProjectVfsAdapter`
 * and `buildLoopOptions`).
 */

import type { Project } from '../../shared/protocol/types';
import type { BackendDeps } from '../../shared/engine/backendDeps';
import type { VfsAdapter } from '../../shared/services/vfs/vfsAdapter';
import { LocalVfsAdapter } from '../../shared/services/vfs/localVfsAdapter';
import { createVfsService } from '../../shared/services/vfs/vfsService';
import { RemoteVfsAdapter } from './RemoteVfsAdapter';

export function createVfsAdapter(
  deps: BackendDeps,
  project: Project,
  userId: string,
  namespace?: string
): VfsAdapter {
  if (project.remoteVfsUrl) {
    return new RemoteVfsAdapter(
      project.remoteVfsUrl,
      userId,
      project.remoteVfsPassword ?? '',
      project.id,
      project.remoteVfsEncrypt ?? false,
      deps.encryption,
      namespace
    );
  }
  const vfsService = createVfsService(deps.storage, deps.encryption);
  return new LocalVfsAdapter(vfsService, project.id, namespace);
}
