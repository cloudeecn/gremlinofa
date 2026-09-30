import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { AppProvider } from '../AppContext';
import {
  useApiDefinitions,
  useApp,
  useAppActions,
  useAppStatus,
  useModels,
  useProjects,
} from '../../hooks/useApp';
import type { AppActions, AppStatus } from '../createAppContext';
import type { APIDefinition, Model, Project } from '../../../shared/protocol/types';

const backend = vi.hoisted(() => ({
  modelNames: ['model-a'],
  quota: { usage: 100, quota: 1000 },
}));

vi.mock('../../client', () => {
  const definition = (id: string) => ({
    id,
    apiType: 'anthropic',
    name: id,
    baseUrl: '',
    apiKey: 'key',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  // Fresh objects on every call, like data crossing the worker boundary
  const modelList = () =>
    backend.modelNames.map(id => ({ id, name: id, apiType: 'anthropic' }) as Model);
  return {
    gremlinClient: {
      init: vi.fn(async () => ({})),
      getAPIDefinitions: vi.fn(async () => [definition('api_1'), definition('api_2')]),
      getProjects: vi.fn(async () => [{ id: 'proj_1', name: 'Project' } as Project]),
      patchProject: vi.fn(async (id: string) => ({ id, name: 'Patched' }) as Project),
      getModelsCache: vi.fn(async () => ({ models: modelList(), cachedAt: Date.now() })),
      discoverModels: vi.fn(async () => modelList()),
      deleteModelsCache: vi.fn(async () => {}),
      getStorageQuota: vi.fn(async () => ({ ...backend.quota })),
    },
  };
});

import { gremlinClient } from '../../client';

interface Probes {
  apiDefinitionRenders: number;
  projectRenders: number;
  appRenders: number;
  actions: AppActions[];
  models: Map<string, Model[]>[];
  apiDefinitions: APIDefinition[];
  status: AppStatus | null;
  storageQuota: unknown[];
}

function renderProvider() {
  const probes: Probes = {
    apiDefinitionRenders: 0,
    projectRenders: 0,
    appRenders: 0,
    actions: [],
    models: [],
    apiDefinitions: [],
    status: null,
    storageQuota: [],
  };
  function ApiDefinitionsProbe() {
    probes.apiDefinitions = useApiDefinitions();
    probes.apiDefinitionRenders++;
    return null;
  }
  function ProjectsProbe() {
    useProjects();
    probes.projectRenders++;
    return null;
  }
  function ActionsProbe() {
    probes.actions.push(useAppActions());
    return null;
  }
  function ModelsProbe() {
    probes.models.push(useModels());
    return null;
  }
  function StatusProbe() {
    probes.status = useAppStatus();
    return null;
  }
  function WholeAppProbe() {
    probes.storageQuota.push(useApp().storageQuota);
    probes.appRenders++;
    return null;
  }
  render(
    <AppProvider>
      <ApiDefinitionsProbe />
      <ProjectsProbe />
      <ActionsProbe />
      <ModelsProbe />
      <StatusProbe />
      <WholeAppProbe />
    </AppProvider>
  );
  return probes;
}

async function renderInitialized() {
  const probes = renderProvider();
  await waitFor(() => expect(probes.status?.isInitializing).toBe(false));
  await waitFor(() => expect(probes.models.at(-1)?.size).toBe(2));
  return probes;
}

describe('AppProvider', () => {
  beforeEach(() => {
    backend.modelNames = ['model-a'];
    backend.quota = { usage: 100, quota: 1000 };
  });

  it('keeps project and model updates away from API-definition consumers', async () => {
    const probes = await renderInitialized();
    const apiDefinitionRenders = probes.apiDefinitionRenders;
    const projectRenders = probes.projectRenders;
    const actions = probes.actions.at(-1)!;

    await act(() => actions.patchProject('proj_1', { name: 'Patched' }));
    backend.modelNames = ['model-a', 'model-b'];
    await act(() => actions.refreshModels('api_1', true));

    expect(probes.projectRenders).toBeGreaterThan(projectRenders);
    expect(probes.models.at(-1)!.get('api_1')).toHaveLength(2);
    expect(probes.apiDefinitionRenders).toBe(apiDefinitionRenders);
    // One actions object for the provider's whole life
    expect(new Set(probes.actions).size).toBe(1);
  });

  it('resolves a landed patch even when the project list refresh fails', async () => {
    const probes = await renderInitialized();
    const actions = probes.actions.at(-1)!;
    vi.mocked(gremlinClient.getProjects).mockRejectedValueOnce(new Error('socket closed'));

    let merged: Project | undefined;
    await act(async () => {
      merged = await actions.patchProject('proj_1', { name: 'Patched' });
    });

    expect(merged).toMatchObject({ id: 'proj_1', name: 'Patched' });
  });

  it('keeps the models map when a refresh returns the same list', async () => {
    const probes = await renderInitialized();
    const models = probes.models.at(-1)!;
    const actions = probes.actions.at(-1)!;

    await act(() => actions.refreshModels('api_1'));
    await act(() => actions.refreshModels('api_1', true));
    expect(probes.models.at(-1)).toBe(models);

    backend.modelNames = ['model-c'];
    await act(() => actions.refreshModels('api_1', true));
    expect(probes.models.at(-1)).not.toBe(models);
  });

  it('keeps the storage quota object when usage and quota are unchanged', async () => {
    const probes = await renderInitialized();
    const quota = probes.storageQuota.at(-1);
    const appRenders = probes.appRenders;
    const actions = probes.actions.at(-1)!;

    await act(() => actions.refreshStorageQuota());
    expect(probes.storageQuota.at(-1)).toBe(quota);
    expect(probes.appRenders).toBe(appRenders);

    backend.quota = { usage: 200, quota: 1000 };
    await act(() => actions.refreshStorageQuota());
    expect(probes.storageQuota.at(-1)).toEqual({ usage: 200, quota: 1000 });
  });

  it('clears the model cache of every loaded API definition', async () => {
    const probes = await renderInitialized();
    await act(() => probes.actions.at(-1)!.clearAllModelsCache());
    expect(gremlinClient.deleteModelsCache).toHaveBeenCalledWith('api_1');
    expect(gremlinClient.deleteModelsCache).toHaveBeenCalledWith('api_2');
    expect(probes.models.at(-1)!.size).toBe(0);
  });

  it('reports a failed init instead of leaving an empty app', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(gremlinClient.init).mockRejectedValueOnce(new Error('CEK_MISMATCH'));

    const probes = renderProvider();
    await waitFor(() => expect(probes.status?.isInitializing).toBe(false));

    expect(probes.status?.initError).toBe('CEK_MISMATCH');
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('reports an init that throws synchronously (no Worker support)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(gremlinClient.init).mockImplementationOnce(() => {
      throw new Error('no Web Workers');
    });

    const probes = renderProvider();
    await waitFor(() => expect(probes.status?.isInitializing).toBe(false));

    expect(probes.status?.initError).toBe('no Web Workers');
    consoleError.mockRestore();
  });

  it('reports a failed first project load as an init failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(gremlinClient.getProjects).mockRejectedValueOnce(new Error('storage offline'));

    const probes = renderProvider();
    await waitFor(() => expect(probes.status?.isInitializing).toBe(false));

    expect(probes.status?.initError).toBe('storage offline');
    consoleError.mockRestore();
  });
});
