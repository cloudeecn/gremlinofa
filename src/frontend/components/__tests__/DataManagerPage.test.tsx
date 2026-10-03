import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Stable identities: the page re-runs effects and re-reads the loop snapshot on change
const harness = vi.hoisted(() => ({
  isMobile: false,
  noLoops: [] as never[],
  app: {
    handleExport: vi.fn(),
    handleImport: vi.fn(),
    handleMigrate: vi.fn(),
    purgeAllData: vi.fn(),
    cek: 'cek_test',
    isCEKBase32: true,
    convertCEKToBase32: vi.fn(),
    handleCompressMessages: vi.fn(),
    clearAllModelsCache: vi.fn(),
    storageQuota: null,
    refreshStorageQuota: vi.fn(),
    refreshProjects: vi.fn(),
  },
}));

vi.mock('../../hooks/useApp', () => ({ useApp: () => harness.app }));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => harness.isMobile }));
vi.mock('../../client', () => ({
  gremlinClient: {},
  activeLoopsStore: { subscribe: () => () => {}, getSnapshot: () => harness.noLoops },
}));
vi.mock('../ImportDataModal', () => ({ ImportDataModal: () => null }));
vi.mock('../AdminRecordEditorModal', () => ({ default: () => null }));

import DataManagerPage from '../DataManagerPage';

function renderPage(onMenuPress?: () => void) {
  return render(
    <MemoryRouter initialEntries={['/data']}>
      <Routes>
        <Route path="/data" element={<DataManagerPage onMenuPress={onMenuPress} />} />
        <Route path="/" element={<div>Home page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('DataManagerPage header', () => {
  beforeEach(() => {
    harness.isMobile = false;
  });

  it('links home from the upper right', () => {
    renderPage(vi.fn());
    // Desktop: the sidebar is on screen, so no ☰
    expect(screen.queryByRole('button', { name: 'Open menu' })).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: 'Home' }));
    expect(screen.getByText('Home page')).toBeInTheDocument();
  });

  it('keeps ☰ on the left and Home on the right on a phone', () => {
    harness.isMobile = true;
    const onMenuPress = vi.fn();
    renderPage(onMenuPress);

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(onMenuPress).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
  });
});
