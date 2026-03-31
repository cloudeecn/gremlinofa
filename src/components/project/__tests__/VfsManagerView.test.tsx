import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import VfsManagerView from '../VfsManagerView';

// Mock react-router-dom's useNavigate
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Mock adapter for VFS operations (hoisted so vi.mock can reference it)
const mockAdapter = vi.hoisted(() => ({
  readDir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockResolvedValue(''),
  readFileWithMeta: vi.fn().mockResolvedValue({ content: '', isBinary: false, mime: 'text/plain' }),
  writeFile: vi.fn().mockResolvedValue(undefined),
  createFile: vi.fn().mockResolvedValue(undefined),
  deleteFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rmdir: vi.fn().mockResolvedValue(undefined),
  isFile: vi.fn().mockResolvedValue(false),
  isDirectory: vi.fn().mockResolvedValue(false),
  exists: vi.fn().mockResolvedValue(false),
  getFileMeta: vi.fn().mockResolvedValue({
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    minStoredVersion: 1,
    storedVersionCount: 1,
  }),
}));

vi.mock('../../../hooks/useVfsAdapter', () => ({
  useVfsAdapter: vi.fn(() => mockAdapter),
}));

// Mock vfs barrel — only utility functions
vi.mock('../../../services/vfs', () => ({
  getBasename: (path: string) => {
    const lastSlash = path.lastIndexOf('/');
    return lastSlash === -1 ? path : path.slice(lastSlash + 1);
  },
  getPathSegments: (path: string) => {
    const normalized = path === '/' ? '/' : path.replace(/\/+$/, '') || '/';
    if (normalized === '/') return [];
    return normalized.slice(1).split('/');
  },
}));

// Mock useIsMobile
let mockIsMobile = false;
vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile,
}));

// Mock useAlert
const mockShowDestructiveConfirm = vi.fn();
vi.mock('../../../hooks/useAlert', () => ({
  useAlert: () => ({
    showDestructiveConfirm: mockShowDestructiveConfirm,
  }),
}));

