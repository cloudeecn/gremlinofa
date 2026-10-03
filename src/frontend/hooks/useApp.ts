import { type Context, useContext, useMemo } from 'react';
import {
  ApiDefinitionsContext,
  AppActionsContext,
  AppStatusContext,
  ModelsContext,
  ProjectsContext,
  StorageInfoContext,
  type AppContextType,
} from '../contexts/createAppContext';

function useAppSlice<T>(context: Context<T | undefined>, hookName: string): T {
  const value = useContext(context);
  if (value === undefined) {
    throw new Error(`${hookName} must be used within an AppProvider`);
  }
  return value;
}

/** Stable callbacks; never re-renders the caller on its own. */
export function useAppActions() {
  return useAppSlice(AppActionsContext, 'useAppActions');
}

export function useApiDefinitions() {
  return useAppSlice(ApiDefinitionsContext, 'useApiDefinitions');
}

export function useProjects() {
  return useAppSlice(ProjectsContext, 'useProjects');
}

/** Models keyed by API definition ID. */
export function useModels() {
  return useAppSlice(ModelsContext, 'useModels');
}

export function useAppStatus() {
  return useAppSlice(AppStatusContext, 'useAppStatus');
}

/** CEK display state and the storage quota. */
export function useStorageInfo() {
  return useAppSlice(StorageInfoContext, 'useStorageInfo');
}

/**
 * Every slice combined. Re-renders on any app data change, so it's kept for
 * DataManagerPage; prefer the narrow hooks elsewhere.
 */
export function useApp(): AppContextType {
  const actions = useAppSlice(AppActionsContext, 'useApp');
  const apiDefinitions = useAppSlice(ApiDefinitionsContext, 'useApp');
  const projects = useAppSlice(ProjectsContext, 'useApp');
  const models = useAppSlice(ModelsContext, 'useApp');
  const storageInfo = useAppSlice(StorageInfoContext, 'useApp');
  const status = useAppSlice(AppStatusContext, 'useApp');
  return useMemo(
    () => ({ ...actions, ...storageInfo, ...status, apiDefinitions, projects, models }),
    [actions, storageInfo, status, apiDefinitions, projects, models]
  );
}
