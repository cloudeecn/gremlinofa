import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ProjectSettingsView from '../ProjectSettingsView';
import type { Project, APIDefinition } from '../../../types';

// Mock modules
const mockNavigate = vi.fn();
const mockHasMemory = vi.fn();
const mockClearMemory = vi.fn();
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

vi.mock('../../../services/memory/memoryStorage', () => ({
  hasMemory: (...args: unknown[]) => mockHasMemory(...args),
  clearMemory: (...args: unknown[]) => mockClearMemory(...args),
}));

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
  useDraftPersistence: () => {},
  clearDraft: vi.fn(),
}));

vi.mock('../../../services/api/apiService', () => ({
  apiService: {
    isReasoningModel: () => false,
  },
}));

vi.mock('../ModelSelector', () => ({
  default: () => <div data-testid="model-selector">Model Selector</div>,
}));

function renderWithRouter(memoryEnabled = false, hasMemoryData = false) {
  mockProject.memoryEnabled = memoryEnabled;
  mockHasMemory.mockResolvedValue(hasMemoryData);

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
    mockHasMemory.mockResolvedValue(false);
  });

  describe('Memory Toggle', () => {
    it('renders memory toggle checkbox', async () => {
      renderWithRouter();

      const checkbox = screen.getByLabelText('Enable Memory');
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).not.toBeChecked();
    });

    it('shows memory toggle as checked when memoryEnabled is true', async () => {
      renderWithRouter(true);

      const checkbox = screen.getByLabelText('Enable Memory');
      expect(checkbox).toBeChecked();
    });

    it('displays description text for memory feature', () => {
      renderWithRouter();

      expect(
        screen.getByText('Claude can remember information across conversations (Anthropic only)')
      ).toBeInTheDocument();
    });

    it('toggles memory enabled state when clicked', () => {
      renderWithRouter();

      const checkbox = screen.getByLabelText('Enable Memory');
      fireEvent.click(checkbox);

      expect(checkbox).toBeChecked();
    });
  });

  describe('View Memory Files Button', () => {
    it('shows View Memory Files button when memory is enabled', async () => {
      renderWithRouter(true);

      await waitFor(() => {
        expect(screen.getByText('📂 View Memory Files')).toBeInTheDocument();
      });
    });

    it('does not show View Memory Files button when memory is disabled', () => {
      renderWithRouter(false);

      expect(screen.queryByText('📂 View Memory Files')).not.toBeInTheDocument();
    });

    it('navigates to memories page when View Memory Files is clicked', async () => {
      renderWithRouter(true);

      await waitFor(() => {
        const button = screen.getByText('📂 View Memory Files');
        fireEvent.click(button);
      });

      expect(mockNavigate).toHaveBeenCalledWith('/project/project-1/memories');
    });
  });

  describe('Clear Memory Button', () => {
    it('shows Clear button when memory is enabled AND has memory data', async () => {
      renderWithRouter(true, true);

      await waitFor(() => {
        expect(screen.getByText('🗑️ Clear')).toBeInTheDocument();
      });
    });

    it('does not show Clear button when memory is enabled but no memory data', async () => {
      renderWithRouter(true, false);

      await waitFor(() => {
        expect(screen.getByText('📂 View Memory Files')).toBeInTheDocument();
      });

      expect(screen.queryByText('🗑️ Clear')).not.toBeInTheDocument();
    });

    it('does not show Clear button when memory is disabled', () => {
      renderWithRouter(false, true);

      expect(screen.queryByText('🗑️ Clear')).not.toBeInTheDocument();
    });

    it('shows confirmation dialog when Clear is clicked', async () => {
      mockShowDestructiveConfirm.mockResolvedValue(false);
      renderWithRouter(true, true);

      await waitFor(() => {
        const clearButton = screen.getByText('🗑️ Clear');
        fireEvent.click(clearButton);
      });

      expect(mockShowDestructiveConfirm).toHaveBeenCalledWith(
        'Clear Memory',
        'Delete all memory files for this project? Claude will forget everything.',
        'Clear'
      );
    });

    it('clears memory when confirmation is accepted', async () => {
      mockShowDestructiveConfirm.mockResolvedValue(true);
      mockClearMemory.mockResolvedValue(undefined);
      renderWithRouter(true, true);

      await waitFor(() => {
        const clearButton = screen.getByText('🗑️ Clear');
        fireEvent.click(clearButton);
      });

      await waitFor(() => {
        expect(mockClearMemory).toHaveBeenCalledWith('project-1');
      });
    });

    it('does not clear memory when confirmation is rejected', async () => {
      mockShowDestructiveConfirm.mockResolvedValue(false);
      renderWithRouter(true, true);

      await waitFor(() => {
        const clearButton = screen.getByText('🗑️ Clear');
        fireEvent.click(clearButton);
      });

      await waitFor(() => {
        expect(mockShowDestructiveConfirm).toHaveBeenCalled();
      });

      expect(mockClearMemory).not.toHaveBeenCalled();
    });

    it('hides Clear button after clearing memory', async () => {
      mockShowDestructiveConfirm.mockResolvedValue(true);
      mockClearMemory.mockResolvedValue(undefined);
      renderWithRouter(true, true);

      await waitFor(() => {
        expect(screen.getByText('🗑️ Clear')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('🗑️ Clear'));

      await waitFor(() => {
        expect(screen.queryByText('🗑️ Clear')).not.toBeInTheDocument();
      });
    });
  });

  describe('Memory state persistence', () => {
    it('checks for memory data on mount', async () => {
      renderWithRouter();

      await waitFor(() => {
        expect(mockHasMemory).toHaveBeenCalledWith('project-1');
      });
    });
  });
});
