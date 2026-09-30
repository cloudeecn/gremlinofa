import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { gremlinClient } from '../client';
import type { APIDefinition, Model, Project } from '../../shared/protocol/types';
import { apiKeyOptional } from '../../shared/protocol/apiDefinition';
import {
  ApiDefinitionsContext,
  AppActionsContext,
  AppStatusContext,
  ModelsContext,
  ProjectsContext,
  StorageInfoContext,
  type AppActions,
  type AppStatus,
  type ImportOptions,
  type ModelsByApiDefinition,
  type StorageInfo,
  type StorageQuota,
} from './createAppContext';
import type {
  ExportProgressCallback,
  ImportProgressCallback,
} from '../../shared/protocol/types/data';
import { clearCachedCEK, getCachedCEKString, setCachedCEKString } from '../lib/localStorageBoot';
import { cleanupExpiredDrafts } from '../hooks/useDraftPersistence';
import { downloadBlob } from '../lib/download';

/**
 * Mirrors the backend's `isBase32` check on a CEK string. Local helper —
 * we use it only for the "show convert legacy CEK" UI hint, not for any
 * actual decoding (the backend owns that). Inlined here so the frontend
 * imports zero CEK format helpers.
 */
function looksLikeBase32CEK(value: string): boolean {
  const normalized = value.toLowerCase().replace(/\s/g, '');
  return /^[a-z2-7]+$/.test(normalized);
}

/**
 * Put one definition's model list into the map, keeping the old map when the
 * list is unchanged. Every fetch returns freshly deserialized objects, so
 * compare contents: a new map re-renders every model consumer.
 */
function withModelList(
  prev: ModelsByApiDefinition,
  apiDefinitionId: string,
  list: Model[]
): ModelsByApiDefinition {
  const current = prev.get(apiDefinitionId);
  if (current && JSON.stringify(current) === JSON.stringify(list)) return prev;
  return new Map(prev).set(apiDefinitionId, list);
}

function sameQuota(a: StorageQuota | null, b: StorageQuota | null): boolean {
  if (a === null || b === null) return a === b;
  return a.usage === b.usage && a.quota === b.quota;
}

/**
 * Re-reads a list after a write that already landed. A failure here (the
 * socket dropped between the two calls) is logged, not thrown: the caller
 * would report a save that worked as failed, and a retry could duplicate it.
 */