function renderWithRouter(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('VfsManagerView', () => {
  const defaultProps = {
    projectId: 'proj_test_123',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMobile = false;
    mockAdapter.readDir.mockResolvedValue([
      { name: 'notes.txt', type: 'file', size: 100 },
      { name: 'docs', type: 'dir' },
    ]);
    mockAdapter.readFileWithMeta.mockResolvedValue({
      content: 'File content',
      isBinary: false,
      mime: 'text/plain',
    });
    mockShowDestructiveConfirm.mockResolvedValue(false);
    mockAdapter.isFile.mockResolvedValue(false);
    mockAdapter.isDirectory.mockResolvedValue(false);
  });

  describe('Header', () => {
    it('renders header with title', async () => {
      renderWithRouter(<VfsManagerView {...defaultProps} />);

      // Both header and VfsDirectoryTree have "Memory Files" text
      expect(screen.getByRole('heading', { name: 'Memory Files' })).toBeInTheDocument();
    });

    it('renders back button', async () => {
      renderWithRouter(<VfsManagerView {...defaultProps} />);

      expect(screen.getByText('←')).toBeInTheDocument();
    });

    it('navigates back to project view on back button click', async () => {
      renderWithRouter(<VfsManagerView {...defaultProps} />);

      fireEvent.click(screen.getByText('←'));

      expect(mockNavigate).toHaveBeenCalledWith('/project/proj_test_123');
    });
  });

  describe('Desktop Layout', () => {
    beforeEach(() => {
      mockIsMobile = false;
    });

    it('renders directory tree and content panel side by side', async () => {
      renderWithRouter(<VfsManagerView {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('notes.txt')).toBeInTheDocument();
      });

      expect(screen.getByText('Select a file to view its content')).toBeInTheDocument();
    });

    it('shows file content when file selected', async () => {
      renderWithRouter(<VfsManagerView {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('notes.txt')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('notes.txt'));

      await waitFor(() => {
        expect(screen.getByText('File content')).toBeInTheDocument();
      });
    });

    it('shows directory info when directory selected', async () => {
      renderWithRouter(<VfsManagerView {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('docs')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('docs'));

      await waitFor(() => {
        // Directory actions panel should be visible with action buttons
        expect(screen.getByText('📄 New File')).toBeInTheDocument();
      });
    });
  });

  describe('Mobile Layout', () => {
    beforeEach(() => {
      mockIsMobile = true;
    });

    it('renders directory tree full width', async () => {
      renderWithRouter(<VfsManagerView {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('notes.txt')).toBeInTheDocument();
      });
    });

    it('shows directory actions when directory selected', async () => {
      renderWithRouter(<VfsManagerView {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('docs')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('docs'));

      await waitFor(() => {
        expect(screen.getByText('Selected:')).toBeInTheDocument();
        expect(screen.getByText('🗑️ Delete')).toBeInTheDocument();
      });
    });
  });

  describe('Delete Functionality', () => {
    it('confirms before deleting directory', async () => {
      mockIsMobile = false;
      mockShowDestructiveConfirm.mockResolvedValue(false);

      renderWithRouter(<VfsManagerView {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('docs')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('docs'));

      await waitFor(() => {
        expect(screen.getByText('🗑️ Delete Directory')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('🗑️ Delete Directory'));

      expect(mockShowDestructiveConfirm).toHaveBeenCalledWith(
        'Delete Directory',
        expect.stringContaining('docs'),
        'Delete'
      );
    });

    it('deletes directory when confirmed', async () => {
      mockIsMobile = false;
      mockShowDestructiveConfirm.mockResolvedValue(true);
      mockAdapter.rmdir.mockResolvedValue(undefined);

      renderWithRouter(<VfsManagerView {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('docs')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('docs'));

      await waitFor(() => {
        expect(screen.getByText('🗑️ Delete Directory')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('🗑️ Delete Directory'));

      await waitFor(() => {
        expect(mockAdapter.rmdir).toHaveBeenCalledWith('/docs', true);
      });
    });
  });

  describe('Root Selection', () => {
    it('shows directory actions when root is selected', async () => {
      mockIsMobile = false;

      renderWithRouter(<VfsManagerView {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('/')).toBeInTheDocument();
      });

      // Click the root node
      fireEvent.click(screen.getByText('/'));

      await waitFor(() => {
        // Directory actions should be visible
        expect(screen.getByText('📄 New File')).toBeInTheDocument();
        expect(screen.getByText('📁 New Folder')).toBeInTheDocument();
        expect(screen.getByText('📦 Download ZIP')).toBeInTheDocument();
      });
    });

    it('hides delete button when root is selected (desktop)', async () => {
      mockIsMobile = false;

      renderWithRouter(<VfsManagerView {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('/')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('/'));

      await waitFor(() => {
        expect(screen.getByText('📄 New File')).toBeInTheDocument();
      });

      // Delete button should NOT be present for root
      expect(screen.queryByText('🗑️ Delete Directory')).not.toBeInTheDocument();
    });

    it('hides delete button when root is selected (mobile)', async () => {
      mockIsMobile = true;

      renderWithRouter(<VfsManagerView {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('/')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('/'));

      await waitFor(() => {
        expect(screen.getByText('📄 New File')).toBeInTheDocument();
      });

      // Delete button should NOT be present for root
      expect(screen.queryByText('🗑️ Delete')).not.toBeInTheDocument();
    });
  });

  describe('Empty State', () => {
    it('shows empty message when no files', async () => {
      mockAdapter.readDir.mockResolvedValue([]);

      renderWithRouter(<VfsManagerView {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('No files yet')).toBeInTheDocument();
      });
    });
  });

  describe('Tree Refresh', () => {
    it('refreshes tree after file delete on mobile', async () => {
      mockIsMobile = true;
      mockShowDestructiveConfirm.mockResolvedValue(true);
      mockAdapter.rmdir.mockResolvedValue(undefined);

      renderWithRouter(<VfsManagerView {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('docs')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('docs'));

      await waitFor(() => {
        expect(screen.getByText('🗑️ Delete')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('🗑️ Delete'));

      await waitFor(() => {
        // Tree should be refreshed (readDir called again)
        expect(mockAdapter.readDir).toHaveBeenCalledTimes(2);
      });
    });
  });
});
