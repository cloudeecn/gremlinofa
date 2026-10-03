import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import SettingsPage from '../SettingsPage';
import type { APIDefinition } from '../../../shared/protocol/types';

const mockSaveAPIDefinition = vi.fn();
const mockDeleteAPIDefinition = vi.fn();
const mockRefreshModels = vi.fn();
const mockRefreshAPIDefinitions = vi.fn();
const mockShowAlert = vi.fn();
const mockShowDestructiveConfirm = vi.fn();
let mockApiDefinitions: APIDefinition[] = [];

vi.mock('../../hooks/useApp', () => ({
  useApiDefinitions: () => mockApiDefinitions,
  useAppActions: () => ({
    saveAPIDefinition: mockSaveAPIDefinition,
    deleteAPIDefinition: mockDeleteAPIDefinition,
    refreshModels: mockRefreshModels,
    refreshAPIDefinitions: mockRefreshAPIDefinitions,
  }),
}));

vi.mock('../../hooks/useAlert', () => ({
  useAlert: () => ({
    showAlert: mockShowAlert,
    showDestructiveConfirm: mockShowDestructiveConfirm,
  }),
}));

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('../settings/ChatgptSignInPanel', () => ({
  default: () => <div data-testid="chatgpt-sign-in-panel" />,
}));

const createdAt = new Date('2026-01-01T00:00:00Z');

const openRouterDef: APIDefinition = {
  id: 'api_openrouter',
  apiType: 'chatgpt',
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or',
  isDefault: true,
  advancedSettings: { pruneThinking: true },
  createdAt,
  updatedAt: createdAt,
};

const chatgptSubscriptionDef: APIDefinition = {
  id: 'api_chatgpt_sub',
  apiType: 'chatgpt-subscription',
  name: 'ChatGPT Plus',
  baseUrl: '',
  apiKey: '',
  createdAt,
  updatedAt: createdAt,
};

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/" element={<div>Home page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function checkbox(label: string) {
  return screen.getByLabelText(label) as HTMLInputElement;
}

describe('SettingsPage header', () => {
  it('links home from the upper right', async () => {
    mockApiDefinitions = [];
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole('link', { name: 'Home' }));
    expect(screen.getByText('Home page')).toBeInTheDocument();
  });
});

describe('SettingsPage add form', () => {
  beforeEach(() => {
    // No rows, so the add form's buttons are the only "Advanced" / "Add" on the page.
    mockApiDefinitions = [];
    mockSaveAPIDefinition.mockResolvedValue(undefined);
    mockRefreshModels.mockResolvedValue(undefined);
  });

  async function openAddAdvanced(user: ReturnType<typeof userEvent.setup>, typeName?: string) {
    await user.click(screen.getByRole('button', { name: '+ Add API Definition' }));
    if (typeName) await user.click(screen.getByRole('button', { name: new RegExp(typeName) }));
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
  }

  it('offers "Subscription service" and "Enforce genuine Anthropic" under Advanced', async () => {
    const user = userEvent.setup();
    renderSettings();

    await openAddAdvanced(user);

    expect(screen.getByText('Advanced Settings')).toBeInTheDocument();
    expect(checkbox('Subscription service')).not.toBeChecked();
    expect(checkbox('Enforce genuine Anthropic')).not.toBeChecked();
  });

  it('hides the knobs that do not apply to chatgpt-subscription, like the edit form', async () => {
    const user = userEvent.setup();
    renderSettings();

    await openAddAdvanced(user, 'ChatGPT \\(subscription\\)');

    expect(checkbox('Subscription service')).toBeInTheDocument();
    expect(screen.queryByLabelText('Enforce genuine Anthropic')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Supports flex / batch tier')).not.toBeInTheDocument();
    expect(screen.queryByText('Reasoning dialect')).not.toBeInTheDocument();
  });

  it('saves the advanced flags set before going back', async () => {
    const user = userEvent.setup();
    renderSettings();

    await openAddAdvanced(user, 'Anthropic');
    await user.click(checkbox('Subscription service'));
    await user.click(checkbox('Enforce genuine Anthropic'));
    await user.click(screen.getByRole('button', { name: '← Back' }));

    await user.type(screen.getByPlaceholderText('e.g., xAI, OpenRouter, My OpenAI'), 'Proxy');
    await user.type(screen.getByPlaceholderText('Enter your API key'), 'sk-ant');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(mockSaveAPIDefinition).toHaveBeenCalledTimes(1);
    const saved = mockSaveAPIDefinition.mock.calls[0][0] as APIDefinition;
    expect(saved).toMatchObject({
      apiType: 'anthropic',
      name: 'Proxy',
      apiKey: 'sk-ant',
      isDefault: false,
      advancedSettings: { isSubscription: true, enforceGenuineAnthropic: true },
    });
    expect(mockRefreshModels).toHaveBeenCalledWith(saved.id, true);
    // The form closes once the save lands.
    expect(screen.getByRole('button', { name: '+ Add API Definition' })).toBeInTheDocument();
  });

  it('does not save a flag ticked under one type after switching to a type that hides it', async () => {
    const user = userEvent.setup();
    renderSettings();

    // Default type is the Responses API, which shows the flex tier.
    await openAddAdvanced(user);
    await user.click(checkbox('Supports flex / batch tier'));
    await user.click(checkbox('Mandate chain-of-thought'));
    await user.click(screen.getByRole('button', { name: '← Back' }));

    await user.click(screen.getByRole('button', { name: /ChatGPT \(subscription\)/ }));
    await user.type(screen.getByPlaceholderText('e.g., xAI, OpenRouter, My OpenAI'), 'ChatGPT');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    const saved = mockSaveAPIDefinition.mock.calls[0][0] as APIDefinition;
    expect(saved.apiType).toBe('chatgpt-subscription');
    expect(saved.advancedSettings).toEqual({ mandateCoT: true });
  });

  it('requires a name', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole('button', { name: '+ Add API Definition' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(mockShowAlert).toHaveBeenCalledWith('Error', 'Name is required');
    expect(mockSaveAPIDefinition).not.toHaveBeenCalled();
  });

  it('requires an API key unless the provider is local', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole('button', { name: '+ Add API Definition' }));
    await user.type(screen.getByPlaceholderText('e.g., xAI, OpenRouter, My OpenAI'), 'Ollama');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(mockShowAlert).toHaveBeenCalledWith(
      'Error',
      'API Key is required for this provider (or mark as Local)'
    );

    await user.click(checkbox('🏠 Local provider (API key optional)'));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(mockSaveAPIDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Ollama', isLocal: true, apiKey: '' })
    );
  });
});

