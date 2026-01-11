import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import VfsFileViewer from '../VfsFileViewer';

// Mock vfsService
const mockReadFileWithMeta = vi.fn();
const mockGetFileMeta = vi.fn();

vi.mock('../../../services/vfs/vfsService', () => ({
  readFileWithMeta: (...args: unknown[]) => mockReadFileWithMeta(...args),
  getFileMeta: (...args: unknown[]) => mockGetFileMeta(...args),
  getBasename: (path: string) => {
    const lastSlash = path.lastIndexOf('/');
    return lastSlash === -1 ? path : path.slice(lastSlash + 1);
  },
}));

describe('VfsFileViewer', () => {
  const defaultProps = {
    projectId: 'proj_test_123',
    path: '/docs/notes.txt',
    onEdit: vi.fn(),
    onDiff: vi.fn(),
    onDelete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFileWithMeta.mockResolvedValue({
      content: 'File content here',
      isBinary: false,
      mime: 'text/plain',
    });
    mockGetFileMeta.mockResolvedValue({
      version: 3,
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now(),
    });
  });

  describe('Loading State', () => {
    it('shows loading spinner while fetching file', async () => {
      mockReadFileWithMeta.mockImplementation(() => new Promise(() => {}));

      render(<VfsFileViewer {...defaultProps} />);

      // Filename should be visible in header even during loading
      expect(screen.getByText('notes.txt')).toBeInTheDocument();

      // Action buttons should be disabled
      expect(screen.getByTitle('Edit file')).toBeDisabled();
      expect(screen.getByTitle('Delete file')).toBeDisabled();
    });
  });

  describe('Content Display', () => {
    it('displays file content after loading', async () => {
      mockReadFileWithMeta.mockResolvedValue({
        content: 'Hello, World!',
        isBinary: false,
        mime: 'text/plain',
      });

      render(<VfsFileViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Hello, World!')).toBeInTheDocument();
      });
    });

    it('displays filename in header', async () => {
      render(<VfsFileViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('notes.txt')).toBeInTheDocument();
      });
    });

    it('displays version badge', async () => {
      mockGetFileMeta.mockResolvedValue({ version: 5 });

      render(<VfsFileViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('v5')).toBeInTheDocument();
      });
    });

    it('displays "(empty file)" for empty content', async () => {
      mockReadFileWithMeta.mockResolvedValue({ content: '', isBinary: false, mime: 'text/plain' });

      render(<VfsFileViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('(empty file)')).toBeInTheDocument();
      });
    });

    it('preserves whitespace in content', async () => {
      mockReadFileWithMeta.mockResolvedValue({
        content: 'Line 1\n  Indented\n\nDouble newline',
        isBinary: false,
        mime: 'text/plain',
      });

      render(<VfsFileViewer {...defaultProps} />);

      await waitFor(() => {
        const pre = screen.getByText(/Line 1/);
        expect(pre).toHaveClass('whitespace-pre-wrap');
      });
    });
  });

  describe('Action Buttons', () => {
    it('calls onEdit when Edit button clicked', async () => {
      const onEdit = vi.fn();

      render(<VfsFileViewer {...defaultProps} onEdit={onEdit} />);

      await waitFor(() => {
        expect(screen.getByTitle('Edit file')).not.toBeDisabled();
      });

      fireEvent.click(screen.getByTitle('Edit file'));

      expect(onEdit).toHaveBeenCalled();
    });

    it('calls onDiff when Diff button clicked', async () => {
      const onDiff = vi.fn();
      mockGetFileMeta.mockResolvedValue({ version: 3 });

      render(<VfsFileViewer {...defaultProps} onDiff={onDiff} />);

      await waitFor(() => {
        expect(screen.getByTitle('View diff')).not.toBeDisabled();
      });

      fireEvent.click(screen.getByTitle('View diff'));

      expect(onDiff).toHaveBeenCalled();
    });

    it('disables Diff button when version is 1', async () => {
      mockGetFileMeta.mockResolvedValue({ version: 1 });

      render(<VfsFileViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTitle('Edit file')).not.toBeDisabled();
      });

      expect(screen.getByTitle('View diff')).toBeDisabled();
    });

    it('calls onDelete when Delete button clicked', async () => {
      const onDelete = vi.fn();

      render(<VfsFileViewer {...defaultProps} onDelete={onDelete} />);

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

      render(<VfsFileViewer {...defaultProps} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByTitle('Close')).toBeInTheDocument();
      });
    });

    it('does not render close button when onClose not provided', async () => {
      render(<VfsFileViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTitle('Edit file')).not.toBeDisabled();
      });

      expect(screen.queryByTitle('Close')).not.toBeInTheDocument();
    });

    it('calls onClose when Close button clicked', async () => {
      const onClose = vi.fn();

      render(<VfsFileViewer {...defaultProps} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByTitle('Close')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle('Close'));

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('displays error message when load fails', async () => {
      mockReadFileWithMeta.mockRejectedValue(new Error('File not found'));

      render(<VfsFileViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('File not found')).toBeInTheDocument();
      });
    });

    it('shows Retry button on error', async () => {
      mockReadFileWithMeta.mockRejectedValue(new Error('Network error'));

      render(<VfsFileViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Retry')).toBeInTheDocument();
      });
    });

    it('retries loading when Retry button clicked', async () => {
      mockReadFileWithMeta.mockRejectedValueOnce(new Error('Network error'));
      mockReadFileWithMeta.mockResolvedValueOnce({
        content: 'Recovered content',
        isBinary: false,
        mime: 'text/plain',
      });

      render(<VfsFileViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Retry')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Retry'));

      await waitFor(() => {
        expect(screen.getByText('Recovered content')).toBeInTheDocument();
      });

      expect(mockReadFileWithMeta).toHaveBeenCalledTimes(2);
    });

    it('disables action buttons on error', async () => {
      mockReadFileWithMeta.mockRejectedValue(new Error('Error'));

      render(<VfsFileViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Retry')).toBeInTheDocument();
      });

      expect(screen.getByTitle('Edit file')).toBeDisabled();
      expect(screen.getByTitle('Delete file')).toBeDisabled();
    });
  });

  describe('Path Handling', () => {
    it('extracts filename from path', async () => {
      render(<VfsFileViewer {...defaultProps} path="/deep/nested/file.md" />);

      await waitFor(() => {
        expect(screen.getByText('file.md')).toBeInTheDocument();
      });
    });

    it('handles root-level files', async () => {
      render(<VfsFileViewer {...defaultProps} path="/readme.txt" />);

      await waitFor(() => {
        expect(screen.getByText('readme.txt')).toBeInTheDocument();
      });
    });
  });

  describe('Reactivity', () => {
    it('reloads when path changes', async () => {
      mockReadFileWithMeta.mockResolvedValueOnce({
        content: 'First file',
        isBinary: false,
        mime: 'text/plain',
      });
      mockReadFileWithMeta.mockResolvedValueOnce({
        content: 'Second file',
        isBinary: false,
        mime: 'text/plain',
      });

      const { rerender } = render(<VfsFileViewer {...defaultProps} path="/file1.txt" />);

      await waitFor(() => {
        expect(screen.getByText('First file')).toBeInTheDocument();
      });

      rerender(<VfsFileViewer {...defaultProps} path="/file2.txt" />);

      await waitFor(() => {
        expect(screen.getByText('Second file')).toBeInTheDocument();
      });

      expect(mockReadFileWithMeta).toHaveBeenCalledTimes(2);
    });

    it('reloads when projectId changes', async () => {
      mockReadFileWithMeta.mockResolvedValueOnce({
        content: 'Project A file',
        isBinary: false,
        mime: 'text/plain',
      });
      mockReadFileWithMeta.mockResolvedValueOnce({
        content: 'Project B file',
        isBinary: false,
        mime: 'text/plain',
      });

      const { rerender } = render(<VfsFileViewer {...defaultProps} projectId="proj_a" />);

      await waitFor(() => {
        expect(screen.getByText('Project A file')).toBeInTheDocument();
      });

      rerender(<VfsFileViewer {...defaultProps} projectId="proj_b" />);

      await waitFor(() => {
        expect(screen.getByText('Project B file')).toBeInTheDocument();
      });

      expect(mockReadFileWithMeta).toHaveBeenCalledTimes(2);
    });
  });
});
