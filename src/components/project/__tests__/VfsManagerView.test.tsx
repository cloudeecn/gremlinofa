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

// Mock vfsService
const mockReadDir = vi.fn();
const mockReadFileWithMeta = vi.fn();
const mockGetFileMeta = vi.fn();
const mockDeleteFile = vi.fn();
const mockRmdir = vi.fn();

vi.mock('../../../services/vfs/vfsService', () => ({
  readDir: (...args: unknown[]) => mockReadDir(...args),
  readFileWithMeta: (...args: unknown[]) => mockReadFileWithMeta(...args),
  getFileMeta: (...args: unknown[]) => mockGetFileMeta(...args),
  deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
  rmdir: (...args: unknown[]) => mockRmdir(...args),
  getBasename: (path: string) => {
    const lastSlash = path.lastIndexOf('/');
    return lastSlash === -1 ? path : path.slice(lastSlash + 1);
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
    mockReadDir.mockResolvedValue([
      { name: 'notes.txt', type: 'file', size: 100 },
      { name: 'docs', type: 'dir' },
    ]);
    mockReadFileWithMeta.mockResolvedValue({
      content: 'File content',
      isBinary: false,
      mime: 'text/plain',
    });
    mockGetFileMeta.mockResolvedValue({ version: 1 });
    mockShowDestructiveConfirm.mockResolvedValue(false);
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

    it('navigates back to project settings on back button click', async () => {
      renderWithRouter(<VfsManagerView {...defaultProps} />);

      fireEvent.click(screen.getByText('←'));

      expect(mockNavigate).toHaveBeenCalledWith('/project/proj_test_123/settings');
    });

    it('renders menu button on mobile when onMenuPress provided', async () => {
      mockIsMobile = true;
      const onMenuPress = vi.fn();

      renderWithRouter(<VfsManagerView {...defaultProps} onMenuPress={onMenuPress} />);

      const menuButton = screen.getByText('☰');
      fireEvent.click(menuButton);

      expect(onMenuPress).toHaveBeenCalled();
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
        expect(screen.getByText('Directory selected')).toBeInTheDocument();
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
        expect(screen.getByText('Delete')).toBeInTheDocument();
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
      mockRmdir.mockResolvedValue(undefined);

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
        expect(mockRmdir).toHaveBeenCalledWith('proj_test_123', '/docs', true);
      });
    });
  });

  describe('Empty State', () => {
    it('shows empty message when no files', async () => {
      mockReadDir.mockResolvedValue([]);

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
      mockRmdir.mockResolvedValue(undefined);

      renderWithRouter(<VfsManagerView {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('docs')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('docs'));

      await waitFor(() => {
        expect(screen.getByText('Delete')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Delete'));

      await waitFor(() => {
        // Tree should be refreshed (readDir called again)
        expect(mockReadDir).toHaveBeenCalledTimes(2);
      });
    });
  });
});
