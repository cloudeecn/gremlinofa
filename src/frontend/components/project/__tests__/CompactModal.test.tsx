import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { CompactResult } from '../../../../shared/protocol/types/vfs';

vi.mock('../../../client', () => ({
  gremlinClient: { vfsCompactProject: vi.fn() },
}));
vi.mock('../../../lib/alerts', () => ({ showDestructiveConfirm: vi.fn() }));

import CompactModal from '../CompactModal';
import { gremlinClient } from '../../../client';

const compactResult: CompactResult = {
  purgedNodes: 1,
  purgedOrphans: 0,
  prunedRevisions: 0,
  collapsedFiles: 0,
  treeNodes: 4,
  fileCount: 3,
  totalRevisions: 3,
};

function pendingCompact() {
  let finish: (result: CompactResult) => void = () => {};
  vi.mocked(gremlinClient.vfsCompactProject).mockImplementation(
    () =>
      new Promise<CompactResult>(resolve => {
        finish = resolve;
      })
  );
  return { finish: (result: CompactResult) => finish(result) };
}

const backdrop = () => document.querySelector<HTMLElement>('.bg-black\\/50')!;

describe('CompactModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores the backdrop, Escape and Cancel while the compact runs', async () => {
    const compact = pendingCompact();
    const onClose = vi.fn();
    render(<CompactModal isOpen onClose={onClose} projectId="p1" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Compact' }));
    });
    expect(screen.getByText('Compacting...')).toBeInTheDocument();

    fireEvent.click(backdrop());
    fireEvent.keyDown(document, { key: 'Escape' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeDisabled();
    fireEvent.click(cancel);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await act(async () => {
      compact.finish(compactResult);
    });
    expect(screen.getByText('Project Compacted')).toBeInTheDocument();
  });

  it('closes on the backdrop and Escape again once the compact is done', async () => {
    const compact = pendingCompact();
    const onClose = vi.fn();
    render(<CompactModal isOpen onClose={onClose} projectId="p1" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Compact' }));
    });
    await act(async () => {
      compact.finish(compactResult);
    });

    fireEvent.click(backdrop());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closes on the backdrop before the compact starts', () => {
    const onClose = vi.fn();
    render(<CompactModal isOpen onClose={onClose} projectId="p1" />);

    fireEvent.click(backdrop());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('starts from a fresh form each time it opens', async () => {
    const compact = pendingCompact();
    const { rerender } = render(<CompactModal isOpen onClose={vi.fn()} projectId="p1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Compact' }));
    });
    await act(async () => {
      compact.finish(compactResult);
    });

    rerender(<CompactModal isOpen={false} onClose={vi.fn()} projectId="p1" />);
    rerender(<CompactModal isOpen onClose={vi.fn()} projectId="p1" />);
    expect(screen.getByRole('button', { name: 'Compact' })).toBeInTheDocument();
    expect(screen.queryByText('Project Compacted')).not.toBeInTheDocument();
  });
});
