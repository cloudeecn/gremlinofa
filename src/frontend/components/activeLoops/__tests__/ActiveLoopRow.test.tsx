import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ActiveLoopRow from '../ActiveLoopRow';
import type { ActiveLoop } from '../../../../shared/protocol/protocol';

const mockNavigate = vi.fn();
const mockAbort = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../../client', () => ({
  activeLoopsStore: { abort: (loopId: string) => mockAbort(loopId) },
}));

const loop: ActiveLoop = {
  loopId: 'loop_1',
  chatId: 'chat_1',
  startedAt: Date.now(),
  status: 'running',
  apiDefinitionId: 'api_1',
  modelId: 'model-x',
};

function renderRow(onAfterNavigate = vi.fn()) {
  render(
    <MemoryRouter>
      <ActiveLoopRow loop={loop} chatLabel="Refactor chat" onAfterNavigate={onAfterNavigate} />
    </MemoryRouter>
  );
  return { onAfterNavigate };
}

describe('ActiveLoopRow', () => {
  it.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
  ])('%s on STOP aborts without navigating', async (_key, keys) => {
    const user = userEvent.setup();
    renderRow();
    screen.getByRole('button', { name: 'STOP' }).focus();

    await user.keyboard(keys);

    expect(mockAbort).toHaveBeenCalledWith('loop_1');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('clicking STOP aborts without navigating', async () => {
    const user = userEvent.setup();
    renderRow();
    await user.click(screen.getByRole('button', { name: 'STOP' }));
    expect(mockAbort).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('clicking the row button opens the chat', async () => {
    const user = userEvent.setup();
    const { onAfterNavigate } = renderRow();
    await user.click(screen.getByRole('button', { name: /Refactor chat/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/chat/chat_1');
    expect(onAfterNavigate).toHaveBeenCalledTimes(1);
    expect(mockAbort).not.toHaveBeenCalled();
  });

  it('Enter on the row button opens the chat', async () => {
    const user = userEvent.setup();
    renderRow();
    screen.getByRole('button', { name: /Refactor chat/ }).focus();
    await user.keyboard('{Enter}');
    expect(mockNavigate).toHaveBeenCalledWith('/chat/chat_1');
    expect(mockAbort).not.toHaveBeenCalled();
  });

  it('nests no interactive element inside another', () => {
    renderRow();
    for (const button of screen.getAllByRole('button')) {
      expect(button.querySelector('button, [role="button"]')).toBeNull();
      expect(button.parentElement?.closest('button, [role="button"]')).toBeNull();
    }
  });
});
