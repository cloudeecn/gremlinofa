import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { gremlinClient } from '../client';
import type { APIDefinition, Model, Project } from '../../shared/protocol/types';
import { AppContext, type AppContextType } from './createAppContext';
import type {
  ExportProgressCallback,
  ImportProgressCallback,
} from '../../shared/protocol/types/data';
import { clearCachedCEK, getCachedCEKString, setCachedCEKString } from '../lib/localStorageBoot';
import { cleanupExpiredDrafts } from '../hooks/useDraftPersistence';

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

export function AppProvider({ children }: { children: ReactNode }) {
  const [apiDefinitions, setAPIDefinitions] = useState<APIDefinition[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<Map<string, Model[]>>(new Map());

  const [isInitializing, setIsInitializing] = useState(true);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [storageQuota, setStorageQuota] = useState<{ usage: number; quota: number } | null>(null);

  // Refresh storage quota
  const refreshStorageQuota = useCallback(async () => {
    try {
      const quota = await gremlinClient.getStorageQuota();
      // The protocol returns a non-nullable shape ({usage:0, quota:0} when
      // unavailable); preserve the old null sentinel for the loading hint UI.
      setStorageQuota(quota.quota === 0 && quota.usage === 0 ? null : quota);
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
    setAPIDefinitions(defs);
    console.debug('[AppContext] refreshAPIDefinitions: State updated');
  }, []);

  const saveAPIDefinitionHandler = useCallback(
    async (definition: APIDefinition) => {
      await gremlinClient.saveAPIDefinition(definition);
      await refreshAPIDefinitions();
    },
    [refreshAPIDefinitions]
  );

  const deleteAPIDefinitionHandler = useCallback(
    async (id: string) => {
      await gremlinClient.deleteAPIDefinition(id);
      await gremlinClient.deleteModelsCache(id);
      // Remove models from state
      setModels(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      await refreshAPIDefinitions();
    },
    [refreshAPIDefinitions]
  );

  const refreshProjects = useCallback(async () => {
    setIsLoadingProjects(true);
    try {
      const projs = await gremlinClient.getProjects();
      setProjects(projs);
    } finally {
      setIsLoadingProjects(false);
    }
  }, []);

  const saveProjectHandler = useCallback(
    async (project: Project) => {
      await gremlinClient.saveProject(project);
      await refreshProjects();
    },
    [refreshProjects]
  );

  const deleteProjectHandler = useCallback(
    async (id: string) => {
      await gremlinClient.deleteProject(id);
      await refreshProjects();
    },
    [refreshProjects]
  );

  const refreshModels = useCallback(
    async (apiDefinitionId: string, forceRefresh = false, skipWaitingModelRefresh = false) => {
      setIsLoadingModels(true);
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
              setModels(prev => new Map(prev).set(apiDefinitionId, cached.models));
              setIsLoadingModels(false);
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
            setModels(prev => new Map(prev).set(apiDefinitionId, discoveredModels));
          });
        if (!skipWaitingModelRefresh) {
          await discoverModelsPromise;
        }
      } catch (error) {
        console.error('Failed to refresh models:', error);
      } finally {
        setIsLoadingModels(false);
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

      // DOM anchor + download click stays on the main thread.
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = suggestedName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

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

  const handleImport = useCallback(
    async (
      file: File,
      sourceCEK: string,
      onProgress?: ImportProgressCallback
    ): Promise<{ imported: number; skipped: number; errors: string[] }> => {
      console.debug('[AppContext] Starting streaming data import...');
      try {
        const data = await fileToBytes(file);
        const result = await gremlinClient.importFromBytes(data, sourceCEK, 'merge', progress => {
          onProgress?.({
            processed: progress.processed,
            imported: progress.imported,
            skipped: progress.skipped,
            errors: progress.errors,
            estimatedTotal: progress.estimatedTotal,
          });
        });

        console.debug(
          `[AppContext] Import complete: ${result.imported} imported, ${result.skipped} skipped, ${result.errors.length} errors`
        );

        // Refresh all data
        await refreshAPIDefinitions();
        await refreshProjects();

        // Reload models for all API definitions
        const defs = await gremlinClient.getAPIDefinitions();
        for (const def of defs) {
          if ((def.apiKey && def.apiKey.trim() !== '') || def.isLocal) {
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
      onProgress?: ImportProgressCallback
    ): Promise<{ imported: number; skipped: number; errors: string[] }> => {
      console.debug('[AppContext] Starting streaming data migration...');
      try {
        const data = await fileToBytes(file);
        const result = await gremlinClient.importFromBytes(data, sourceCEK, 'replace', progress => {
          onProgress?.({
            processed: progress.processed,
            imported: progress.imported,
            skipped: progress.skipped,
            errors: progress.errors,
            estimatedTotal: progress.estimatedTotal,
          });
        });

        console.debug(
          `[AppContext] Migration complete: ${result.imported} imported, ${result.skipped} skipped, ${result.errors.length} errors`
        );

        // After 'replace' migration the worker's active CEK is the source
        // CEK from the bundle. Persist it to localStorage so the next page
        // load can bootstrap with the new key.
        setCachedCEKString(sourceCEK);
        setCek(sourceCEK);
        setIsCEKBase32(looksLikeBase32CEK(sourceCEK));

        // Refresh all data (migration already loaded everything, but refresh for React state)
        await refreshAPIDefinitions();
        await refreshProjects();

        // Reload models for all API definitions
        const defs = await gremlinClient.getAPIDefinitions();
        for (const def of defs) {
          if ((def.apiKey && def.apiKey.trim() !== '') || def.isLocal) {
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

  // CEK is read from localStorage on the main thread — the worker holds
  // the bytes in memory but doesn't expose the string. The only main-
  // thread localStorage read in the frontend codepath, alongside
  // bootstrapClient.
  const [cek, setCek] = useState<string | null>(null);
  const [isCEKBase32, setIsCEKBase32] = useState<boolean | null>(null);

  useEffect(() => {
    const cached = getCachedCEKString();
    setCek(cached);
    setIsCEKBase32(cached ? looksLikeBase32CEK(cached) : null);
  }, []);

  const convertCEKToBase32 = useCallback(async (): Promise<string | null> => {
    const current = getCachedCEKString();
    if (!current) return null;
    if (looksLikeBase32CEK(current)) return current;

    const newCEK = await gremlinClient.normalizeCEK(current);
    setCachedCEKString(newCEK);
    setCek(newCEK);
    setIsCEKBase32(true);
    return newCEK;
  }, []);

  const clearAllModelsCache = useCallback(async () => {
    for (const def of apiDefinitions) {
      await gremlinClient.deleteModelsCache(def.id);
    }
    setModels(new Map());
  }, [apiDefinitions]);

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

  // Initialize app
  const initializeApp = useCallback(async () => {
    try {
      console.debug('[AppContext] Starting app initialization...');

      // Clean up expired drafts early in initialization
      cleanupExpiredDrafts();

      await gremlinClient.init();
      console.debug('[AppContext] Backend initialized, refreshing API definitions...');
      await refreshAPIDefinitions();
      console.debug('[AppContext] API definitions refreshed, refreshing projects...');
      refreshProjects();
      // Load models for all API definitions with credentials
      const defs = await gremlinClient.getAPIDefinitions();
      const defsWithCredentials = defs.filter(
        d => d.isLocal || (d.apiKey && d.apiKey.trim() !== '')
      );
      console.debug(
        `[AppContext] Loading models for ${defsWithCredentials.length} configured providers...`
      );
      // Load models in parallel with skipWaitingModelRefresh for faster init
      await Promise.allSettled(defsWithCredentials.map(def => refreshModels(def.id, false, true)));
      console.debug('[AppContext] App initialization complete!');

      // Refresh storage quota after initialization
      await refreshStorageQuota();
    } finally {
      setIsInitializing(false);
    }
  }, [refreshAPIDefinitions, refreshProjects, refreshModels, refreshStorageQuota]);

  useEffect(() => {
    initializeApp();
  }, [initializeApp]);

  // Memoize context value to prevent unnecessary re-renders of consumers.
  const value = useMemo<AppContextType>(
    () => ({
      apiDefinitions,
      refreshAPIDefinitions,
      saveAPIDefinition: saveAPIDefinitionHandler,
      deleteAPIDefinition: deleteAPIDefinitionHandler,
      projects,
      refreshProjects,
      saveProject: saveProjectHandler,
      deleteProject: deleteProjectHandler,
      models,
      refreshModels,
      purgeAllData,
      handleExport,
      handleImport,
      handleMigrate,
      cek,
      isCEKBase32,
      convertCEKToBase32,
      clearAllModelsCache,
      handleCompressMessages,
      storageQuota,
      refreshStorageQuota,
      isInitializing,
      isLoadingProjects,
      isLoadingModels,
    }),
    [
      apiDefinitions,
      refreshAPIDefinitions,
      saveAPIDefinitionHandler,
      deleteAPIDefinitionHandler,
      projects,
      refreshProjects,
      saveProjectHandler,
      deleteProjectHandler,
      models,
      refreshModels,
      purgeAllData,
      handleExport,
      handleImport,
      handleMigrate,
      cek,
      isCEKBase32,
      convertCEKToBase32,
      clearAllModelsCache,
      handleCompressMessages,
      storageQuota,
      refreshStorageQuota,
      isInitializing,
      isLoadingProjects,
      isLoadingModels,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
