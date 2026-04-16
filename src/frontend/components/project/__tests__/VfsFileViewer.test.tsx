import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import VfsFileViewer from '../VfsFileViewer';
import type { VfsAdapter } from '../../../../shared/protocol/types/vfs';

function createMockAdapter(overrides?: Partial<VfsAdapter>): VfsAdapter {
  return {
    readDir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(''),
    readFileWithMeta: vi.fn().mockResolvedValue({
      content: 'File content here',
      isBinary: false,
      mime: 'text/plain',
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    createFile: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rmdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    isFile: vi.fn().mockResolvedValue(false),
    isDirectory: vi.fn().mockResolvedValue(false),
    stat: vi.fn().mockResolvedValue({ size: 0, mtime: 0 }),
    hasVfs: vi.fn().mockResolvedValue(true),
    clearVfs: vi.fn().mockResolvedValue(undefined),
    strReplace: vi.fn().mockResolvedValue({ replaced: true }),
    insert: vi.fn().mockResolvedValue({ inserted: true }),
    appendFile: vi.fn().mockResolvedValue({ created: false }),
    getFileMeta: vi.fn().mockResolvedValue({
      version: 3,
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now(),
      minStoredVersion: 1,
      storedVersionCount: 3,
    }),
    getFileId: vi.fn().mockResolvedValue('file-id'),
    listVersions: vi.fn().mockResolvedValue([]),
    getVersion: vi.fn().mockResolvedValue(null),
    dropOldVersions: vi.fn().mockResolvedValue(0),
    listOrphans: vi.fn().mockResolvedValue([]),
    restoreOrphan: vi.fn().mockResolvedValue(undefined),
    purgeOrphan: vi.fn().mockResolvedValue(undefined),
    compactProject: vi.fn().mockResolvedValue({ freed: 0 }),
    ...overrides,
  } as VfsAdapter;
}

describe('VfsFileViewer', () => {
  let mockAdapter: VfsAdapter;

  const getDefaultProps = () => ({
    adapter: mockAdapter,
    path: '/docs/notes.txt',
    onEdit: vi.fn(),
    onDiff: vi.fn(),
    onDelete: vi.fn(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter = createMockAdapter();
  });

  describe('Loading State', () => {
    it('shows loading spinner while fetching file', async () => {
      vi.mocked(mockAdapter.readFileWithMeta).mockImplementation(() => new Promise(() => {}));

      render(<VfsFileViewer {...getDefaultProps()} />);

      // Filename should be visible in header even during loading
      expect(screen.getByText('notes.txt')).toBeInTheDocument();

      // Action buttons should be disabled
      expect(screen.getByTitle('Edit file')).toBeDisabled();
      expect(screen.getByTitle('Delete file')).toBeDisabled();
    });
  });

  describe('Content Display', () => {
    it('displays file content after loading', async () => {
      vi.mocked(mockAdapter.readFileWithMeta).mockResolvedValue({
        content: 'Hello, World!',
        isBinary: false,
        mime: 'text/plain',
      });

      render(<VfsFileViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('Hello, World!')).toBeInTheDocument();
      });
    });

    it('displays filename in header', async () => {
      render(<VfsFileViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('notes.txt')).toBeInTheDocument();
      });
    });

    it('displays version badge', async () => {
      vi.mocked(mockAdapter.getFileMeta).mockResolvedValue({
        version: 5,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        minStoredVersion: 1,
        storedVersionCount: 5,
      });

      render(<VfsFileViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('v5')).toBeInTheDocument();
      });
    });

    it('displays "(empty file)" for empty content', async () => {
      vi.mocked(mockAdapter.readFileWithMeta).mockResolvedValue({
        content: '',
        isBinary: false,
        mime: 'text/plain',
      });

      render(<VfsFileViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('(empty file)')).toBeInTheDocument();
      });
    });

    it('preserves whitespace in content', async () => {
      vi.mocked(mockAdapter.readFileWithMeta).mockResolvedValue({
        content: 'Line 1\n  Indented\n\nDouble newline',
        isBinary: false,
        mime: 'text/plain',
      });

      render(<VfsFileViewer {...getDefaultProps()} />);

      await waitFor(() => {
        const pre = screen.getByText(/Line 1/);
        expect(pre).toHaveClass('whitespace-pre-wrap');
      });
    });
  });

  describe('Action Buttons', () => {
    it('calls onEdit when Edit button clicked', async () => {
      const onEdit = vi.fn();

      render(<VfsFileViewer {...getDefaultProps()} onEdit={onEdit} />);

      await waitFor(() => {
        expect(screen.getByTitle('Edit file')).not.toBeDisabled();
      });

      fireEvent.click(screen.getByTitle('Edit file'));

      expect(onEdit).toHaveBeenCalled();
    });

    it('calls onDiff when Diff button clicked', async () => {
      const onDiff = vi.fn();
      vi.mocked(mockAdapter.getFileMeta).mockResolvedValue({
        version: 3,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        minStoredVersion: 1,
        storedVersionCount: 3,
      });

      render(<VfsFileViewer {...getDefaultProps()} onDiff={onDiff} />);

      await waitFor(() => {
        expect(screen.getByTitle('View diff')).not.toBeDisabled();
      });

      fireEvent.click(screen.getByTitle('View diff'));

      expect(onDiff).toHaveBeenCalled();
    });

    it('disables Diff button when version is 1', async () => {
      vi.mocked(mockAdapter.getFileMeta).mockResolvedValue({
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        minStoredVersion: 1,
        storedVersionCount: 1,
      });

      render(<VfsFileViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByTitle('Edit file')).not.toBeDisabled();
      });

      expect(screen.getByTitle('View diff')).toBeDisabled();
    });

    it('calls onDelete when Delete button clicked', async () => {
      const onDelete = vi.fn();

      render(<VfsFileViewer {...getDefaultProps()} onDelete={onDelete} />);

      await waitFor(() => {
        expect(screen.getByTitle('Delete file')).not.toBeDisabled();
      });

      fireEvent.click(screen.getByTitle('Delete file'));

      expect(onDelete).toHaveBeenCalled();
    });
  });

  describe('Close Button (Mobile)', () => {
    it('renders close button when onClose provided', async () => {
      const onClose = vi.fn();

      render(<VfsFileViewer {...getDefaultProps()} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByTitle('Close')).toBeInTheDocument();
      });
    });

    it('does not render close button when onClose not provided', async () => {
      render(<VfsFileViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByTitle('Edit file')).not.toBeDisabled();
      });

      expect(screen.queryByTitle('Close')).not.toBeInTheDocument();
    });

    it('calls onClose when Close button clicked', async () => {
      const onClose = vi.fn();

      render(<VfsFileViewer {...getDefaultProps()} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByTitle('Close')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle('Close'));

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('displays error message when load fails', async () => {
      vi.mocked(mockAdapter.readFileWithMeta).mockRejectedValue(new Error('File not found'));

      render(<VfsFileViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('File not found')).toBeInTheDocument();
      });
    });

    it('shows Retry button on error', async () => {
      vi.mocked(mockAdapter.readFileWithMeta).mockRejectedValue(new Error('Network error'));

      render(<VfsFileViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('Retry')).toBeInTheDocument();
      });
    });

    it('retries loading when Retry button clicked', async () => {
      vi.mocked(mockAdapter.readFileWithMeta)
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          content: 'Recovered content',
          isBinary: false,
          mime: 'text/plain',
        });

      render(<VfsFileViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('Retry')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Retry'));

      await waitFor(() => {
        expect(screen.getByText('Recovered content')).toBeInTheDocument();
      });

      expect(mockAdapter.readFileWithMeta).toHaveBeenCalledTimes(2);
    });

    it('disables action buttons on error', async () => {
      vi.mocked(mockAdapter.readFileWithMeta).mockRejectedValue(new Error('Error'));

      render(<VfsFileViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('Retry')).toBeInTheDocument();
      });

      expect(screen.getByTitle('Edit file')).toBeDisabled();
      expect(screen.getByTitle('Delete file')).toBeDisabled();
    });
  });

  describe('Path Handling', () => {
    it('extracts filename from path', async () => {
      render(<VfsFileViewer {...getDefaultProps()} path="/deep/nested/file.md" />);

      await waitFor(() => {
        expect(screen.getByText('file.md')).toBeInTheDocument();
      });
    });

    it('handles root-level files', async () => {
      render(<VfsFileViewer {...getDefaultProps()} path="/readme.txt" />);

      await waitFor(() => {
        expect(screen.getByText('readme.txt')).toBeInTheDocument();
      });
    });
  });

  describe('Reactivity', () => {
    it('reloads when path changes', async () => {
      vi.mocked(mockAdapter.readFileWithMeta)
        .mockResolvedValueOnce({
          content: 'First file',
          isBinary: false,
          mime: 'text/plain',
        })
        .mockResolvedValueOnce({
          content: 'Second file',
          isBinary: false,
          mime: 'text/plain',
        });

      const props = getDefaultProps();
      const { rerender } = render(<VfsFileViewer {...props} path="/file1.txt" />);

      await waitFor(() => {
        expect(screen.getByText('First file')).toBeInTheDocument();
      });

      rerender(<VfsFileViewer {...props} path="/file2.txt" />);

      await waitFor(() => {
        expect(screen.getByText('Second file')).toBeInTheDocument();
      });

      expect(mockAdapter.readFileWithMeta).toHaveBeenCalledTimes(2);
    });

    it('reloads when adapter changes', async () => {
      const adapterA = createMockAdapter({
        readFileWithMeta: vi.fn().mockResolvedValue({
          content: 'Adapter A file',
          isBinary: false,
          mime: 'text/plain',
        }),
      });
      const adapterB = createMockAdapter({
        readFileWithMeta: vi.fn().mockResolvedValue({
          content: 'Adapter B file',
          isBinary: false,
          mime: 'text/plain',
        }),
      });

      const props = getDefaultProps();
      const { rerender } = render(<VfsFileViewer {...props} adapter={adapterA} />);

      await waitFor(() => {
        expect(screen.getByText('Adapter A file')).toBeInTheDocument();
      });

      rerender(<VfsFileViewer {...props} adapter={adapterB} />);

      await waitFor(() => {
        expect(screen.getByText('Adapter B file')).toBeInTheDocument();
      });

      expect(adapterA.readFileWithMeta).toHaveBeenCalledTimes(1);
      expect(adapterB.readFileWithMeta).toHaveBeenCalledTimes(1);
    });
  });
});
