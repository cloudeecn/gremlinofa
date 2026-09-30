import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import ProjectNameIconModal from '../ProjectNameIconModal';
import type { Project } from '../../../../shared/protocol/types';

const project = {
  id: 'proj_1',
  name: 'Garden',
  icon: '🌱',
  createdAt: new Date('2026-01-01'),
  lastUsedAt: new Date('2026-01-01'),
} as Project;

const backdrop = () => document.querySelector<HTMLElement>('.bg-black\\/50')!;

describe('ProjectNameIconModal', () => {
  it('ignores every close path while a save is in flight', async () => {
    let finishSave: () => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishSave = resolve;
        })
    );
    const onCancel = vi.fn();
    render(<ProjectNameIconModal isOpen project={project} onSave={onSave} onCancel={onCancel} />);

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Garden', icon: '🌱' }));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(backdrop());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();

    await act(async () => finishSave());
    fireEvent.click(backdrop());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
