import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ChatSettingsPanel from '../ChatSettingsPanel';
import type { APIDefinition, Chat, Project } from '../../../../shared/protocol/types';

vi.mock('../../../hooks/useToolInventory', () => ({
  useToolInventory: () => [
    { name: 'memory', description: 'Memory' },
    { name: 'filesystem', description: 'Filesystem' },
    { name: 'javascript', description: 'JS' },
  ],
}));

vi.mock('../../../client', () => ({
  gremlinClient: {
    getVfsAdapter: () => ({ exists: vi.fn(async () => true) }),
    previewChatSystemPrompt: vi.fn(async () => ({ text: '', segments: [] })),
  },
}));

const confirmMock = vi.fn(async () => true);
vi.mock('../../../lib/alerts', () => ({
  showDestructiveConfirm: (...args: unknown[]) => confirmMock(...(args as [])),
}));

const project: Project = {
  id: 'proj_1',
  name: 'P',
  createdAt: new Date(0),
  lastUsedAt: new Date(0),
  systemPrompt: 'PROJECT PROMPT',
  preFillResponse: '',
  apiDefinitionId: 'api_1',
  modelId: 'm1',
  webSearchEnabled: true,
  temperature: 0.7,
  maxOutputTokens: 4096,
  enableReasoning: true,
  reasoningBudgetTokens: 2048,
  reasoningEffort: 'medium',
  enabledTools: ['memory', 'filesystem'],
};

const apiDefinitions = [
  { id: 'api_1', name: 'Anthropic', apiType: 'anthropic' },
] as unknown as APIDefinition[];

function chat(agentConfig?: Chat['agentConfig']): Chat {
  return {
    id: 'chat_1',
    projectId: 'proj_1',
    name: 'Chat',
    apiDefinitionId: null,
    modelId: null,
    createdAt: new Date(0),
    lastModifiedAt: new Date(0),
    ...(agentConfig ? { agentConfig } : {}),
  };
}

function renderPanel(agentConfig?: Chat['agentConfig'], projectOverrides: Partial<Project> = {}) {
  const onSave = vi.fn(async (_config: Chat['agentConfig']) => {});
  const onClose = vi.fn();
  render(
    <ChatSettingsPanel
      chat={chat(agentConfig)}
      project={{ ...project, ...projectOverrides }}
      apiDefinitions={apiDefinitions}
      currentApiDefId="api_1"
      currentModelId="m1"
      onOpenModelSelector={vi.fn()}
      onSave={onSave}
      onClose={onClose}
    />
  );
  return { onSave, onClose };
}

/** The Inherit/Override control for one row. */
function toggle(label: string, choice: 'Inherit' | 'Override') {
  const group = screen.getByRole('radiogroup', { name: `${label} source` });
  fireEvent.click(
    Array.from(group.querySelectorAll('button')).find(b => b.textContent === choice) as HTMLElement
  );
}

const save = async (onSave: ReturnType<typeof vi.fn>) => {
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  return onSave.mock.calls[0][0];
};

beforeEach(() => {
  vi.clearAllMocks();
  confirmMock.mockResolvedValue(true);
});

describe('inherit rows', () => {
  it("shows the project's value and no control while inheriting", () => {
    renderPanel();
    expect(screen.getByText('Project: 0.7')).toBeTruthy();
    expect(screen.queryByLabelText('Temperature')).toBeNull();
  });

  it('seeds the control with the inherited value when overriding', () => {
    renderPanel();
    toggle('Temperature', 'Override');
    expect((screen.getByLabelText('Temperature') as HTMLInputElement).value).toBe('0.7');
  });

  it('hides the project value once overridden — it no longer applies', () => {
    renderPanel();
    toggle('Temperature', 'Override');
    expect(screen.queryByText('Project: 0.7')).toBeNull();
  });
});

describe('save payload', () => {
  it('Save is disabled until something changes', () => {
    renderPanel();
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('emits only the overridden key', async () => {
    const { onSave } = renderPanel();
    toggle('Temperature', 'Override');
    fireEvent.change(screen.getByLabelText('Temperature'), { target: { value: '0.2' } });
    expect(await save(onSave)).toEqual({ temperature: 0.2 });
  });

  it('emits undefined when the last override is cleared', async () => {
    const { onSave } = renderPanel({ temperature: 0.2 });
    toggle('Temperature', 'Inherit');
    expect(await save(onSave)).toBeUndefined();
  });

  it('drops a cleared numeric rather than emitting NaN', async () => {
    const { onSave } = renderPanel({ temperature: 0.2 });
    fireEvent.change(screen.getByLabelText('Temperature'), { target: { value: '' } });
    expect(await save(onSave)).toBeUndefined();
  });

  it("keeps nudgeThinking: '' — an explicit disable, not an inherit", async () => {
    const { onSave } = renderPanel();
    toggle('Thinking nudge', 'Override');
    expect(await save(onSave)).toEqual({ nudgeThinking: '' });
  });
});

describe('system prompt section', () => {
  it('disables the prompt sources under the project mode', () => {
    renderPanel();
    expect((screen.getByLabelText('Persona') as HTMLInputElement).disabled).toBe(true);
  });

  it('enables them under replace', () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText(/Replace it/));
    expect((screen.getByLabelText('Persona') as HTMLInputElement).disabled).toBe(false);
  });

  it('auto-fills the namespace from the persona', () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText(/Replace it/));
    fireEvent.change(screen.getByLabelText('Persona'), { target: { value: 'researcher' } });
    expect((screen.getByLabelText('VFS namespace') as HTMLInputElement).value).toBe(
      '/minions/researcher'
    );
  });

  it('stops auto-filling once the namespace is touched', () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText(/Replace it/));
    toggle('VFS namespace', 'Override');
    fireEvent.change(screen.getByLabelText('VFS namespace'), { target: { value: '/mine' } });
    fireEvent.change(screen.getByLabelText('Persona'), { target: { value: 'researcher' } });
    expect((screen.getByLabelText('VFS namespace') as HTMLInputElement).value).toBe('/mine');
  });

  it('never auto-fills over a namespace the chat already had', () => {
    renderPanel({ systemPromptMode: 'replace', namespace: '/existing' });
    fireEvent.change(screen.getByLabelText('Persona'), { target: { value: 'researcher' } });
    expect((screen.getByLabelText('VFS namespace') as HTMLInputElement).value).toBe('/existing');
  });

  it('offers default / off / custom for the pre-persona file', async () => {
    const { onSave } = renderPanel({ systemPromptMode: 'replace', systemPrompt: 'X' });
    fireEvent.click(screen.getByLabelText('Off'));
    expect(await save(onSave)).toMatchObject({ prePersonaSystemPromptFile: '' });
  });
});

