import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import VfsDiffViewer from '../VfsDiffViewer';

// Mock vfsService
const mockGetFileId = vi.fn();
const mockGetFileMeta = vi.fn();
const mockGetVersion = vi.fn();
const mockUpdateFile = vi.fn();

vi.mock('../../../services/vfs/vfsService', () => ({
  getFileId: (...args: unknown[]) => mockGetFileId(...args),
  getFileMeta: (...args: unknown[]) => mockGetFileMeta(...args),
  getVersion: (...args: unknown[]) => mockGetVersion(...args),
  updateFile: (...args: unknown[]) => mockUpdateFile(...args),
  getBasename: (path: string) => {
    const lastSlash = path.lastIndexOf('/');
    return lastSlash === -1 ? path : path.slice(lastSlash + 1);
  },
}));

describe('VfsDiffViewer', () => {
  const defaultProps = {
    projectId: 'proj_test_123',
    path: '/docs/notes.txt',
    onRollback: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFileId.mockResolvedValue('file_abc123');
    mockGetFileMeta.mockResolvedValue({
      version: 3,
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now(),
      minStoredVersion: 1,
      storedVersionCount: 3,
    });
    mockGetVersion.mockImplementation(async (_proj, _fileId, version) => {
      if (version === 1) return 'Content v1';
      if (version === 2) return 'Content v2\nLine 2';
      if (version === 3) return 'Content v3\nLine 2\nNew line';
      return `Content v${version}`;
    });
    mockUpdateFile.mockResolvedValue(undefined);
  });

  describe('Loading State', () => {
    it('shows loading spinner while fetching versions', async () => {
      mockGetFileId.mockImplementation(() => new Promise(() => {}));

      render(<VfsDiffViewer {...defaultProps} />);

      expect(screen.getByText('notes.txt')).toBeInTheDocument();
      expect(screen.getByText('(version history)')).toBeInTheDocument();
    });
  });

  describe('Error Handling', () => {
    it('displays error when file not found', async () => {
      mockGetFileId.mockResolvedValue(null);

      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('File not found')).toBeInTheDocument();
      });
    });

    it('displays error when no version history', async () => {
      mockGetFileMeta.mockResolvedValue({
        version: 1,
        minStoredVersion: 1,
        storedVersionCount: 1,
      });

      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('No version history available')).toBeInTheDocument();
      });
    });

    it('shows Retry button on error', async () => {
      mockGetFileId.mockRejectedValue(new Error('Network error'));

      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Retry')).toBeInTheDocument();
      });
    });

    it('retries loading when Retry clicked', async () => {
      mockGetFileId.mockRejectedValueOnce(new Error('Network error'));
      mockGetFileId.mockResolvedValueOnce('file_abc123');

      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Retry')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Retry'));

      await waitFor(() => {
        expect(mockGetFileId).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Version Display', () => {
    it('displays filename in header', async () => {
      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('notes.txt')).toBeInTheDocument();
      });
    });

    it('displays current version at start', async () => {
      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        // Should show v3 (current version) with "current" badge
        expect(screen.getByText('v3')).toBeInTheDocument();
        expect(screen.getByText('current')).toBeInTheDocument();
      });
    });

    it('shows "Changes in:" label for non-first versions', async () => {
      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Changes in:')).toBeInTheDocument();
      });
    });

    it('shows diff statistics', async () => {
      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/\+\d+/)).toBeInTheDocument(); // +N additions
        expect(screen.getByText(/-\d+/)).toBeInTheDocument(); // -N removals
        expect(screen.getByText(/unchanged/)).toBeInTheDocument();
      });
    });
  });

  describe('Diff Display', () => {
    it('displays diff lines with correct styling', async () => {
      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        // At v3, should show v2→v3 diff
        expect(screen.getByText('Content v2')).toBeInTheDocument();
      });
    });

    it('shows "No differences" for identical content', async () => {
      mockGetVersion.mockResolvedValue('Same content');

      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('No differences')).toBeInTheDocument();
      });
    });
  });

  describe('Version Navigation', () => {
    it('renders single set of navigation buttons', async () => {
      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        // Single version navigation (not two selectors)
        const prevButtons = screen.getAllByTitle('Previous version');
        const nextButtons = screen.getAllByTitle('Next version');
        expect(prevButtons).toHaveLength(1);
        expect(nextButtons).toHaveLength(1);
      });
    });

    it('loads previous version content when navigating back', async () => {
      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      // Click prev to go from v3 to v2
      fireEvent.click(screen.getByTitle('Previous version'));

      await waitFor(() => {
        expect(screen.getByText('v2')).toBeInTheDocument();
        // Should have loaded v1 and v2 content
        expect(mockGetVersion).toHaveBeenCalledWith('proj_test_123', 'file_abc123', 2);
        expect(mockGetVersion).toHaveBeenCalledWith('proj_test_123', 'file_abc123', 1);
      });
    });

    it('disables next button at current version', async () => {
      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      // At current version (v3), next should be disabled
      expect(screen.getByTitle('Next version')).toBeDisabled();
    });

    it('disables prev button at v1', async () => {
      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      // Navigate to v1
      fireEvent.click(screen.getByTitle('Previous version'));
      await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());

      fireEvent.click(screen.getByTitle('Previous version'));
      await waitFor(() => {
        expect(screen.getByText('v1')).toBeInTheDocument();
        expect(screen.getByTitle('Previous version')).toBeDisabled();
      });
    });

    it('shows "Created:" label at v1', async () => {
      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      // Navigate to v1
      fireEvent.click(screen.getByTitle('Previous version'));
      await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());

      fireEvent.click(screen.getByTitle('Previous version'));
      await waitFor(() => {
        expect(screen.getByText('Created:')).toBeInTheDocument();
      });
    });

    it('can navigate forward from older versions', async () => {
      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      // Go back to v2
      fireEvent.click(screen.getByTitle('Previous version'));
      await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());

      // Go forward to v3
      fireEvent.click(screen.getByTitle('Next version'));
      await waitFor(() => expect(screen.getByText('v3')).toBeInTheDocument());
    });
  });

  describe('Rollback Action', () => {
    it('disables rollback at current version', async () => {
      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      // At current version, rollback should be disabled
      expect(screen.getByText(/Rollback to v3/)).toBeDisabled();
    });

    it('enables rollback at older versions', async () => {
      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      // Navigate to v2
      fireEvent.click(screen.getByTitle('Previous version'));

      await waitFor(() => {
        expect(screen.getByText(/Rollback to v2/)).not.toBeDisabled();
      });
    });

    it('calls updateFile with viewing version content on rollback', async () => {
      const onRollback = vi.fn();
      render(<VfsDiffViewer {...defaultProps} onRollback={onRollback} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      // Navigate to v2
      fireEvent.click(screen.getByTitle('Previous version'));

      await waitFor(() => {
        expect(screen.getByText(/Rollback to v2/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText(/Rollback to v2/));

      await waitFor(() => {
        // Should update file with v2 content (the viewing version)
        expect(mockUpdateFile).toHaveBeenCalledWith(
          'proj_test_123',
          '/docs/notes.txt',
          'Content v2\nLine 2'
        );
        expect(onRollback).toHaveBeenCalled();
      });
    });

    it('shows "Rolling back..." while in progress', async () => {
      mockUpdateFile.mockImplementation(() => new Promise(() => {}));

      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      // Navigate to v2
      fireEvent.click(screen.getByTitle('Previous version'));

      await waitFor(() => {
        expect(screen.getByText(/Rollback to v2/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText(/Rollback to v2/));

      await waitFor(() => {
        expect(screen.getByText('Rolling back...')).toBeInTheDocument();
      });
    });

    it('displays error when rollback fails', async () => {
      mockUpdateFile.mockRejectedValue(new Error('Permission denied'));

      render(<VfsDiffViewer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      // Navigate to v2
      fireEvent.click(screen.getByTitle('Previous version'));

      await waitFor(() => {
        expect(screen.getByText(/Rollback to v2/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText(/Rollback to v2/));

      await waitFor(() => {
        expect(screen.getByText('Permission denied')).toBeInTheDocument();
      });
    });
  });

  describe('Close Action', () => {
    it('calls onClose when Close button clicked', async () => {
      const onClose = vi.fn();
      render(<VfsDiffViewer {...defaultProps} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText('Close')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Close'));

      expect(onClose).toHaveBeenCalled();
    });

    it('calls onClose when header close button clicked', async () => {
      const onClose = vi.fn();
      render(<VfsDiffViewer {...defaultProps} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByTitle('Close')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle('Close'));

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('Path Handling', () => {
    it('extracts filename from nested path', async () => {
      render(<VfsDiffViewer {...defaultProps} path="/deep/nested/file.md" />);

      await waitFor(() => {
        expect(screen.getByText('file.md')).toBeInTheDocument();
      });
    });
  });
});