async function refreshAfterWrite(refresh: () => Promise<void>, what: string): Promise<void> {
  try {
    await refresh();
  } catch (err) {
    console.debug('[AppContext] %s refresh after a write failed: %o', what, err);
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [apiDefinitions, setAPIDefinitions] = useState<APIDefinition[]>([]);
  // clearAllModelsCache reads the list through this ref so it doesn't depend
  // on it, which keeps the actions object stable.
  const apiDefinitionsRef = useRef<APIDefinition[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<ModelsByApiDefinition>(() => new Map());

  const [isInitializing, setIsInitializing] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);
  const [storageQuota, setStorageQuota] = useState<StorageQuota | null>(null);

  const refreshStorageQuota = useCallback(async () => {
    try {
      const quota = await gremlinClient.getStorageQuota();
      // The protocol returns a non-nullable shape ({usage:0, quota:0} when
      // unavailable); preserve the old null sentinel for the loading hint UI.
      const next = quota.quota === 0 && quota.usage === 0 ? null : quota;
      // WelcomeScreen refreshes on every visit; an identical reading keeps the
      // old object so storage-info consumers don't re-render.
      setStorageQuota(prev => (sameQuota(prev, next) ? prev : next));
    } catch (error) {
      console.error('[AppContext] Failed to get storage quota:', error);
      setStorageQuota(null);
    }
  }, []);

  const purgeAllData = useCallback(async () => {
    console.debug('[AppContext] Purging all data...');

    // Purge storage (deletes database)
    await gremlinClient.purgeAllData();
    console.debug('[AppContext] Storage purged');

    // Tear down the worker's in-memory CEK + clear local persistence so
    // the next reload routes to OOBE.
    await gremlinClient.clearCek();
    clearCachedCEK();
    console.debug('[AppContext] CEK cleared');

    // Reload the page to trigger OOBE
    console.debug('[AppContext] Reloading to trigger OOBE...');
    window.location.reload();
  }, []);

  const refreshAPIDefinitions = useCallback(async () => {
    console.debug('[AppContext] refreshAPIDefinitions: Fetching from backend...');
    const defs = await gremlinClient.getAPIDefinitions();
    console.debug(
      `[AppContext] refreshAPIDefinitions: Got ${defs.length} definitions, updating state...`
    );
    apiDefinitionsRef.current = defs;
    setAPIDefinitions(defs);
    console.debug('[AppContext] refreshAPIDefinitions: State updated');
  }, []);

  const saveAPIDefinitionHandler = useCallback(
    async (definition: APIDefinition) => {
      await gremlinClient.saveAPIDefinition(definition);
      await refreshAfterWrite(refreshAPIDefinitions, 'API definitions');
    },
    [refreshAPIDefinitions]
  );

  const deleteAPIDefinitionHandler = useCallback(
    async (id: string) => {
      await gremlinClient.deleteAPIDefinition(id);
      await gremlinClient.deleteModelsCache(id);
      setModels(prev => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      await refreshAfterWrite(refreshAPIDefinitions, 'API definitions');
    },
    [refreshAPIDefinitions]
  );

  const refreshProjects = useCallback(async () => {
    setProjects(await gremlinClient.getProjects());
  }, []);

  const saveProjectHandler = useCallback(
    async (project: Project) => {
      await gremlinClient.saveProject(project);
      await refreshAfterWrite(refreshProjects, 'projects');
    },
    [refreshProjects]
  );

  const patchProjectHandler = useCallback(
    async (
      projectId: string,
      fields: Partial<Project>,
      opts?: { touch?: boolean; unset?: (keyof Project)[] }
    ) => {
      const merged = await gremlinClient.patchProject(projectId, fields, opts);
      await refreshAfterWrite(refreshProjects, 'projects');
      return merged;
    },
    [refreshProjects]
  );

  const deleteProjectHandler = useCallback(
    async (id: string) => {
      await gremlinClient.deleteProject(id);
      await refreshAfterWrite(refreshProjects, 'projects');
    },
    [refreshProjects]
  );

  const refreshModels = useCallback(
    async (apiDefinitionId: string, forceRefresh = false, skipWaitingModelRefresh = false) => {
      try {
        // Cache age check stays frontend-side as a UX choice — when the
        // cache is fresh we skip the round-trip entirely. Backend owns
        // everything else: no-API-key fallback, discovery error fallback,
        // mergeExtraModels, and the cache write all happen inside
        // `gremlinClient.discoverModels` (Phase 1.8 leak fix).
        if (!forceRefresh) {
          const cached = await gremlinClient.getModelsCache(apiDefinitionId);
          if (cached.models.length > 0 && cached.cachedAt) {
            const ageMs = Date.now() - cached.cachedAt;
            const maxAgeMs = 24 * 60 * 60 * 1000; // 1 day

            if (ageMs < maxAgeMs) {
              console.debug(
                `[AppContext] Using cached models for ${apiDefinitionId} (age: ${Math.round(ageMs / 1000 / 60)} minutes)`
              );
              setModels(prev => withModelList(prev, apiDefinitionId, cached.models));
              return;
            } else {
              console.debug(
                `[AppContext] Cache expired for ${apiDefinitionId} (age: ${Math.round(ageMs / 1000 / 60 / 60)} hours), fetching...`
              );
            }
          }
        }

        console.debug(`[AppContext] Fetching models from API for ${apiDefinitionId}...`);
        const discoverModelsPromise = gremlinClient
          .discoverModels(apiDefinitionId)
          .then(discoveredModels => {
            setModels(prev => withModelList(prev, apiDefinitionId, discoveredModels));
          });
        if (!skipWaitingModelRefresh) {
          await discoverModelsPromise;
        }
      } catch (error) {
        console.error('Failed to refresh models:', error);
      }
    },
    []
  );

  const handleExport = useCallback(async (onProgress?: ExportProgressCallback) => {
    console.debug('[AppContext] Starting streaming data export...');
    try {
      // Backend streams the bundle out as `chunk` events; the client
      // assembles them into a Blob and returns the suggested filename.
      const { blob, suggestedName } = await gremlinClient.exportToBlob(onProgress);
      downloadBlob(blob, suggestedName);

      console.debug('[AppContext] Data export complete!');
    } catch (error) {
      console.error('[AppContext] Export failed:', error);
      throw error;
    }
  }, []);

  // Read a File to a Uint8Array on the main thread before posting through to
  // the backend. The worker / WebSocket boundary doesn't accept File refs;
  // bytes are the lowest common denominator.
  const fileToBytes = useCallback(async (file: File): Promise<Uint8Array> => {
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }, []);

  // CEK is read from localStorage on the main thread — the worker holds
  // the bytes in memory but doesn't expose the string. The only main-
  // thread localStorage read in the frontend codepath, alongside
  // bootstrapClient. Declared up here (above handleMigrate / handleImport)
  // so those callbacks can call setCek / setIsCEKBase32 without tripping
  // the access-before-declaration check.
  const [cek, setCek] = useState<string | null>(() => getCachedCEKString());
  const [isCEKBase32, setIsCEKBase32] = useState<boolean | null>(() => {
    const cached = getCachedCEKString();
    return cached ? looksLikeBase32CEK(cached) : null;
  });

  const convertCEKToBase32 = useCallback(async (): Promise<string | null> => {
    const current = getCachedCEKString();
    if (!current) return null;
    if (looksLikeBase32CEK(current)) return current;

    const newCEK = await gremlinClient.normalizeCEK(current);
    setCachedCEKString(newCEK);
    setCek(newCEK);
    setIsCEKBase32(true);
    return newCEK;
  }, [setCek, setIsCEKBase32]);

  const handleImport = useCallback(
    async (
      file: File,
      sourceCEK: string,
      onProgress?: ImportProgressCallback,
      options?: ImportOptions
    ): Promise<{ imported: number; skipped: number; errors: string[] }> => {
      console.debug('[AppContext] Starting streaming data import...');
      try {
        const data = await fileToBytes(file);
        const result = await gremlinClient.importFromBytes(
          data,
          sourceCEK,
          'merge',
          progress => {
            onProgress?.({
              processed: progress.processed,
              imported: progress.imported,
              skipped: progress.skipped,
              errors: progress.errors,
              estimatedTotal: progress.estimatedTotal,
            });
          },
          {
            skipVfsMigration: options?.skipVfsMigration,
            onVfsMigrationProgress: options?.onVfsMigrationProgress,
          }
        );

        console.debug(
          `[AppContext] Import complete: ${result.imported} imported, ${result.skipped} skipped, ${result.errors.length} errors`
        );

        // Refresh all data
        await refreshAPIDefinitions();
        await refreshProjects();

        // Reload models for all API definitions
        const defs = await gremlinClient.getAPIDefinitions();
        for (const def of defs) {
          if ((def.apiKey && def.apiKey.trim() !== '') || apiKeyOptional(def)) {
            await refreshModels(def.id);
          }
        }

        // Refresh storage quota after import
        await refreshStorageQuota();

        return result;
      } catch (error) {
        console.error('[AppContext] Import failed:', error);
        throw error;
      }
    },
    [fileToBytes, refreshAPIDefinitions, refreshProjects, refreshModels, refreshStorageQuota]
  );

  const handleMigrate = useCallback(
    async (
      file: File,
      sourceCEK: string,
      onProgress?: ImportProgressCallback,
      options?: ImportOptions
    ): Promise<{ imported: number; skipped: number; errors: string[] }> => {
      console.debug('[AppContext] Starting streaming data migration...');
      try {
        const data = await fileToBytes(file);
        const result = await gremlinClient.importFromBytes(
          data,
          sourceCEK,
          'replace',
          progress => {
            onProgress?.({
              processed: progress.processed,
              imported: progress.imported,
              skipped: progress.skipped,
              errors: progress.errors,
              estimatedTotal: progress.estimatedTotal,
            });
          },
          {
            skipVfsMigration: options?.skipVfsMigration,
            onVfsMigrationProgress: options?.onVfsMigrationProgress,
          }
        );

        console.debug(
          `[AppContext] Migration complete: ${result.imported} imported, ${result.skipped} skipped, ${result.errors.length} errors`
        );

        // The active CEK is unchanged: `migrateDataFromFile` re-encrypts
        // every imported row (and the oracle) under the CURRENT app key.
        // The source CEK was only needed to decrypt the backup — persisting
        // it here would brick the next boot with CEK_MISMATCH.

        // Refresh all data (migration already loaded everything, but refresh for React state)
        await refreshAPIDefinitions();
        await refreshProjects();

        // Reload models for all API definitions
        const defs = await gremlinClient.getAPIDefinitions();
        for (const def of defs) {
          if ((def.apiKey && def.apiKey.trim() !== '') || apiKeyOptional(def)) {
            await refreshModels(def.id);
          }
        }

        return result;
      } catch (error) {
        console.error('[AppContext] Migration failed:', error);
        throw error;
      }
    },
    [fileToBytes, refreshAPIDefinitions, refreshProjects, refreshModels]
  );

  const clearAllModelsCache = useCallback(async () => {
    for (const def of apiDefinitionsRef.current) {
      await gremlinClient.deleteModelsCache(def.id);
    }
    setModels(prev => (prev.size === 0 ? prev : new Map()));
  }, []);

  const handleCompressMessages = useCallback(async (): Promise<{
    total: number;
    compressed: number;
    skipped: number;
    errors: number;
  }> => {
    console.debug('[AppContext] Starting bulk message compression...');
    try {
      // PR 12 will switch this to a streaming RPC with per-chat progress.
      // For now we surface only the compressed count and synthesize the
      // legacy result shape so callers don't break.
      const { compressedCount } = await gremlinClient.compressAllMessages();

      console.debug(`[AppContext] Compression complete: ${compressedCount} compressed`);

      // Refresh storage quota after compression
      await refreshStorageQuota();

      return {
        total: compressedCount,
        compressed: compressedCount,
        skipped: 0,
        errors: 0,
      };
    } catch (error) {
      console.error('[AppContext] Compression failed:', error);
      throw error;
    }
  }, [refreshStorageQuota]);

  // Runs once the backend's `init` succeeded
  const loadInitialData = useCallback(async () => {
    console.debug('[AppContext] Backend initialized, refreshing API definitions...');
    await refreshAPIDefinitions();
    console.debug('[AppContext] API definitions refreshed, refreshing projects...');
    // Load models for all API definitions with credentials
    const defsWithCredentials = apiDefinitionsRef.current.filter(
      d => apiKeyOptional(d) || (d.apiKey && d.apiKey.trim() !== '')
    );
    console.debug(
      `[AppContext] Loading models for ${defsWithCredentials.length} configured providers...`
    );
    // Projects load alongside the models (skipWaitingModelRefresh for faster
    // init). Awaited, so a failure lands on the init error screen.
    await Promise.all([
      refreshProjects(),
      Promise.allSettled(defsWithCredentials.map(def => refreshModels(def.id, false, true))),
    ]);
    console.debug('[AppContext] App initialization complete!');

    // Refresh storage quota after initialization
    await refreshStorageQuota();
  }, [refreshAPIDefinitions, refreshProjects, refreshModels, refreshStorageQuota]);

  useEffect(() => {
    // async so a synchronous throw (no Worker support, blocked storage) lands
    // in the catch below too
    const initBackend = async () => {
      console.debug('[AppContext] Starting app initialization...');

      // Clean up expired drafts early in initialization
      cleanupExpiredDrafts();

      const cachedCek = getCachedCEKString();
      await gremlinClient.init(cachedCek ? { cek: cachedCek } : {});
    };
    initBackend()
      .then(loadInitialData)
      .catch((error: unknown) => {
        // Bad CEK, unreachable backend: AppContent shows a "Couldn't start"
        // screen instead of an empty shell.
        console.error('[AppContext] App initialization failed:', error);
        setInitError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setIsInitializing(false));
  }, [loadInitialData]);

  // Every member is a stable callback, so this object keeps its identity for
  // the provider's lifetime.
  const actions = useMemo<AppActions>(
    () => ({
      refreshAPIDefinitions,
      saveAPIDefinition: saveAPIDefinitionHandler,
      deleteAPIDefinition: deleteAPIDefinitionHandler,
      refreshProjects,
      saveProject: saveProjectHandler,
      patchProject: patchProjectHandler,
      deleteProject: deleteProjectHandler,
      refreshModels,
      clearAllModelsCache,
      purgeAllData,
      handleExport,
      handleImport,
      handleMigrate,
      handleCompressMessages,
      convertCEKToBase32,
      refreshStorageQuota,
    }),
    [
      refreshAPIDefinitions,
      saveAPIDefinitionHandler,
      deleteAPIDefinitionHandler,
      refreshProjects,
      saveProjectHandler,
      patchProjectHandler,
      deleteProjectHandler,
      refreshModels,
      clearAllModelsCache,
      purgeAllData,
      handleExport,
      handleImport,
      handleMigrate,
      handleCompressMessages,
      convertCEKToBase32,
      refreshStorageQuota,
    ]
  );

  const storageInfo = useMemo<StorageInfo>(
    () => ({ cek, isCEKBase32, storageQuota }),
    [cek, isCEKBase32, storageQuota]
  );

  const status = useMemo<AppStatus>(
    () => ({ isInitializing, initError }),
    [isInitializing, initError]
  );

  return (
    <AppActionsContext.Provider value={actions}>
      <AppStatusContext.Provider value={status}>
        <ApiDefinitionsContext.Provider value={apiDefinitions}>
          <ProjectsContext.Provider value={projects}>
            <ModelsContext.Provider value={models}>
              <StorageInfoContext.Provider value={storageInfo}>
                {children}
              </StorageInfoContext.Provider>
            </ModelsContext.Provider>
          </ProjectsContext.Provider>
        </ApiDefinitionsContext.Provider>
      </AppStatusContext.Provider>
    </AppActionsContext.Provider>
  );
}
