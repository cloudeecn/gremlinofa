import { type ReactNode, useEffect, useState } from 'react';
import { apiService } from '../services/api/apiService';
import { storage } from '../services/storage';
import type { APIDefinition, Model, Project } from '../types';
import { AppContext, type AppContextType } from './createAppContext';
import { createExportBlob, type ExportProgressCallback } from '../utils/dataExport';
import {
  importDataFromFile,
  migrateDataFromFile,
  type ImportProgressCallback,
} from '../utils/dataImport';
import { encryptionService } from '../services/encryption/encryptionService';
import { cleanupExpiredDrafts } from '../hooks/useDraftPersistence';

export function AppProvider({ children }: { children: ReactNode }) {
  const [apiDefinitions, setAPIDefinitions] = useState<APIDefinition[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<Map<string, Model[]>>(new Map());

  const [isInitializing, setIsInitializing] = useState(true);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);

  // Initialize app
  useEffect(() => {
    initializeApp();
  }, []);

  const initializeApp = async () => {
    try {
      console.debug('[AppContext] Starting app initialization...');

      // Clean up expired drafts early in initialization
      cleanupExpiredDrafts();

      await storage.initialize();
      console.debug('[AppContext] Storage initialized, refreshing API definitions...');
      await refreshAPIDefinitions();
      console.debug('[AppContext] API definitions refreshed, refreshing projects...');
      refreshProjects();
      // Load models for all default API definitions
      const defs = await storage.getAPIDefinitions();
      console.debug(
        `[AppContext] Loading models for ${
          defs.filter(d => d.isDefault).length
        } default definitions...`
      );
      for (const def of defs.filter(d => d.isDefault)) {
        await refreshModels(def.id, true);
      }
      console.debug('[AppContext] App initialization complete!');
    } finally {
      setIsInitializing(false);
    }
  };

  const purgeAllData = async () => {
    console.debug('[AppContext] Purging all data...');

    // Purge storage (deletes database)
    await storage.purgeAllData();
    console.debug('[AppContext] Storage purged');

    // Clear CEK from localStorage to trigger OOBE on next load
    await encryptionService.clearCEK();
    console.debug('[AppContext] CEK cleared');

    // Reload the page to trigger OOBE
    console.debug('[AppContext] Reloading to trigger OOBE...');
    window.location.reload();
  };

  const refreshAPIDefinitions = async () => {
    console.debug('[AppContext] refreshAPIDefinitions: Fetching from storage...');
    const defs = await storage.getAPIDefinitions();
    console.debug(
      `[AppContext] refreshAPIDefinitions: Got ${defs.length} definitions, updating state...`
    );
    setAPIDefinitions(defs);
    console.debug('[AppContext] refreshAPIDefinitions: State updated');
  };

  const saveAPIDefinitionHandler = async (definition: APIDefinition) => {
    await storage.saveAPIDefinition(definition);
    await refreshAPIDefinitions();
  };

  const deleteAPIDefinitionHandler = async (id: string) => {
    await storage.deleteAPIDefinition(id);
    await storage.deleteModels(id);
    // Remove models from state
    setModels(prev => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    await refreshAPIDefinitions();
  };

  const refreshProjects = async () => {
    setIsLoadingProjects(true);
    try {
      const projs = await storage.getProjects();
      setProjects(projs);
    } finally {
      setIsLoadingProjects(false);
    }
  };

  const saveProjectHandler = async (project: Project) => {
    await storage.saveProject(project);
    await refreshProjects();
  };

  const deleteProjectHandler = async (id: string) => {
    await storage.deleteProject(id);
    await refreshProjects();
  };

  const refreshModels = async (apiDefinitionId: string, skipWaitingModelRefresh?: boolean) => {
    setIsLoadingModels(true);
    try {
      const apiDef = await storage.getAPIDefinition(apiDefinitionId);
      if (!apiDef) {
        console.error('API definition not found:', apiDefinitionId);
        return;
      }

      // Skip refresh if API key is not configured (except for WebLLM which doesn't need one)
      if (apiDef.apiType !== 'webllm' && (!apiDef.apiKey || apiDef.apiKey.trim() === '')) {
        console.debug('Skipping model refresh for', apiDefinitionId, '- no API key configured');
        return;
      }

      const discoverModelsPromise = apiService
        .discoverModels(apiDef)
        .then(async discoveredModels => {
          setModels(prev => new Map(prev).set(apiDefinitionId, discoveredModels));
          await storage.saveModels(apiDefinitionId, discoveredModels);
        });
      if (!skipWaitingModelRefresh) {
        await discoverModelsPromise;
      }
    } catch (error) {
      console.error('Failed to refresh models:', error);
    } finally {
      setIsLoadingModels(false);
    }
  };

  const handleExport = async (onProgress?: ExportProgressCallback) => {
    console.debug('[AppContext] Starting streaming data export...');
    try {
      const adapter = storage.getAdapter();

      // Create blob using streaming chunked assembly (memory-efficient)
      // Pass encryptionService to include default API definitions with credentials
      const blob = await createExportBlob(adapter, encryptionService, 100, onProgress);

      // Download the blob
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `gremlinofa-backup-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      console.debug('[AppContext] Data export complete!');
    } catch (error) {
      console.error('[AppContext] Export failed:', error);
      throw error;
    }
  };

  const handleImport = async (
    file: File,
    sourceCEK: string,
    onProgress?: ImportProgressCallback
  ): Promise<{ imported: number; skipped: number; errors: string[] }> => {
    console.debug('[AppContext] Starting streaming data import...');
    try {
      // Get adapter and perform streaming import (memory-efficient for large files)
      const adapter = storage.getAdapter();
      const result = await importDataFromFile(
        adapter,
        file,
        sourceCEK,
        encryptionService,
        onProgress
      );

      console.debug(
        `[AppContext] Import complete: ${result.imported} imported, ${result.skipped} skipped, ${result.errors.length} errors`
      );

      // Refresh all data
      await refreshAPIDefinitions();
      await refreshProjects();

      // Reload models for all API definitions
      const defs = await storage.getAPIDefinitions();
      for (const def of defs) {
        // Refresh if has API key OR is WebLLM (which doesn't need one)
        if ((def.apiKey && def.apiKey.trim() !== '') || def.apiType === 'webllm') {
          await refreshModels(def.id);
        }
      }

      return result;
    } catch (error) {
      console.error('[AppContext] Import failed:', error);
      throw error;
    }
  };

  const handleMigrate = async (
    file: File,
    sourceCEK: string,
    onProgress?: ImportProgressCallback
  ): Promise<{ imported: number; skipped: number; errors: string[] }> => {
    console.debug('[AppContext] Starting streaming data migration...');
    try {
      // Get adapter and perform streaming migration (memory-efficient for large files)
      const adapter = storage.getAdapter();
      const result = await migrateDataFromFile(
        adapter,
        file,
        sourceCEK,
        encryptionService,
        onProgress
      );

      console.debug(
        `[AppContext] Migration complete: ${result.imported} imported, ${result.skipped} skipped, ${result.errors.length} errors`
      );

      // Update CEK in state (it was changed by migration)
      const newCEK = encryptionService.getCEK();
      setCek(newCEK);

      // Refresh all data (migration already loaded everything, but refresh for React state)
      await refreshAPIDefinitions();
      await refreshProjects();

      // Reload models for all API definitions
      const defs = await storage.getAPIDefinitions();
      for (const def of defs) {
        // Refresh if has API key OR is WebLLM (which doesn't need one)
        if ((def.apiKey && def.apiKey.trim() !== '') || def.apiType === 'webllm') {
          await refreshModels(def.id);
        }
      }

      return result;
    } catch (error) {
      console.error('[AppContext] Migration failed:', error);
      throw error;
    }
  };

  // Load CEK from encryptionService
  const [cek, setCek] = useState<string | null>(null);
  const [isCEKBase32, setIsCEKBase32] = useState<boolean | null>(null);

  useEffect(() => {
    setCek(encryptionService.getCEK());
    setIsCEKBase32(encryptionService.isCEKBase32());
  }, []);

  const convertCEKToBase32 = (): string | null => {
    const newCEK = encryptionService.convertCEKToBase32();
    if (newCEK) {
      setCek(newCEK);
      setIsCEKBase32(true);
    }
    return newCEK;
  };

  const handleCompressMessages = async (): Promise<{
    total: number;
    compressed: number;
    skipped: number;
    errors: number;
  }> => {
    console.debug('[AppContext] Starting bulk message compression...');
    try {
      const result = await storage.compressAllMessages((processed, total, chatName) => {
        console.debug(`[AppContext] Compression progress: ${processed}/${total} (${chatName})`);
      });

      console.debug(
        `[AppContext] Compression complete: ${result.compressed} compressed, ${result.skipped} skipped, ${result.errors} errors`
      );

      return result;
    } catch (error) {
      console.error('[AppContext] Compression failed:', error);
      throw error;
    }
  };

  const value: AppContextType = {
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
    handleCompressMessages,
    isInitializing,
    isLoadingProjects,
    isLoadingModels,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
