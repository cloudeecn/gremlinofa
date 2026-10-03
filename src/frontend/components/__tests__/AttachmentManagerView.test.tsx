import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const manager = vi.hoisted(() => ({
  deleteSelected: vi.fn(),
  selectedIds: new Set(['att_1', 'att_2']),
  sections: [] as unknown[],
}));

vi.mock('../../hooks/useAttachmentManager', () => ({
  useAttachmentManager: () => ({
    sections: manager.sections,
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

// Sections need an IntersectionObserver, which jsdom lacks
vi.mock('../AttachmentSection', () => ({ AttachmentSection: () => null }));

const mockConfirm = vi.fn();
vi.mock('../../lib/alerts', () => ({
  showDestructiveConfirm: (...args: unknown[]) => mockConfirm(...args),
}));

import { AttachmentManagerView } from '../AttachmentManagerView';

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/attachments']}>
      <Routes>
        <Route path="/attachments" element={<AttachmentManagerView />} />
        <Route path="/" element={<div>Home page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('AttachmentManagerView bulk delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    manager.deleteSelected.mockResolvedValue({ deleted: 2, errors: [] });
  });

  const deleteButton = () => screen.getByRole('button', { name: 'Delete' });

  it('asks before deleting the selection', async () => {
    mockConfirm.mockResolvedValue(true);
    renderView();

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
    renderView();

    await act(async () => fireEvent.click(deleteButton()));

    expect(manager.deleteSelected).not.toHaveBeenCalled();
  });
});

describe('AttachmentManagerView menu', () => {
  const menuButton = () => screen.getByRole('button', { name: 'Attachments menu' });

  beforeEach(() => {
    manager.sections = [];
  });

  it('opens Delete older from the menu and closes the menu', () => {
    manager.sections = [
      { chatId: 'c1', attachments: [{ id: 'att_1', timestamp: new Date('2026-01-01') }] },
    ];
    renderView();

    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete older...' }));
    expect(screen.getByRole('heading', { name: 'Delete Old Attachments' })).toBeInTheDocument();
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('holds Delete older, disabled with nothing to delete', () => {
    renderView();
    expect(screen.queryByRole('menuitem', { name: 'Delete older...' })).toBeNull();

    fireEvent.click(menuButton());
    expect(menuButton()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitem', { name: 'Delete older...' })).toBeDisabled();
  });

  it('goes home from the menu', () => {
    renderView();
    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Home' }));
    expect(screen.getByText('Home page')).toBeInTheDocument();
  });
});
