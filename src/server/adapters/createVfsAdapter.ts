/**
 * Server-side VFS adapter factory.
 *
 * Dispatches to `FilesystemVfsAdapter` (when `vfsMode === 'filesystem'`)
 * or the shared `LocalVfsAdapter` wrapping an in-process `VfsService`
 * over SQLite (when `vfsMode === 'encrypted'`). Captures `ServerConfig`
 * via closure at registration time.
 */

import type { Project } from '../../shared/protocol/types';
import type { BackendDeps } from '../../shared/engine/backendDeps';
import type { VfsAdapter } from '../../shared/services/vfs/vfsAdapter';
import { LocalVfsAdapter } from '../../shared/services/vfs/localVfsAdapter';
import { createVfsService } from '../../shared/services/vfs/vfsService';
import type { ServerConfig } from '../config';
import { FilesystemVfsAdapter } from './FilesystemVfsAdapter';

export function makeCreateVfsAdapter(
  serverConfig: ServerConfig
): (deps: BackendDeps, project: Project, userId: string, namespace?: string) => VfsAdapter {
  return (deps: BackendDeps, project: Project, _userId: string, namespace?: string): VfsAdapter => {
    if (serverConfig.vfsMode === 'filesystem') {
      const projectId = namespace ? `${project.id}/${namespace}` : project.id;
      return new FilesystemVfsAdapter(serverConfig.vfsBasePath, projectId);
    }
    // Encrypted mode: reuse the shared VfsService over SQLite
    const vfsService = createVfsService(deps.storage, deps.encryption);
    return new LocalVfsAdapter(vfsService, project.id, namespace);
  };
}
