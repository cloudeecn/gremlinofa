import { useEffect, useState } from 'react';
import { storage } from '../services/storage';
import { getAdapter, type VfsAdapter } from '../services/vfs';
import { encryptionService } from '../services/encryption/encryptionService';

/**
 * Returns the correct VfsAdapter for a project — RemoteVfsAdapter when
 * remoteVfsUrl is configured, LocalVfsAdapter otherwise. Returns null
 * while the project is loading.
 */
export function useVfsAdapter(projectId: string): VfsAdapter | null {
  const [adapter, setAdapter] = useState<VfsAdapter | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      const project = await storage.getProject(projectId);
      if (cancelled || !project) return;

      let userId = '';
      if (project.remoteVfsUrl) {
        userId = await encryptionService.deriveUserId();
      }
      if (cancelled) return;

      setAdapter(getAdapter(project, userId));
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return adapter;
}
