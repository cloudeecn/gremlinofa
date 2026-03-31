import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import VfsFileModal from '../VfsFileModal';
import type { VfsAdapter } from '../../../services/vfs';

// Mock the vfs barrel — only getBasename is used at runtime by VfsFileModal
vi.mock('../../../services/vfs', () => ({
  getBasename: (path: string) => {
    const lastSlash = path.lastIndexOf('/');
    return lastSlash === -1 ? path : path.slice(lastSlash + 1);
  },
}));

function createMockAdapter(): VfsAdapter {
  return {
    readFile: vi.fn().mockResolvedValue('File content here'),
    readFileWithMeta: vi.fn().mockResolvedValue({
      content: 'File content here',
      isBinary: false,
      mime: 'text/plain',
    }),
    getFileMeta: vi.fn().mockResolvedValue({
      version: 3,
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now(),
      minStoredVersion: 1,
      storedVersionCount: 3,
    }),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    getFileId: vi.fn().mockResolvedValue(null),
    listVersions: vi.fn().mockResolvedValue([]),
    getVersion: vi.fn().mockResolvedValue(null),
    writeFile: vi.fn().mockResolvedValue(undefined),
    dropOldVersions: vi.fn().mockResolvedValue(0),
    // Stubs for remaining VfsAdapter methods (not used by the modal)
    readDir: vi.fn().mockResolvedValue([]),
    createFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rmdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    isFile: vi.fn().mockResolvedValue(false),
    isDirectory: vi.fn().mockResolvedValue(false),
    stat: vi.fn().mockResolvedValue({ isFile: false, isDirectory: false }),
    hasVfs: vi.fn().mockResolvedValue(true),
    clearVfs: vi.fn().mockResolvedValue(undefined),
    strReplace: vi.fn().mockResolvedValue({ editLine: 1, snippet: '' }),
    insert: vi.fn().mockResolvedValue({ insertedAt: 1 }),
    appendFile: vi.fn().mockResolvedValue({ created: false }),
    listOrphans: vi.fn().mockResolvedValue([]),
    restoreOrphan: vi.fn().mockResolvedValue(undefined),
    purgeOrphan: vi.fn().mockResolvedValue(undefined),
    compactProject: vi.fn().mockResolvedValue({ freed: 0, remaining: 0 }),
  } as unknown as VfsAdapter;
}

// Mock useAlert
const mockShowDestructiveConfirm = vi.fn();
vi.mock('../../../hooks/useAlert', () => ({
  useAlert: () => ({
    showDestructiveConfirm: mockShowDestructiveConfirm,
  }),
}));

