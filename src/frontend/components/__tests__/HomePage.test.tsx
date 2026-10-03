import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import HomePage from '../HomePage';
import { setStorageConfig } from '../../lib/localStorageBoot';
import type { APIDefinition, Project } from '../../../shared/protocol/types';
import type { StorageQuota } from '../../contexts/createAppContext';

const harness = vi.hoisted(() => ({
  isMobile: false,
  projects: [] as Project[],
  apiDefinitions: [] as APIDefinition[],
  storageQuota: null as StorageQuota | null,
  saveProject: vi.fn(),
  refreshStorageQuota: vi.fn(),
  showAlert: vi.fn(),
}));

vi.mock('../../hooks/useApp', () => ({
  useProjects: () => harness.projects,
  useApiDefinitions: () => harness.apiDefinitions,
  useStorageInfo: () => ({ cek: null, isCEKBase32: null, storageQuota: harness.storageQuota }),
  useAppActions: () => ({
    saveProject: harness.saveProject,
    refreshStorageQuota: harness.refreshStorageQuota,
  }),
}));
vi.mock('../../hooks/useAlert', () => ({ useAlert: () => ({ showAlert: harness.showAlert }) }));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => harness.isMobile }));

const MB = 1024 * 1024;

function makeProject(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: `Project ${id}`,
    icon: '📁',
    apiDefinitionId: 'api_anthropic',
    modelId: 'claude-opus-5-5',
    ...overrides,
  } as Project;
}

function makeApiDefinition(overrides: Partial<APIDefinition> = {}): APIDefinition {
  return {
    id: 'api_anthropic',
    apiType: 'anthropic',
    name: 'Anthropic Official',
    baseUrl: '',
    apiKey: '',
    ...overrides,
  } as APIDefinition;
}

function ProjectPage() {
  const { projectId } = useParams();
  return <div>Project page {projectId}</div>;
}

function ProjectSettingsPage() {
  const { projectId } = useParams();
  return <div>Settings for {projectId}</div>;
}

