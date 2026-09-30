import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const manager = vi.hoisted(() => ({
  deleteSelected: vi.fn(),
  selectedIds: new Set(['att_1', 'att_2']),
}));

vi.mock('../../hooks/useAttachmentManager', () => ({
  useAttachmentManager: () => ({
    sections: [],
    loadedData: new Map(),
    selectedIds: manager.selectedIds,
    isLoading: false,
    error: null,
    loadSections: vi.fn(),
    loadSectionData: vi.fn(),
    unloadSectionData: vi.fn(),
    toggleSelection: vi.fn(),
    selectAllInSection: vi.fn(),
    deselectAllInSection: vi.fn(),
    clearSelection: vi.fn(),
    deleteSelected: manager.deleteSelected,
    deleteOlderThan: vi.fn(),
  }),
}));

const mockConfirm = vi.fn();
vi.mock('../../lib/alerts', () => ({
  showDestructiveConfirm: (...args: unknown[]) => mockConfirm(...args),
}));

import { AttachmentManagerView } from '../AttachmentManagerView';

describe('AttachmentManagerView bulk delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    manager.deleteSelected.mockResolvedValue({ deleted: 2, errors: [] });
  });

  const deleteButton = () => screen.getByRole('button', { name: 'Delete' });

  it('asks before deleting the selection', async () => {
    mockConfirm.mockResolvedValue(true);
    render(<AttachmentManagerView />);

    await act(async () => fireEvent.click(deleteButton()));

    expect(mockConfirm).toHaveBeenCalledWith(
      'Delete attachments',
      expect.stringContaining('Delete 2 attachments?'),
      'Delete'
    );
    expect(manager.deleteSelected).toHaveBeenCalled();
  });

  it('deletes nothing when the confirm is cancelled', async () => {
    mockConfirm.mockResolvedValue(false);
    render(<AttachmentManagerView />);

    await act(async () => fireEvent.click(deleteButton()));

    expect(manager.deleteSelected).not.toHaveBeenCalled();
  });
});
