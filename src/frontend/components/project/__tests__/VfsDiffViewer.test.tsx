import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import VfsDiffViewer from '../VfsDiffViewer';
import type { VfsAdapter } from '../../../../shared/protocol/types/vfs';

function createMockAdapter(overrides: Partial<VfsAdapter> = {}): VfsAdapter {
  return {
    getFileId: vi.fn().mockResolvedValue('file_abc123'),
    getFileMeta: vi.fn().mockResolvedValue({
      version: 3,
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now(),
      minStoredVersion: 1,
      storedVersionCount: 3,
    }),
    getVersion: vi.fn().mockImplementation(async (_fileId: string, version: number) => {
      if (version === 1) return 'Content v1';
      if (version === 2) return 'Content v2\nLine 2';
      if (version === 3) return 'Content v3\nLine 2\nNew line';
      return `Content v${version}`;
    }),
    listVersions: vi.fn().mockResolvedValue([
      { version: 1, createdAt: 1700000000000 },
      { version: 2, createdAt: 1700100000000 },
      { version: 3, createdAt: 1700200000000 },
    ]),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readDir: vi.fn(),
    readFile: vi.fn(),
    readFileWithMeta: vi.fn(),
    createFile: vi.fn(),
    deleteFile: vi.fn(),
    mkdir: vi.fn(),
    rmdir: vi.fn(),
    rename: vi.fn(),
    exists: vi.fn(),
    isFile: vi.fn(),
    isDirectory: vi.fn(),
    stat: vi.fn(),
    hasVfs: vi.fn(),
    ...overrides,
  } as VfsAdapter;
}