function renderHome(onMenuPress?: () => void) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<HomePage onMenuPress={onMenuPress} />} />
        <Route path="/project/:projectId" element={<ProjectPage />} />
        <Route path="/project/:projectId/settings" element={<ProjectSettingsPage />} />
        <Route path="/settings" element={<div>API settings page</div>} />
        <Route path="/data" element={<div>Data page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('HomePage', () => {
  beforeEach(() => {
    harness.isMobile = false;
    harness.projects = [];
    harness.apiDefinitions = [makeApiDefinition()];
    harness.storageQuota = null;
    harness.saveProject.mockResolvedValue(undefined);
    harness.refreshStorageQuota.mockResolvedValue(undefined);
  });

  it('walks a fresh install through setup, starting at Configure APIs', () => {
    renderHome();

    expect(screen.getByRole('heading', { name: 'Three steps to your first chat' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Recent projects' })).toBeNull();
    // No project yet, so step 3 has nothing to open
    expect(screen.queryByRole('button', { name: 'Open project settings' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Configure APIs' }));
    expect(screen.getByText('API settings page')).toBeInTheDocument();
  });

  it('ticks off the provider step once a definition holds a key', () => {
    harness.apiDefinitions = [makeApiDefinition({ apiKey: 'sk-test' })];
    renderHome();

    expect(screen.getByRole('heading', { name: 'Connect a provider: done' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Configure APIs' })).toBeNull();
  });

  it('creates a project from the setup step and opens it', async () => {
    renderHome();

    fireEvent.change(screen.getByRole('textbox', { name: 'New project name' }), {
      target: { value: '  Garden  ' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create' })));

    expect(harness.saveProject).toHaveBeenCalledTimes(1);
    const saved = harness.saveProject.mock.calls[0][0] as Project;
    expect(saved.name).toBe('Garden');
    expect(saved.modelId).toBeNull();
    expect(screen.getByText(`Project page ${saved.id}`)).toBeInTheDocument();
  });

  it('creates one project when Enter is pressed again while the first save runs', async () => {
    let finishSave: () => void = () => {};
    harness.saveProject.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishSave = resolve;
        })
    );
    renderHome();

    const nameField = screen.getByRole('textbox', { name: 'New project name' });
    fireEvent.change(nameField, { target: { value: 'Garden' } });
    await act(async () => fireEvent.keyDown(nameField, { key: 'Enter' }));
    await act(async () => fireEvent.keyDown(nameField, { key: 'Enter' }));
    expect(harness.saveProject).toHaveBeenCalledTimes(1);

    await act(async () => finishSave());
  });

  it('alerts and stays put when the project fails to save', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    harness.saveProject.mockRejectedValue(new Error('disk full'));
    renderHome();

    const nameField = screen.getByRole('textbox', { name: 'New project name' });
    fireEvent.change(nameField, { target: { value: 'Garden' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create' })));

    expect(harness.showAlert).toHaveBeenCalledWith('Project not created', 'disk full');
    expect(nameField).toHaveValue('Garden');
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
    consoleError.mockRestore();
  });

  it('points the model step at the most recent project without one', () => {
    harness.apiDefinitions = [makeApiDefinition({ apiKey: 'sk-test' })];
    harness.projects = [
      makeProject('p_new', { apiDefinitionId: null, modelId: null }),
      makeProject('p_old', { apiDefinitionId: null, modelId: null }),
    ];
    renderHome();

    expect(screen.getByRole('heading', { name: 'Create a project: done' })).toBeVisible();
    // Projects with no model say so in the list too
    expect(screen.getAllByText('No default model yet')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Open project settings' }));
    expect(screen.getByText('Settings for p_new')).toBeInTheDocument();
  });

  it('lists recent projects once set up, eight at first', () => {
    harness.apiDefinitions = [makeApiDefinition({ apiKey: 'sk-test', icon: '🅰️' })];
    harness.projects = Array.from({ length: 10 }, (_, i) => makeProject(`p${i}`));
    renderHome();

    expect(screen.queryByRole('heading', { name: 'Three steps to your first chat' })).toBeNull();
    const list = screen.getByRole('list');
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(8);
    expect(rows[0]).toHaveTextContent('Project p0');
    expect(rows[0]).toHaveTextContent('🅰️ claude-opus-5-5');

    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));
    expect(within(list).getAllByRole('button')).toHaveLength(10);

    fireEvent.click(rows[1]);
    expect(screen.getByText('Project page p1')).toBeInTheDocument();
  });

  it('keeps the new-project field once set up', () => {
    harness.apiDefinitions = [makeApiDefinition({ apiKey: 'sk-test' })];
    harness.projects = [makeProject('p1')];
    renderHome();

    expect(screen.getByRole('textbox', { name: 'New project name' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('opens the menu from the header on a phone only', () => {
    const onMenuPress = vi.fn();
    harness.isMobile = true;
    const { unmount } = renderHome(onMenuPress);

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(onMenuPress).toHaveBeenCalledTimes(1);
    unmount();

    harness.isMobile = false;
    renderHome(onMenuPress);
    expect(screen.queryByRole('button', { name: 'Open menu' })).toBeNull();
  });

  it('refreshes the storage quota on every visit', () => {
    renderHome();
    expect(harness.refreshStorageQuota).toHaveBeenCalledTimes(1);
  });

  it('warns about browser storage only past the threshold', () => {
    harness.storageQuota = { usage: 10 * MB, quota: 10_000 * MB };
    const { unmount } = renderHome();
    expect(screen.queryByText(/This browser holds/)).toBeNull();
    unmount();

    harness.storageQuota = { usage: 150 * MB, quota: 10_000 * MB };
    renderHome();
    expect(screen.getByText(/This browser holds 150 MB/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '💾 Manage Data' }));
    expect(screen.getByText('Data page')).toBeInTheDocument();
  });

  it('never warns about browser storage in server mode', () => {
    setStorageConfig({ type: 'server', wsUrl: 'ws://localhost:1234' });
    harness.storageQuota = { usage: 150 * MB, quota: 10_000 * MB };
    renderHome();
    expect(screen.queryByText(/This browser holds/)).toBeNull();
  });
});
