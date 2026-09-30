import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ProjectSettingsView from '../ProjectSettingsView';
import type { Project, APIDefinition } from '../../../../shared/protocol/types';

// Mock modules
const mockNavigate = vi.fn();
const mockShowDestructiveConfirm = vi.fn();
const mockShowAlert = vi.fn();
const mockUpdateProject = vi.fn(async (_updates: unknown) => true);
const mockDeleteProject = vi.fn();
const mockUseProjectArgs = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../../../hooks/useApp', () => ({
  useApiDefinitions: () =>
    [
      {
        id: 'api-1',
        name: 'Anthropic',
        apiType: 'anthropic',
        apiKey: 'test-key',
      },
    ] as APIDefinition[],
  useModels: () => new Map(),
}));

vi.mock('../../../hooks/useAlert', () => ({
  useAlert: () => ({
    showAlert: mockShowAlert,
    showDestructiveConfirm: mockShowDestructiveConfirm,
  }),
}));

// Mock gremlinClient.listTools — ProjectSettingsView now reads the tool
// inventory through the protocol instead of importing the in-process
// registry directly.
vi.mock('../../../client', () => ({
  gremlinClient: {
    listTools: vi.fn().mockResolvedValue([
      {
        name: 'memory',
        displayName: 'Memory',
        displaySubtitle:
          'Use a virtual FS to remember across conversations (Optimized for Anthropic)',
        optionDefinitions: [
          {
            id: 'useSystemPrompt',
            label: '(Anthropic) Use System Prompt Mode',
            subtitle:
              'Inject memory listing into system prompt instead of native tool. (Cannot disable for other providers.)',
            default: false,
          },
        ],
      },
      {
        name: 'javascript',
        displayName: 'JavaScript Execution',
        displaySubtitle: 'Execute code in a secure sandbox in your browser',
        optionDefinitions: [
          {
            id: 'loadLib',
            label: 'Load /lib Scripts',
            subtitle: 'Auto-load .js files from /lib when JS session starts',
            default: true,
          },
        ],
      },
      {
        name: 'filesystem',
        displayName: 'Filesystem Access',
        displaySubtitle: 'Read/write VFS files (/memories readonly)',
        optionDefinitions: [],
      },
      {
        name: 'dummy',
        displayName: 'DUMMY Hooks',
        displaySubtitle: 'Mock-message hooks',
        optionDefinitions: [
          {
            type: 'number',
            id: 'hookContextDepth',
            label: 'Hook Context Depth',
            default: 0,
            min: 0,
            max: 50,
          },
        ],
      },
    ]),
  },
}));

const mockProject: Project = {
  id: 'project-1',
  name: 'Test Project',
  icon: '🧪',
  apiDefinitionId: 'api-1',
  modelId: 'claude-3-opus',
  systemPrompt: '',
  preFillResponse: '',
  enableReasoning: false,
  reasoningBudgetTokens: 2048,
  webSearchEnabled: false,
  sendMessageMetadata: false,
  metadataTimestampMode: 'disabled',
  metadataIncludeContextWindow: false,
  metadataIncludeCost: false,
  // New tool format
  enabledTools: [],
  temperature: null,
  maxOutputTokens: 2048,
  createdAt: new Date(),
  lastUsedAt: new Date(),
};

// Set to hand the view a different project instance on the next render.
let mockLoadedProject: Project | null = null;

vi.mock('../../../hooks/useProject', () => ({
  useProject: (args: unknown) => {
    mockUseProjectArgs(args);
    return {
      project: mockLoadedProject ?? mockProject,
      updateProject: mockUpdateProject,
      deleteProject: mockDeleteProject,
    };
  },
}));

vi.mock('../../../hooks/useDraftPersistence', () => ({
  useDraftPersistence: vi.fn(),
  clearDraft: vi.fn(),
}));

vi.mock('../../../../shared/services/api/apiService', () => ({
  apiService: {
    isReasoningModel: () => false,
  },
}));

vi.mock('../ModelSelector', () => ({
  default: () => <div data-testid="model-selector">Model Selector</div>,
}));

function renderWithRouter(memoryEnabled = false) {
  // Use new enabledTools format
  mockProject.enabledTools = memoryEnabled ? ['memory'] : [];

  return render(
    <MemoryRouter>
      <ProjectSettingsView projectId="project-1" />
    </MemoryRouter>
  );
}