describe('VfsFileModal', () => {
  let mockAdapter: VfsAdapter;

  const getDefaultProps = () => ({
    adapter: mockAdapter,
    path: '/docs/notes.txt',
    isOpen: true,
    onClose: vi.fn(),
    onFileDeleted: vi.fn(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter = createMockAdapter();
    mockShowDestructiveConfirm.mockResolvedValue(false);
  });

  describe('Rendering', () => {
    it('renders nothing when isOpen is false', () => {
      const { container } = render(<VfsFileModal {...getDefaultProps()} isOpen={false} />);
      expect(container).toBeEmptyDOMElement();
    });

    it('renders VfsFileViewer in view mode by default', async () => {
      render(<VfsFileModal {...getDefaultProps()} />);

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
      render(<VfsFileModal {...getDefaultProps()} />);

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
      vi.mocked(mockAdapter.getFileId).mockResolvedValue('file_123');
      vi.mocked(mockAdapter.listVersions).mockResolvedValue([
        { version: 1, createdAt: Date.now() - 86400000 },
        { version: 2, createdAt: Date.now() - 43200000 },
        { version: 3, createdAt: Date.now() },
      ]);
      vi.mocked(mockAdapter.getVersion).mockResolvedValue('Old content');

      render(<VfsFileModal {...getDefaultProps()} />);

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
      render(<VfsFileModal {...getDefaultProps()} />);

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
      render(<VfsFileModal {...getDefaultProps()} />);

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
      vi.mocked(mockAdapter.getFileId).mockResolvedValue('file_123');
      vi.mocked(mockAdapter.listVersions).mockResolvedValue([
        { version: 1, createdAt: Date.now() - 86400000 },
        { version: 2, createdAt: Date.now() },
      ]);
      vi.mocked(mockAdapter.getVersion).mockResolvedValue('Content');

      render(<VfsFileModal {...getDefaultProps()} />);

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
      render(<VfsFileModal {...getDefaultProps()} />);

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
      const onFileDeleted = vi.fn();
      const onClose = vi.fn();

      render(
        <VfsFileModal {...getDefaultProps()} onFileDeleted={onFileDeleted} onClose={onClose} />
      );

      await waitFor(() => {
        expect(screen.getByTitle('Delete file')).not.toBeDisabled();
      });

      fireEvent.click(screen.getByTitle('Delete file'));

      await waitFor(() => {
        expect(mockAdapter.deleteFile).toHaveBeenCalledWith('/docs/notes.txt');
      });

      expect(onFileDeleted).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });

    it('does not delete when confirmation cancelled', async () => {
      mockShowDestructiveConfirm.mockResolvedValue(false);
      const onFileDeleted = vi.fn();

      render(<VfsFileModal {...getDefaultProps()} onFileDeleted={onFileDeleted} />);

      await waitFor(() => {
        expect(screen.getByTitle('Delete file')).not.toBeDisabled();
      });

      fireEvent.click(screen.getByTitle('Delete file'));

      await waitFor(() => {
        expect(mockShowDestructiveConfirm).toHaveBeenCalled();
      });

      expect(mockAdapter.deleteFile).not.toHaveBeenCalled();
      expect(onFileDeleted).not.toHaveBeenCalled();
    });
  });

  describe('Close Behavior', () => {
    it('calls onClose when close button clicked in view mode', async () => {
      const onClose = vi.fn();

      render(<VfsFileModal {...getDefaultProps()} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByTitle('Close')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle('Close'));

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('Content Refresh', () => {
    it('refreshes content after save', async () => {
      // VfsFileViewer uses readFileWithMeta, VfsFileEditor uses readFile
      vi.mocked(mockAdapter.readFileWithMeta).mockResolvedValueOnce({
        content: 'Original content',
        isBinary: false,
        mime: 'text/plain',
      });
      vi.mocked(mockAdapter.readFile).mockResolvedValueOnce('Original content'); // For editor
      vi.mocked(mockAdapter.readFileWithMeta).mockResolvedValueOnce({
        content: 'Updated content',
        isBinary: false,
        mime: 'text/plain',
      });

      render(<VfsFileModal {...getDefaultProps()} />);

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
        expect(mockAdapter.readFileWithMeta).toHaveBeenCalledTimes(2); // Initial + refresh
      });
    });
  });

  describe('Path Changes', () => {
    it('resets to view mode when path changes', async () => {
      vi.mocked(mockAdapter.getFileId).mockResolvedValue('file_123');
      vi.mocked(mockAdapter.listVersions).mockResolvedValue([
        { version: 1, createdAt: Date.now() - 86400000 },
        { version: 2, createdAt: Date.now() },
      ]);
      vi.mocked(mockAdapter.getVersion).mockResolvedValue('Content');

      const props = getDefaultProps();
      const { rerender } = render(<VfsFileModal {...props} />);

      await waitFor(() => {
        expect(screen.getByTitle('View diff')).not.toBeDisabled();
      });

      // Go to diff mode
      fireEvent.click(screen.getByTitle('View diff'));

      await waitFor(() => {
        expect(screen.getByText('(version history)')).toBeInTheDocument();
      });

      // Change path
      rerender(<VfsFileModal {...props} path="/other/file.txt" />);

      await waitFor(() => {
        // Should be back in view mode
        expect(screen.getByTitle('Edit file')).toBeInTheDocument();
      });
    });
  });
});
