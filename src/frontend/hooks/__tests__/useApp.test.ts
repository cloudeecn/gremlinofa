import { createElement, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
  useApiDefinitions,
  useApp,
  useAppActions,
  useAppStatus,
  useModels,
  useProjects,
} from '../useApp';
import {
  ApiDefinitionsContext,
  AppActionsContext,
  AppStatusContext,
  ModelsContext,
  ProjectsContext,
  StorageInfoContext,
  type AppActions,
  type AppStatus,
  type StorageInfo,
} from '../../contexts/createAppContext';
import type { APIDefinition, Project } from '../../../shared/protocol/types';

const actions: AppActions = {
  refreshAPIDefinitions: vi.fn().mockResolvedValue(undefined),
  saveAPIDefinition: vi.fn().mockResolvedValue(undefined),
  deleteAPIDefinition: vi.fn().mockResolvedValue(undefined),
  refreshProjects: vi.fn().mockResolvedValue(undefined),
  saveProject: vi.fn().mockResolvedValue(undefined),
  patchProject: vi.fn().mockResolvedValue(undefined),
  deleteProject: vi.fn().mockResolvedValue(undefined),
  refreshModels: vi.fn().mockResolvedValue(undefined),
  clearAllModelsCache: vi.fn().mockResolvedValue(undefined),
  purgeAllData: vi.fn().mockResolvedValue(undefined),
  handleExport: vi.fn().mockResolvedValue(undefined),
  handleImport: vi.fn().mockResolvedValue({ imported: 0, skipped: 0, errors: [] }),
  handleMigrate: vi.fn().mockResolvedValue({ imported: 0, skipped: 0, errors: [] }),
  handleCompressMessages: vi
    .fn()
    .mockResolvedValue({ total: 0, compressed: 0, skipped: 0, errors: 0 }),
  convertCEKToBase32: vi.fn().mockResolvedValue(null),
  refreshStorageQuota: vi.fn().mockResolvedValue(undefined),
};
const apiDefinitions = [{ id: 'api_1' }] as APIDefinition[];
const projects = [{ id: 'proj_1' }] as Project[];
const models = new Map();
const storageInfo: StorageInfo = { cek: 'abc', isCEKBase32: true, storageQuota: null };
const status: AppStatus = { isInitializing: false, initError: null };

function Providers({ children }: { children: ReactNode }) {
  return createElement(
    AppActionsContext.Provider,
    { value: actions },
    createElement(
      AppStatusContext.Provider,
      { value: status },
      createElement(
        ApiDefinitionsContext.Provider,
        { value: apiDefinitions },
        createElement(
          ProjectsContext.Provider,
          { value: projects },
          createElement(
            ModelsContext.Provider,
            { value: models },
            createElement(StorageInfoContext.Provider, { value: storageInfo }, children)
          )
        )
      )
    )
  );
}

describe('useApp hooks', () => {
  it.each([
    ['useApp', useApp],
    ['useAppActions', useAppActions],
    ['useApiDefinitions', useApiDefinitions],
    ['useProjects', useProjects],
    ['useModels', useModels],
    ['useAppStatus', useAppStatus],
  ])('%s throws outside AppProvider', (name, hook) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => hook())).toThrow(`${name} must be used within an AppProvider`);
    consoleError.mockRestore();
  });

  it('narrow hooks return their slice', () => {
    const { result } = renderHook(
      () => ({
        actions: useAppActions(),
        apiDefinitions: useApiDefinitions(),
        projects: useProjects(),
        models: useModels(),
        status: useAppStatus(),
      }),
      { wrapper: Providers }
    );
    expect(result.current.actions).toBe(actions);
    expect(result.current.apiDefinitions).toBe(apiDefinitions);
    expect(result.current.projects).toBe(projects);
    expect(result.current.models).toBe(models);
    expect(result.current.status).toBe(status);
  });

  it('useApp combines every slice and keeps its identity across re-renders', () => {
    const { result, rerender } = renderHook(() => useApp(), { wrapper: Providers });
    const first = result.current;
    expect(first.patchProject).toBe(actions.patchProject);
    expect(first.apiDefinitions).toBe(apiDefinitions);
    expect(first.projects).toBe(projects);
    expect(first.models).toBe(models);
    expect(first.cek).toBe('abc');
    expect(first.isInitializing).toBe(false);
    rerender();
    expect(result.current).toBe(first);
  });
});