describe('ProjectSettingsView Memory Section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Use new enabledTools format
    mockProject.enabledTools = [];
  });

  describe('Memory Toggle', () => {
    it('renders memory toggle checkbox', async () => {
      renderWithRouter();

      // Tools render after the async listTools() promise resolves.
      const checkbox = await screen.findByLabelText('Memory');
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).not.toBeChecked();
    });

    it('shows memory toggle as checked when memoryEnabled is true', async () => {
      renderWithRouter(true);

      const checkbox = await screen.findByLabelText('Memory');
      expect(checkbox).toBeChecked();
    });

    it('displays description text for memory feature', async () => {
      renderWithRouter();

      await waitFor(() => {
        expect(
          screen.getByText(
            'Use a virtual FS to remember across conversations (Optimized for Anthropic)'
          )
        ).toBeInTheDocument();
      });
    });

    it('toggles memory enabled state when clicked', async () => {
      renderWithRouter();

      const checkbox = await screen.findByLabelText('Memory');
      fireEvent.click(checkbox);

      expect(checkbox).toBeChecked();
    });
  });
});

describe('ProjectSettingsView project loading', () => {
  it('loads the project without its chat list', () => {
    renderWithRouter();
    expect(mockUseProjectArgs).toHaveBeenCalledWith({ projectId: 'project-1', withChats: false });
  });
});

describe('ProjectSettingsView delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShowDestructiveConfirm.mockResolvedValue(true);
  });

  async function clickDelete() {
    fireEvent.click(screen.getByText('Danger Zone'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Delete Project/ }));
    });
  }

  it('navigates home only after the delete finishes', async () => {
    let finishDelete: () => void = () => {};
    mockDeleteProject.mockReturnValue(
      new Promise<void>(resolve => {
        finishDelete = resolve;
      })
    );
    renderWithRouter();

    await clickDelete();
    expect(mockDeleteProject).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();

    await act(async () => {
      finishDelete();
    });
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('stays on the page and reports a failed delete', async () => {
    mockDeleteProject.mockRejectedValue(new Error('backend gone'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderWithRouter();

    await clickDelete();

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockShowAlert).toHaveBeenCalledWith('Error', 'Failed to delete project');
    consoleError.mockRestore();
  });

  it('does nothing when the confirm is declined', async () => {
    mockShowDestructiveConfirm.mockResolvedValue(false);
    renderWithRouter();

    await clickDelete();

    expect(mockDeleteProject).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('ProjectSettingsView tool number options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProject.enabledTools = ['dummy'];
    mockProject.toolOptions = { dummy: { hookContextDepth: 5 } };
  });

  afterEach(() => {
    mockProject.enabledTools = [];
    mockProject.toolOptions = undefined;
  });

  function renderSettings() {
    return render(
      <MemoryRouter>
        <ProjectSettingsView projectId="project-1" />
      </MemoryRouter>
    );
  }

  it('clamps a value above max on blur and saves the clamped value', async () => {
    const user = userEvent.setup();
    renderSettings();
    const input = (await screen.findByLabelText('Hook Context Depth')) as HTMLInputElement;

    await user.clear(input);
    await user.type(input, '99');
    await user.tab();
    expect(input.value).toBe('50');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mockUpdateProject).toHaveBeenCalledWith(
      expect.objectContaining({ toolOptions: { dummy: { hookContextDepth: 50 } } })
    );
  });

  it('backspace then type replaces the value', async () => {
    const user = userEvent.setup();
    renderSettings();
    const input = (await screen.findByLabelText('Hook Context Depth')) as HTMLInputElement;

    await user.type(input, '{Backspace}8');
    expect(input.value).toBe('8');
  });
});

describe('ProjectSettingsView form', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockLoadedProject = null;
  });

  it('saves only the fields it edits, then returns to the project', async () => {
    const user = userEvent.setup();
    renderWithRouter();

    await user.click(screen.getByLabelText('Web Search'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const patch = mockUpdateProject.mock.calls[0][0];
    expect(patch).toMatchObject({
      webSearchEnabled: true,
      apiDefinitionId: 'api-1',
      modelId: 'claude-3-opus',
      maxOutputTokens: 2048,
      reasoningBudgetTokens: 2048,
      temperature: null,
    });
    // Identity fields aren't the form's to write, so a rename elsewhere survives the save.
    expect(patch).not.toHaveProperty('id');
    expect(patch).not.toHaveProperty('name');
    expect(patch).not.toHaveProperty('createdAt');
    expect(patch).toHaveProperty('remoteVfsEncrypt', undefined);
    expect(mockNavigate).toHaveBeenCalledWith('/project/project-1');
  });

  it('stays on the page with the edits when the save fails', async () => {
    mockUpdateProject.mockResolvedValueOnce(false);
    const user = userEvent.setup();
    renderWithRouter();

    await user.click(screen.getByLabelText('Web Search'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(mockUpdateProject).toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Web Search')).toBeChecked();
  });

  it('reloads the form when a new project instance arrives', () => {
    const { rerender } = renderWithRouter();
    expect(screen.getByLabelText('Web Search')).not.toBeChecked();

    mockLoadedProject = { ...mockProject, webSearchEnabled: true };
    rerender(
      <MemoryRouter>
        <ProjectSettingsView projectId="project-1" />
      </MemoryRouter>
    );

    expect(screen.getByLabelText('Web Search')).toBeChecked();
  });
});