describe('tools', () => {
  it('lists only tools the project enables — the project is the ceiling', () => {
    renderPanel();
    toggle('Tools', 'Override');
    expect(screen.getByLabelText('memory', { exact: false })).toBeTruthy();
    expect(screen.queryByText('javascript')).toBeNull();
  });

  it('seeds the override with the full project set', async () => {
    const { onSave } = renderPanel();
    toggle('Tools', 'Override');
    expect(await save(onSave)).toEqual({ enabledTools: ['memory', 'filesystem'] });
  });

  it('shows an unregistered tool as checked so a save cannot drop it', () => {
    renderPanel({ enabledTools: ['memory', 'retired-tool'] });
    expect(screen.getByText('retired-tool (not registered)')).toBeTruthy();
  });
});

describe('provider notes', () => {
  it('marks the knobs Claude Agent ignores', () => {
    render(
      <ChatSettingsPanel
        chat={chat()}
        project={project}
        apiDefinitions={
          [{ id: 'api_ca', name: 'CA', apiType: 'claude-agent' }] as unknown as APIDefinition[]
        }
        currentApiDefId="api_ca"
        currentModelId="m1"
        onOpenModelSelector={vi.fn()}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getAllByText('Ignored by Claude Agent.').length).toBeGreaterThan(0);
  });

  it('omits them for other providers', () => {
    renderPanel();
    expect(screen.queryByText('Ignored by Claude Agent.')).toBeNull();
  });
});

describe('closing', () => {
  it('closes straight away when nothing changed', () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('confirms before discarding unsaved changes', async () => {
    const { onClose } = renderPanel();
    toggle('Temperature', 'Override');
    fireEvent.click(screen.getByText('Close'));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('stays open when the discard is declined', async () => {
    confirmMock.mockResolvedValue(false);
    const { onClose } = renderPanel();
    toggle('Temperature', 'Override');
    fireEvent.click(screen.getByText('Close'));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('dirty state', () => {
  const saveButton = () => screen.getByText('Save') as HTMLButtonElement;

  it('does not count a temperature typed differently but equal', () => {
    renderPanel({ temperature: 1 });
    fireEvent.change(screen.getByLabelText('Temperature'), { target: { value: '1.0' } });
    expect(saveButton().disabled).toBe(true);
  });

  it("does not count a persona left behind by switching back to the project's prompt", () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText(/Replace it/));
    fireEvent.change(screen.getByLabelText('Persona'), { target: { value: 'researcher' } });
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(screen.getByLabelText(/Use the project's prompt/));
    toggle('VFS namespace', 'Inherit');
    expect(saveButton().disabled).toBe(true);
  });

  it('does not count a custom pre-persona file with no path yet', () => {
    renderPanel({ systemPromptMode: 'replace', systemPrompt: 'X' });
    fireEvent.click(screen.getByLabelText('Custom'));
    expect(saveButton().disabled).toBe(true);
  });

  it('does not count an effort override left at the default', () => {
    renderPanel(undefined, { reasoningEffort: undefined });
    toggle('Reasoning effort', 'Override');
    expect(saveButton().disabled).toBe(true);
  });

  it('is clean after a successful save, and closes without asking', async () => {
    const { onSave, onClose } = renderPanel();
    toggle('Temperature', 'Override');
    fireEvent.change(screen.getByLabelText('Temperature'), { target: { value: '0.20' } });
    await save(onSave);
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());

    expect(saveButton().disabled).toBe(true);
    expect((screen.getByLabelText('Temperature') as HTMLInputElement).value).toBe('0.2');
    fireEvent.click(screen.getByText('Close'));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('stays dirty after a failed save', async () => {
    const { onSave } = renderPanel();
    onSave.mockRejectedValueOnce(new Error('offline'));
    toggle('Temperature', 'Override');
    await save(onSave);
    await waitFor(() => expect(screen.getByText('Save failed')).toBeTruthy());

    expect(saveButton().disabled).toBe(false);
  });

  it('cannot be closed while a save runs', async () => {
    let finishSave: () => void = () => {};
    const { onSave, onClose } = renderPanel();
    onSave.mockReturnValueOnce(
      new Promise<void>(resolve => {
        finishSave = resolve;
      })
    );
    toggle('Temperature', 'Override');
    fireEvent.click(screen.getByText('Save'));

    fireEvent.click(screen.getByText('Close'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();

    finishSave();
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
  });
});