describe('SettingsPage edit forms', () => {
  beforeEach(() => {
    mockApiDefinitions = [openRouterDef, chatgptSubscriptionDef];
    mockSaveAPIDefinition.mockResolvedValue(undefined);
    mockRefreshModels.mockResolvedValue(undefined);
  });

  it('loads the definition into the edit form and saves it under the same id', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    const name = screen.getByPlaceholderText(
      'e.g., xAI, OpenRouter, My OpenAI'
    ) as HTMLInputElement;
    expect(name.value).toBe('OpenRouter');
    expect(screen.queryByRole('button', { name: '+ Add API Definition' })).not.toBeInTheDocument();

    await user.clear(name);
    await user.type(name, 'OpenRouter 2');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const saved = mockSaveAPIDefinition.mock.calls[0][0] as APIDefinition;
    expect(saved).toMatchObject({
      id: 'api_openrouter',
      name: 'OpenRouter 2',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or',
      isDefault: true,
      createdAt,
      advancedSettings: { pruneThinking: true },
    });
    expect(mockRefreshModels).toHaveBeenCalledWith('api_openrouter', true);
  });

  it('Cancel discards edits', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    await user.type(screen.getByPlaceholderText('e.g., xAI, OpenRouter, My OpenAI'), ' typo');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]);

    expect(
      (screen.getByPlaceholderText('e.g., xAI, OpenRouter, My OpenAI') as HTMLInputElement).value
    ).toBe('OpenRouter');
    expect(mockSaveAPIDefinition).not.toHaveBeenCalled();
  });

  it('Advanced saves only the advanced settings', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getAllByRole('button', { name: 'Advanced' })[0]);
    expect(checkbox('Prune previous thinking blocks')).toBeChecked();
    await user.click(checkbox('Prune previous thinking blocks'));
    await user.click(checkbox('Mandate chain-of-thought'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(mockSaveAPIDefinition).toHaveBeenCalledWith({
      ...openRouterDef,
      advancedSettings: { mandateCoT: true },
      updatedAt: expect.any(Date),
    });
    expect(mockRefreshModels).not.toHaveBeenCalled();
  });

  it('shows the same chatgpt-subscription advanced fields as the add form', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getAllByRole('button', { name: 'Advanced' })[1]);

    expect(checkbox('Subscription service')).toBeInTheDocument();
    expect(screen.queryByLabelText('Enforce genuine Anthropic')).not.toBeInTheDocument();
  });

  it('keeps the edit form open with the edits when the save fails', async () => {
    mockSaveAPIDefinition.mockRejectedValueOnce(new Error('storage offline'));
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    const name = screen.getByPlaceholderText('e.g., xAI, OpenRouter, My OpenAI');
    await user.type(name, ' 2');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(mockShowAlert).toHaveBeenCalledWith('Not saved', 'storage offline');
    expect(screen.getByPlaceholderText('e.g., xAI, OpenRouter, My OpenAI')).toHaveValue(
      'OpenRouter 2'
    );
  });

  it('alerts when a delete fails', async () => {
    mockShowDestructiveConfirm.mockResolvedValueOnce(true);
    mockDeleteAPIDefinition.mockRejectedValueOnce(new Error('LOOPS_RUNNING'));
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]);

    expect(mockDeleteAPIDefinition).toHaveBeenCalledWith('api_openrouter');
    expect(mockShowAlert).toHaveBeenCalledWith('Not deleted', 'LOOPS_RUNNING');
  });

  it('shows the sign-in panel instead of an API key for chatgpt-subscription', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getAllByRole('button', { name: 'Edit' })[1]);

    expect(screen.getByTestId('chatgpt-sign-in-panel')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Enter your API key')).not.toBeInTheDocument();
  });
});
