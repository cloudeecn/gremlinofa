import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import SystemPromptModal from '../SystemPromptModal';

const backdrop = () => document.querySelector<HTMLElement>('.bg-black\\/50')!;

function renderModal(onSave: (value: string) => Promise<boolean>) {
  const onCancel = vi.fn();
  render(
    <SystemPromptModal
      isOpen
      contextId="proj_1"
      initialValue="Be terse."
      onSave={onSave}
      onCancel={onCancel}
    />
  );
  return { onCancel };
}

describe('SystemPromptModal', () => {
  it('ignores every close path while a save is in flight', async () => {
    let finishSave: () => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          finishSave = () => resolve(true);
        })
    );
    const { onCancel } = renderModal(onSave);

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(onSave).toHaveBeenCalledWith('Be terse.');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(backdrop());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();

    await act(async () => finishSave());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('closes from the close button, backdrop and Escape when idle', () => {
    const { onCancel } = renderModal(vi.fn(async () => true));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(backdrop());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(3);
  });

  it('keeps the draft when the save fails, and clears it when the save lands', async () => {
    vi.useFakeTimers();
    try {
      const onSave = vi.fn(async () => false);
      renderModal(onSave);
      const field = screen.getByPlaceholderText(/Enter system prompt/);
      act(() => {
        fireEvent.change(field, { target: { value: 'Be verbose.' } });
      });
      act(() => vi.advanceTimersByTime(600));
      const draftKey = 'draft_system-prompt-modal_proj_1';
      expect(localStorage.getItem(draftKey)).not.toBeNull();

      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
      expect(localStorage.getItem(draftKey)).not.toBeNull();

      onSave.mockResolvedValue(true);
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
      expect(localStorage.getItem(draftKey)).toBeNull();
    } finally {
      vi.useRealTimers();
      localStorage.clear();
    }
  });
});
