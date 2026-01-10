import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import VfsFileModal from '../VfsFileModal';

// Mock vfsService
const mockReadFile = vi.fn();
const mockGetFileMeta = vi.fn();
const mockDeleteFile = vi.fn();
const mockGetFileId = vi.fn();
const mockListVersions = vi.fn();
const mockGetVersion = vi.fn();
const mockUpdateFile = vi.fn();

vi.mock('../../../services/vfs/vfsService', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  getFileMeta: (...args: unknown[]) => mockGetFileMeta(...args),
  deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
  getFileId: (...args: unknown[]) => mockGetFileId(...args),
  listVersions: (...args: unknown[]) => mockListVersions(...args),
  getVersion: (...args: unknown[]) => mockGetVersion(...args),
  updateFile: (...args: unknown[]) => mockUpdateFile(...args),
  getBasename: (path: string) => {
    const lastSlash = path.lastIndexOf('/');
    return lastSlash === -1 ? path : path.slice(lastSlash + 1);
  },
}));

// Mock useAlert
const mockShowDestructiveConfirm = vi.fn();
vi.mock('../../../hooks/useAlert', () => ({
  useAlert: () => ({
    showDestructiveConfirm: mockShowDestructiveConfirm,
  }),
}));

describe('VfsFileModal', () => {
  const defaultProps = {
    projectId: 'proj_test_123',
    path: '/docs/notes.txt',
    isOpen: true,
    onClose: vi.fn(),
    onFileDeleted: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue('File content here');
    mockGetFileMeta.mockResolvedValue({
      version: 3,
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now(),
    });
    mockShowDestructiveConfirm.mockResolvedValue(false);
  });

  describe('Rendering', () => {
    it('renders nothing when isOpen is false', () => {
      const { container } = render(<VfsFileModal {...defaultProps} isOpen={false} />);
      expect(container).toBeEmptyDOMElement();
    });

    it('renders VfsFileViewer in view mode by default', async () => {
      render(<VfsFileModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('File content here')).toBeInTheDocument();
      });

      expect(screen.getByTitle('Edit file')).toBeInTheDocument();
      expect(screen.getByTitle('View diff')).toBeInTheDocument();
      expect(screen.getByTitle('Delete file')).toBeInTheDocument();
    });
  });

  describe('Mode Transitions', () => {
    it('transitions to edit mode when Edit clicked', async () => {
      render(<VfsFileModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTitle('Edit file')).not.toBeDisabled();
      });

      fireEvent.click(screen.getByTitle('Edit file'));

      await waitFor(() => {
        // Editor shows "(editing)" label
        expect(screen.getByText('(editing)')).toBeInTheDocument();
      });

      // Should have Cancel and Save buttons
      expect(screen.getByText('Cancel')).toBeInTheDocument();
      expect(screen.getByText('Save')).toBeInTheDocument();
    });

    it('transitions to diff mode when Diff clicked', async () => {
      mockGetFileId.mockResolvedValue('file_123');
      mockListVersions.mockResolvedValue([
        { version: 1, createdAt: Date.now() - 86400000 },
        { version: 2, createdAt: Date.now() - 43200000 },
        { version: 3, createdAt: Date.now() },
      ]);
      mockGetVersion.mockResolvedValue('Old content');

      render(<VfsFileModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTitle('View diff')).not.toBeDisabled();
      });

      fireEvent.click(screen.getByTitle('View diff'));

      await waitFor(() => {
        // Diff viewer shows "(version history)" label
        expect(screen.getByText('(version history)')).toBeInTheDocument();
      });
    });

    it('returns to view mode when Cancel clicked in edit mode', async () => {
      render(<VfsFileModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTitle('Edit file')).not.toBeDisabled();
      });

      // Go to edit mode
      fireEvent.click(screen.getByTitle('Edit file'));

      await waitFor(() => {
        expect(screen.getByText('(editing)')).toBeInTheDocument();
      });

      // Click Cancel
      fireEvent.click(screen.getByText('Cancel'));

      await waitFor(() => {
        // Back to view mode - should show action buttons
        expect(screen.getByTitle('Edit file')).toBeInTheDocument();
      });
    });

    it('returns to view mode after save', async () => {
      mockUpdateFile.mockResolvedValue(undefined);

      render(<VfsFileModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTitle('Edit file')).not.toBeDisabled();
      });

      // Go to edit mode
      fireEvent.click(screen.getByTitle('Edit file'));

      await waitFor(() => {
        expect(screen.getByText('Save')).toBeInTheDocument();
      });

      // Click Save
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        // Back to view mode
        expect(screen.getByTitle('Edit file')).toBeInTheDocument();
      });
    });

    it('returns to view mode when diff Close clicked', async () => {
      mockGetFileId.mockResolvedValue('file_123');
      mockListVersions.mockResolvedValue([
        { version: 1, createdAt: Date.now() - 86400000 },
        { version: 2, createdAt: Date.now() },
      ]);
      mockGetVersion.mockResolvedValue('Content');

      render(<VfsFileModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTitle('View diff')).not.toBeDisabled();
      });

      // Go to diff mode
      fireEvent.click(screen.getByTitle('View diff'));

      await waitFor(() => {
        expect(screen.getByText('(version history)')).toBeInTheDocument();
      });

      // Wait for diff content to load (Close button appears in action bar)
      await waitFor(() => {
        expect(screen.getByText('Close')).toBeInTheDocument();
      });

      // Click Close in diff viewer
      fireEvent.click(screen.getByText('Close'));

      await waitFor(() => {
        // Back to view mode
        expect(screen.getByTitle('Edit file')).toBeInTheDocument();
      });
    });
  });

  describe('Delete Functionality', () => {
    it('shows confirmation dialog when Delete clicked', async () => {
      render(<VfsFileModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTitle('Delete file')).not.toBeDisabled();
      });

      fireEvent.click(screen.getByTitle('Delete file'));

      expect(mockShowDestructiveConfirm).toHaveBeenCalledWith(
        'Delete File',
        'Are you sure you want to delete "notes.txt"? This file will be marked as deleted.',
        'Delete'
      );
    });

    it('deletes file and calls callbacks when confirmed', async () => {
      mockShowDestructiveConfirm.mockResolvedValue(true);
      mockDeleteFile.mockResolvedValue(undefined);
      const onFileDeleted = vi.fn();
      const onClose = vi.fn();

      render(<VfsFileModal {...defaultProps} onFileDeleted={onFileDeleted} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByTitle('Delete file')).not.toBeDisabled();
      });

      fireEvent.click(screen.getByTitle('Delete file'));

      await waitFor(() => {
        expect(mockDeleteFile).toHaveBeenCalledWith('proj_test_123', '/docs/notes.txt');
      });

      expect(onFileDeleted).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });

    it('does not delete when confirmation cancelled', async () => {
      mockShowDestructiveConfirm.mockResolvedValue(false);
      const onFileDeleted = vi.fn();

      render(<VfsFileModal {...defaultProps} onFileDeleted={onFileDeleted} />);

      await waitFor(() => {
        expect(screen.getByTitle('Delete file')).not.toBeDisabled();
      });

      fireEvent.click(screen.getByTitle('Delete file'));

      await waitFor(() => {
        expect(mockShowDestructiveConfirm).toHaveBeenCalled();
      });

      expect(mockDeleteFile).not.toHaveBeenCalled();
      expect(onFileDeleted).not.toHaveBeenCalled();
    });
  });

  describe('Close Behavior', () => {
    it('calls onClose when close button clicked in view mode', async () => {
      const onClose = vi.fn();

      render(<VfsFileModal {...defaultProps} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByTitle('Close')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle('Close'));

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('Content Refresh', () => {
    it('refreshes content after save', async () => {
      mockReadFile.mockResolvedValueOnce('Original content');
      mockUpdateFile.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValueOnce('Updated content');

      render(<VfsFileModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Original content')).toBeInTheDocument();
      });

      // Go to edit mode
      fireEvent.click(screen.getByTitle('Edit file'));

      await waitFor(() => {
        expect(screen.getByText('Save')).toBeInTheDocument();
      });

      // Save
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        // View mode should reload content
        expect(mockReadFile).toHaveBeenCalledTimes(3); // Initial + edit load + refresh
      });
    });
  });

  describe('Path Changes', () => {
    it('resets to view mode when path changes', async () => {
      mockGetFileId.mockResolvedValue('file_123');
      mockListVersions.mockResolvedValue([
        { version: 1, createdAt: Date.now() - 86400000 },
        { version: 2, createdAt: Date.now() },
      ]);
      mockGetVersion.mockResolvedValue('Content');

      const { rerender } = render(<VfsFileModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTitle('View diff')).not.toBeDisabled();
      });

      // Go to diff mode
      fireEvent.click(screen.getByTitle('View diff'));

      await waitFor(() => {
        expect(screen.getByText('(version history)')).toBeInTheDocument();
      });

      // Change path
      rerender(<VfsFileModal {...defaultProps} path="/other/file.txt" />);

      await waitFor(() => {
        // Should be back in view mode
        expect(screen.getByTitle('Edit file')).toBeInTheDocument();
      });
    });
  });
});
