import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ProjectSettingsView from '../ProjectSettingsView';
import type { Project, APIDefinition } from '../../../types';

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
  memoryEnabled: false,
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
  useDraftPersistence: () => ({ hasDraftDifference: false }),
  clearDraft: vi.fn(),
  clearDraftDifference: vi.fn(),
}));

vi.mock('../../../services/api/apiService', () => ({
  apiService: {
    isReasoningModel: () => false,
  },
}));

vi.mock('../ModelSelector', () => ({
  default: () => <div data-testid="model-selector">Model Selector</div>,
}));

function renderWithRouter(memoryEnabled = false) {
  mockProject.memoryEnabled = memoryEnabled;

  return render(
    <MemoryRouter>
      <ProjectSettingsView projectId="project-1" />
    </MemoryRouter>
  );
}

describe('ProjectSettingsView Memory Section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProject.memoryEnabled = false;
  });

  describe('Memory Toggle', () => {
    it('renders memory toggle checkbox', async () => {
      renderWithRouter();

      const checkbox = screen.getByLabelText('Memory');
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).not.toBeChecked();
    });

    it('shows memory toggle as checked when memoryEnabled is true', async () => {
      renderWithRouter(true);

      const checkbox = screen.getByLabelText('Memory');
      expect(checkbox).toBeChecked();
    });

    it('displays description text for memory feature', () => {
      renderWithRouter();

      expect(
        screen.getByText(
          'Use a virtual FS to remember across conversations (Optimized for Anthropic)'
        )
      ).toBeInTheDocument();
    });

    it('toggles memory enabled state when clicked', () => {
      renderWithRouter();

      const checkbox = screen.getByLabelText('Memory');
      fireEvent.click(checkbox);

      expect(checkbox).toBeChecked();
    });
  });
});
