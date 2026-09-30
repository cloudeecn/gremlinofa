import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CloneMinionChatModal from '../CloneMinionChatModal';
import type { MinionChat } from '../../../../shared/protocol/types';

function minionChat(overrides: Partial<MinionChat> = {}): MinionChat {
  return {
    id: 'mc_test',
    parentChatId: 'chat_parent',
    projectId: 'proj_1',
    createdAt: new Date('2025-01-01'),
    lastModifiedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function renderModal(chat: MinionChat | null, opts: { isCloning?: boolean } = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <CloneMinionChatModal
      minionChat={chat}
      messageCount={7}
      isCloning={opts.isCloning ?? false}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
  return { onConfirm, onCancel };
}

const nameInput = () => screen.getByLabelText('Chat name') as HTMLInputElement;

describe('default name', () => {
  it('prefers the display name', () => {
    renderModal(minionChat({ displayName: 'Deep Research', persona: 'researcher' }));
    expect(nameInput().value).toBe('Deep Research (clone)');
  });

  it('falls back to the persona', () => {
    renderModal(minionChat({ persona: 'researcher' }));
    expect(nameInput().value).toBe('researcher (clone)');
  });

  it('falls back to a generic label', () => {
    renderModal(minionChat());
    expect(nameInput().value).toBe('Minion (clone)');
  });

  it("caps at the chat-name limit so the field can't promise more than it keeps", () => {
    renderModal(minionChat({ displayName: 'x'.repeat(80) }));
    expect(nameInput().value).toHaveLength(50);
  });
});

describe('notices', () => {
  it('always warns that `return` is not copied', () => {
    renderModal(minionChat());
    expect(screen.getByText(/is not copied/)).toBeTruthy();
  });

  it('warns about the SDK session only for claude-agent minions', () => {
    renderModal(minionChat({ claudeAgentSessionId: 'sess-a' }));
    expect(screen.getByText(/Claude Agent/)).toBeTruthy();
  });

  it('says nothing about Claude Agent otherwise', () => {
    renderModal(minionChat());
    expect(screen.queryByText(/Claude Agent/)).toBeNull();
  });
});

describe('carried-over summary', () => {
  it('lists persona, model, tools and message count', () => {
    renderModal(
      minionChat({ persona: 'researcher', modelId: 'claude-opus-5', enabledTools: ['memory'] })
    );
    expect(screen.getByText('researcher')).toBeTruthy();
    expect(screen.getByText('claude-opus-5')).toBeTruthy();
    expect(screen.getByText('memory')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('hides the tools the clone will not get', () => {
    renderModal(minionChat({ enabledTools: ['memory', 'return', 'minion'] }));
    expect(screen.getByText('memory')).toBeTruthy();
    expect(screen.queryByText(/return, minion/)).toBeNull();
  });

  it('reports an empty tool set rather than an empty row', () => {
    renderModal(minionChat({ enabledTools: [] }));
    expect(screen.getByText('none')).toBeTruthy();
  });
});

describe('actions', () => {
  it('confirms with the edited name', () => {
    const { onConfirm } = renderModal(minionChat());
    fireEvent.change(nameInput(), { target: { value: 'My Clone' } });
    fireEvent.click(screen.getByText('Clone'));
    expect(onConfirm).toHaveBeenCalledWith('My Clone');
  });

  it('blocks confirming with a blank name', () => {
    const { onConfirm } = renderModal(minionChat());
    fireEvent.change(nameInput(), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Clone'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows progress and blocks both buttons while cloning', () => {
    const { onConfirm, onCancel } = renderModal(minionChat(), { isCloning: true });
    const cloneButton = screen.getByText('Cloning…');
    fireEvent.click(cloneButton);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('ignores the close button, backdrop and Escape while cloning', () => {
    const { onCancel } = renderModal(minionChat(), { isCloning: true });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(document.querySelector<HTMLElement>('.bg-black\\/50')!);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels', () => {
    const { onCancel } = renderModal(minionChat());
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('closes from the backdrop and Escape when idle', () => {
    const { onCancel } = renderModal(minionChat());
    fireEvent.click(document.querySelector<HTMLElement>('.bg-black\\/50')!);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
