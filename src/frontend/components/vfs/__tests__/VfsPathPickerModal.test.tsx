import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import VfsPathPickerModal from '../VfsPathPickerModal';
import type { DirEntry, VfsAdapter } from '../../../../shared/protocol/types/vfs';

const entry = (name: string, type: 'file' | 'dir'): DirEntry => ({
  name,
  type,
  deleted: false,
  createdAt: 0,
  updatedAt: 0,
});

const LISTINGS: Record<string, DirEntry[]> = {
  '/': [entry('prompts', 'dir'), entry('persona.md', 'file')],
  '/prompts': [entry('style.md', 'file')],
};

const adapter = {
  readDir: vi.fn(async (path: string) => LISTINGS[path]),
} as unknown as VfsAdapter;

function renderPicker(
  initialPath?: string,
  extra: Partial<ComponentProps<typeof VfsPathPickerModal>> = {}
) {
  const onSelect = vi.fn();
  render(
    <VfsPathPickerModal
      isOpen
      adapter={adapter}
      initialPath={initialPath}
      title="Choose a prompt file"
      onCancel={vi.fn()}
      onSelect={onSelect}
      {...extra}
    />
  );
  return onSelect;
}

describe('VfsPathPickerModal', () => {
  it('reveals and preselects the current path', async () => {
    const onSelect = renderPicker('/prompts/style.md');
    const row = await screen.findByRole('treeitem', { name: /style\.md/ });
    expect(row).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect(onSelect).toHaveBeenCalledWith('/prompts/style.md');
  });

  it('only toggles folders and selects files', async () => {
    const onSelect = renderPicker();
    const folder = await screen.findByRole('treeitem', { name: /prompts/ });
    expect(screen.getByRole('button', { name: 'Select' })).toBeDisabled();

    fireEvent.click(folder);
    fireEvent.click(await screen.findByRole('treeitem', { name: /style\.md/ }));
    fireEvent.click(folder);
    expect(folder).toHaveAttribute('aria-expanded', 'false');
    expect(folder).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect(onSelect).toHaveBeenCalledWith('/prompts/style.md');
  });

  it('opens a folder without selecting it', async () => {
    renderPicker(undefined, { openDir: '/prompts' });

    const folder = await screen.findByRole('treeitem', { name: /prompts/ });
    expect(folder).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('treeitem', { name: /style\.md/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select' })).toBeDisabled();
  });

  it('explains and blocks a file the caller rejects', async () => {
    const onSelect = renderPicker(undefined, {
      validate: path => (path.startsWith('/prompts/') ? null : 'Pick a prompt'),
    });

    fireEvent.click(await screen.findByRole('treeitem', { name: /persona\.md/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a prompt');
    expect(screen.getByRole('button', { name: 'Select' })).toBeDisabled();

    fireEvent.click(screen.getByRole('treeitem', { name: /prompts/ }));
    fireEvent.click(await screen.findByRole('treeitem', { name: /style\.md/ }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect(onSelect).toHaveBeenCalledWith('/prompts/style.md');
  });
});
