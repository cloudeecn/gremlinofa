import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ProjectSettingsView from '../ProjectSettingsView';
import type { Project, APIDefinition } from '../../../../shared/protocol/types';

// Mock modules
const mockNavigate = vi.fn();
const mockShowDestructiveConfirm = vi.fn();
const mockUpdateProject = vi.fn();
const mockDeleteProject = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../../../hooks/useApp', () => ({
  useApp: () => ({
    apiDefinitions: [
      {
        id: 'api-1',
        name: 'Anthropic',
        apiType: 'anthropic',
        apiKey: 'test-key',
      },
    ] as APIDefinition[],
  }),
}));

vi.mock('../../../hooks/useAlert', () => ({
  useAlert: () => ({
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

vi.mock('../../../hooks/useProject', () => ({
  useProject: () => ({
    project: mockProject,
    updateProject: mockUpdateProject,
    deleteProject: mockDeleteProject,
  }),
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
