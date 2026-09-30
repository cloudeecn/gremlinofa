import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import ChatSettingsPanel from '../ChatSettingsPanel';
import Modal from '../../ui/Modal';
import { AlertProvider } from '../../../contexts/AlertProvider';
import type { APIDefinition, Chat, Project } from '../../../../shared/protocol/types';

/**
 * Escape with layers on top of the panel, through the real AlertProvider and
 * Modal (the main ChatSettingsPanel suite mocks the alerts).
 */

vi.mock('../../../hooks/useToolInventory', () => ({ useToolInventory: () => [] }));

vi.mock('../../../client', () => ({
  gremlinClient: {
    getVfsAdapter: () => ({ exists: vi.fn(async () => true) }),
    previewChatSystemPrompt: vi.fn(async () => ({ text: '', segments: [] })),
  },
}));

const project = {
  id: 'proj_1',
  name: 'P',
  createdAt: new Date(0),
  lastUsedAt: new Date(0),
  systemPrompt: '',
  preFillResponse: '',
  apiDefinitionId: 'api_1',
  modelId: 'm1',
  webSearchEnabled: false,
  temperature: 0.7,
  maxOutputTokens: 4096,
  enableReasoning: false,
  reasoningBudgetTokens: 2048,
} as Project;

const chat: Chat = {
  id: 'chat_1',
  projectId: 'proj_1',
  name: 'Chat',
  apiDefinitionId: null,
  modelId: null,
  createdAt: new Date(0),
  lastModifiedAt: new Date(0),
};

function renderPanel(pickerOpen = false, onClosePicker = vi.fn()) {
  const onClose = vi.fn();
  render(
    <AlertProvider>
      <ChatSettingsPanel
        chat={chat}
        project={project}
        apiDefinitions={[{ id: 'api_1', apiType: 'anthropic' } as unknown as APIDefinition]}
        currentApiDefId="api_1"
        currentModelId="m1"
        onOpenModelSelector={vi.fn()}
        onSave={vi.fn(async () => {})}
        onClose={onClose}
      />
      {/* Stands in for the model picker ChatView opens over the panel */}
      <Modal isOpen={pickerOpen} onClose={onClosePicker} ariaLabel="Model picker">
        picker
      </Modal>
    </AlertProvider>
  );
  return { onClose };
}

async function pressEscape() {
  await act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' });
  });
}

describe('ChatSettingsPanel with layers on top', () => {
  it('Escape closes the panel when nothing is on top', async () => {
    const { onClose } = renderPanel();
    await pressEscape();
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape in a picker opened over the panel closes only the picker', async () => {
    const onClosePicker = vi.fn();
    const { onClose } = renderPanel(true, onClosePicker);

    await pressEscape();

    expect(onClosePicker).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape on the "Discard changes?" confirm cancels it instead of asking again', async () => {
    const { onClose } = renderPanel();
    const group = screen.getByRole('radiogroup', { name: 'Temperature source' });
    fireEvent.click(
      Array.from(group.querySelectorAll('button')).find(b => b.textContent === 'Override')!
    );

    await pressEscape();
    expect(screen.getByRole('alertdialog', { name: 'Discard changes?' })).toBeInTheDocument();

    await pressEscape();

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