describe('VfsDiffViewer', () => {
  let mockAdapter: VfsAdapter;

  const getDefaultProps = () => ({
    adapter: mockAdapter,
    path: '/docs/notes.txt',
    onRollback: vi.fn(),
    onClose: vi.fn(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter = createMockAdapter();
  });

  describe('Loading State', () => {
    it('shows loading spinner while fetching versions', async () => {
      mockAdapter = createMockAdapter({
        getFileId: vi.fn().mockImplementation(() => new Promise(() => {})),
      });

      render(<VfsDiffViewer {...getDefaultProps()} />);

      expect(screen.getByText('notes.txt')).toBeInTheDocument();
      expect(screen.getByText('(version history)')).toBeInTheDocument();
    });
  });

  describe('Error Handling', () => {
    it('displays error when file not found', async () => {
      mockAdapter = createMockAdapter({
        getFileId: vi.fn().mockResolvedValue(null),
      });

      render(<VfsDiffViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('File not found')).toBeInTheDocument();
      });
    });

    it('displays error when no version history', async () => {
      mockAdapter = createMockAdapter({
        getFileMeta: vi.fn().mockResolvedValue({
          version: 1,
          minStoredVersion: 1,
          storedVersionCount: 1,
        }),
      });

      render(<VfsDiffViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('No version history available')).toBeInTheDocument();
      });
    });

    it('shows Retry button on error', async () => {
      mockAdapter = createMockAdapter({
        getFileId: vi.fn().mockRejectedValue(new Error('Network error')),
      });

      render(<VfsDiffViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('Retry')).toBeInTheDocument();
      });
    });

    it('retries loading when Retry clicked', async () => {
      const mockGetFileId = vi
        .fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce('file_abc123');
      mockAdapter = createMockAdapter({ getFileId: mockGetFileId });

      render(<VfsDiffViewer {...getDefaultProps()} />);

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
      render(<VfsDiffViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('notes.txt')).toBeInTheDocument();
      });
    });

    it('displays current version at start', async () => {
      render(<VfsDiffViewer {...getDefaultProps()} />);

      await waitFor(() => {
        // Should show v3 (current version) with "current" badge
        expect(screen.getByText('v3')).toBeInTheDocument();
        expect(screen.getByText('current')).toBeInTheDocument();
      });
    });

    it('shows "Changes in:" label for non-first versions', async () => {
      render(<VfsDiffViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('Changes in:')).toBeInTheDocument();
      });
    });

    it('shows diff statistics', async () => {
      render(<VfsDiffViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText(/\+\d+/)).toBeInTheDocument(); // +N additions
        expect(screen.getByText(/-\d+/)).toBeInTheDocument(); // -N removals
        expect(screen.getByText(/unchanged/)).toBeInTheDocument();
      });
    });
  });

  describe('Diff Display', () => {
    it('displays diff lines with correct styling', async () => {
      render(<VfsDiffViewer {...getDefaultProps()} />);

      await waitFor(() => {
        // At v3, should show v2→v3 diff
        expect(screen.getByText('Content v2')).toBeInTheDocument();
      });
    });

    it('shows "No differences" for identical content', async () => {
      mockAdapter = createMockAdapter({
        getVersion: vi.fn().mockResolvedValue('Same content'),
      });

      render(<VfsDiffViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('No differences')).toBeInTheDocument();
      });
    });
  });

  describe('Version Navigation', () => {
    it('renders single set of navigation buttons', async () => {
      render(<VfsDiffViewer {...getDefaultProps()} />);

      await waitFor(() => {
        // Single version navigation (not two selectors)
        const prevButtons = screen.getAllByTitle('Previous version');
        const nextButtons = screen.getAllByTitle('Next version');
        expect(prevButtons).toHaveLength(1);
        expect(nextButtons).toHaveLength(1);
      });
    });

    it('loads previous version content when navigating back', async () => {
      render(<VfsDiffViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      // Click prev to go from v3 to v2
      fireEvent.click(screen.getByTitle('Previous version'));

      await waitFor(() => {
        expect(screen.getByText('v2')).toBeInTheDocument();
        // Should have loaded v1 and v2 content
        expect(mockAdapter.getVersion).toHaveBeenCalledWith('file_abc123', 2);
        expect(mockAdapter.getVersion).toHaveBeenCalledWith('file_abc123', 1);
      });
    });

    it('disables next button at current version', async () => {
      render(<VfsDiffViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      // At current version (v3), next should be disabled
      expect(screen.getByTitle('Next version')).toBeDisabled();
    });

    it('disables prev button at v1', async () => {
      render(<VfsDiffViewer {...getDefaultProps()} />);

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
      render(<VfsDiffViewer {...getDefaultProps()} />);

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
      render(<VfsDiffViewer {...getDefaultProps()} />);

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
      render(<VfsDiffViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      // At current version, rollback should be disabled
      expect(screen.getByText(/Rollback to v3/)).toBeDisabled();
    });

    it('enables rollback at older versions', async () => {
      render(<VfsDiffViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
      });

      // Navigate to v2
      fireEvent.click(screen.getByTitle('Previous version'));

      await waitFor(() => {
        expect(screen.getByText(/Rollback to v2/)).not.toBeDisabled();
      });
    });

    it('calls writeFile with viewing version content on rollback', async () => {
      const onRollback = vi.fn();
      render(<VfsDiffViewer {...getDefaultProps()} onRollback={onRollback} />);

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
        expect(mockAdapter.writeFile).toHaveBeenCalledWith('/docs/notes.txt', 'Content v2\nLine 2');
        expect(onRollback).toHaveBeenCalled();
      });
    });

    it('shows "Rolling back..." while in progress', async () => {
      mockAdapter = createMockAdapter({
        writeFile: vi.fn().mockImplementation(() => new Promise(() => {})),
      });

      render(<VfsDiffViewer {...getDefaultProps()} />);

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
      mockAdapter = createMockAdapter({
        writeFile: vi.fn().mockRejectedValue(new Error('Permission denied')),
      });

      render(<VfsDiffViewer {...getDefaultProps()} />);

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

  describe('Revision Date Display', () => {
    it('displays formatted date next to version number', async () => {
      render(<VfsDiffViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('v3')).toBeInTheDocument();
        // The date for v3 (timestamp 1700200000000) should appear
        const versionSpan = screen.getByText('v3').closest('span');
        expect(versionSpan?.textContent).toMatch(/v3.*·.*2023/);
      });
    });
  });

  describe('Context-Only Toggle', () => {
    it('renders the ±10 toggle button', async () => {
      render(<VfsDiffViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('±10')).toBeInTheDocument();
      });
    });

    it('toggles context-only mode when clicked', async () => {
      // Use content with many unchanged lines to make filtering visible
      mockAdapter = createMockAdapter({
        getVersion: vi.fn().mockImplementation(async (_fileId: string, version: number) => {
          if (version === 2) {
            const lines = [];
            for (let i = 0; i < 30; i++) lines.push(`line ${i}`);
            return lines.join('\n');
          }
          if (version === 3) {
            const lines = [];
            for (let i = 0; i < 30; i++) {
              lines.push(i === 15 ? 'CHANGED' : `line ${i}`);
            }
            return lines.join('\n');
          }
          return 'Content v1';
        }),
      });

      render(<VfsDiffViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('±10')).toBeInTheDocument();
        // Full diff shows line 0 (far from change at line 15)
        expect(screen.getByText('line 0')).toBeInTheDocument();
      });

      // Click the toggle
      fireEvent.click(screen.getByText('±10'));

      await waitFor(() => {
        // In context-only mode, line 0 should be hidden (>10 lines from change at 15)
        expect(screen.queryByText('line 0')).not.toBeInTheDocument();
        // But the changed line should still be visible
        expect(screen.getByText('CHANGED')).toBeInTheDocument();
      });
    });

    it('shows hunk separators in context-only mode', async () => {
      // Two changes far apart
      mockAdapter = createMockAdapter({
        getVersion: vi.fn().mockImplementation(async (_fileId: string, version: number) => {
          if (version === 2) {
            const lines = [];
            for (let i = 0; i < 50; i++) lines.push(`line ${i}`);
            return lines.join('\n');
          }
          if (version === 3) {
            const lines = [];
            for (let i = 0; i < 50; i++) {
              lines.push(i === 5 || i === 45 ? `CHANGED_${i}` : `line ${i}`);
            }
            return lines.join('\n');
          }
          return 'Content v1';
        }),
      });

      render(<VfsDiffViewer {...getDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText('±10')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('±10'));

      await waitFor(() => {
        // Should have separator between hunks
        const separators = screen.getAllByText('···');
        expect(separators.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('Close Action', () => {
    it('calls onClose when Close button clicked', async () => {
      const onClose = vi.fn();
      render(<VfsDiffViewer {...getDefaultProps()} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByText('Close')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Close'));

      expect(onClose).toHaveBeenCalled();
    });

    it('calls onClose when header close button clicked', async () => {
      const onClose = vi.fn();
      render(<VfsDiffViewer {...getDefaultProps()} onClose={onClose} />);

      await waitFor(() => {
        expect(screen.getByTitle('Close')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle('Close'));

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('Path Handling', () => {
    it('extracts filename from nested path', async () => {
      render(<VfsDiffViewer {...getDefaultProps()} path="/deep/nested/file.md" />);

      await waitFor(() => {
        expect(screen.getByText('file.md')).toBeInTheDocument();
      });
    });
  });
});
