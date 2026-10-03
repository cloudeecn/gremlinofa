import { createContext } from 'react';
import type { APIDefinition, Model, Project } from '../../shared/protocol/types';
import type {
  ExportProgressCallback,
  ImportProgressCallback,
} from '../../shared/protocol/types/data';

export type { ExportProgressCallback, ImportProgressCallback };

export interface ImportOptions {
  skipVfsMigration?: boolean;
  onVfsMigrationProgress?: (progress: {
    projectId: string;
    projectName: string;
    filesProcessed: number;
    totalFiles: number;
    versionsProcessed: number;
  }) => void;
}

/**
 * Every AppProvider callback. The object keeps its identity for the life of
 * the provider, so a component that only calls actions never re-renders
 * because data changed.
 */
export interface AppActions {
  refreshAPIDefinitions: () => Promise<void>;
  saveAPIDefinition: (definition: APIDefinition) => Promise<void>;
  deleteAPIDefinition: (id: string) => Promise<void>;

  refreshProjects: () => Promise<void>;
  saveProject: (project: Project) => Promise<void>;
  /**
   * Surgically update a project (merge-not-overwrite) so concurrent edits and a
   * finishing loop's `lastUsedAt` bump don't clobber. Returns the merged project.
   */
  patchProject: (
    projectId: string,
    fields: Partial<Project>,
    opts?: { touch?: boolean; unset?: (keyof Project)[] }
  ) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;

  refreshModels: (
    apiDefinitionId: string,
    forceRefresh?: boolean,
    skipWaitingModelRefresh?: boolean
  ) => Promise<void>;
  clearAllModelsCache: () => Promise<void>;

  purgeAllData: () => Promise<void>;
  handleExport: (onProgress?: ExportProgressCallback) => Promise<void>;
  handleImport: (
    file: File,
    sourceCEK: string,
    onProgress?: ImportProgressCallback,
    options?: ImportOptions
  ) => Promise<{ imported: number; skipped: number; errors: string[] }>;
  handleMigrate: (
    file: File,
    sourceCEK: string,
    onProgress?: ImportProgressCallback,
    options?: ImportOptions
  ) => Promise<{ imported: number; skipped: number; errors: string[] }>;
  handleCompressMessages: () => Promise<{
    total: number;
    compressed: number;
    skipped: number;
    errors: number;
  }>;
  convertCEKToBase32: () => Promise<string | null>;
  refreshStorageQuota: () => Promise<void>;
}

export interface StorageQuota {
  usage: number;
  quota: number;
}

export interface StorageInfo {
  cek: string | null;
  isCEKBase32: boolean | null;
  storageQuota: StorageQuota | null;
}

/**
 * Where the boot screen is: reaching the backend, unlocking storage, or
 * loading the first data. Once `initError` is set, the step that failed.
 */
export type BootStep = 'backend' | 'unlock' | 'data';

export interface AppStatus {
  isInitializing: boolean;
  /** Message of the failed `init` (bad CEK, backend down); null while healthy. */
  initError: string | null;
  bootStep: BootStep;
}

/** Models keyed by API definition ID. */
export type ModelsByApiDefinition = Map<string, Model[]>;

/** Everything at once — what `useApp()` returns. */
export interface AppContextType extends AppActions, StorageInfo, AppStatus {
  apiDefinitions: APIDefinition[];
  projects: Project[];
  models: ModelsByApiDefinition;
}

// One context per update rate: a consumer re-renders only when the slice it
// reads changes (a `patchProject` refresh doesn't reach an icon lookup).
export const AppActionsContext = createContext<AppActions | undefined>(undefined);
export const ApiDefinitionsContext = createContext<APIDefinition[] | undefined>(undefined);
export const ProjectsContext = createContext<Project[] | undefined>(undefined);
export const ModelsContext = createContext<ModelsByApiDefinition | undefined>(undefined);
export const StorageInfoContext = createContext<StorageInfo | undefined>(undefined);
export const AppStatusContext = createContext<AppStatus | undefined>(undefined);
