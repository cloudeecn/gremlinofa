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

export interface AppContextType {
  // API Definitions
  apiDefinitions: APIDefinition[];
  refreshAPIDefinitions: () => Promise<void>;
  saveAPIDefinition: (definition: APIDefinition) => Promise<void>;
  deleteAPIDefinition: (id: string) => Promise<void>;

  // Projects
  projects: Project[];
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

  // Models - now keyed by API definition ID
  models: Map<string, Model[]>;
  refreshModels: (
    apiDefinitionId: string,
    forceRefresh?: boolean,
    skipWaitingModelRefresh?: boolean
  ) => Promise<void>;

  // Data Management
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
  clearAllModelsCache: () => Promise<void>;
  handleCompressMessages: () => Promise<{
    total: number;
    compressed: number;
    skipped: number;
    errors: number;
  }>;
  cek: string | null;
  isCEKBase32: boolean | null;
  convertCEKToBase32: () => Promise<string | null>;

  // Storage Quota
  storageQuota: { usage: number; quota: number } | null;
  refreshStorageQuota: () => Promise<void>;

  // Loading states
  isInitializing: boolean;
  isLoadingProjects: boolean;
  isLoadingModels: boolean;
}

export const AppContext = createContext<AppContextType | undefined>(undefined);
