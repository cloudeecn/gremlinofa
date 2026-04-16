import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import VfsDirectoryTree from '../VfsDirectoryTree';
import type { DirEntry, VfsAdapter } from '../../../../shared/protocol/types/vfs';

// Mock adapter passed as prop — only readDir and isDirectory are used by the component
const mockAdapter = {
  readDir: vi.fn<VfsAdapter['readDir']>().mockResolvedValue([]),
  isDirectory: vi.fn<VfsAdapter['isDirectory']>().mockResolvedValue(false),
};

// Helper to create DirEntry
function createDirEntry(overrides: Partial<DirEntry> = {}): DirEntry {
  return {
    name: 'test',
    type: 'file',
    deleted: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('VfsDirectoryTree', () => {
  const defaultProps = {
    adapter: mockAdapter as unknown as VfsAdapter,
    selectedPath: null,
    onSelectFile: vi.fn(),
    onSelectDir: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.readDir.mockResolvedValue([]);
    mockAdapter.isDirectory.mockResolvedValue(false);
  });

  describe('Initial Rendering', () => {
    it('shows loading spinner while loading root', async () => {
      // Don't resolve immediately to see loading state
      mockAdapter.readDir.mockImplementation(() => new Promise(() => {}));

      render(<VfsDirectoryTree {...defaultProps} />);

      // Loading spinner should be visible
      expect(screen.getByText('Memory Files')).toBeInTheDocument();
    });

    it('shows "No files yet" when root is empty', async () => {
      mockAdapter.readDir.mockResolvedValue([]);

      render(<VfsDirectoryTree {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('No files yet')).toBeInTheDocument();
      });
    });

    it('renders files and directories from root', async () => {
      mockAdapter.readDir.mockResolvedValue([
        createDirEntry({ name: 'docs', type: 'dir' }),
        createDirEntry({ name: 'notes.txt', type: 'file', size: 1024 }),
      ]);

      render(<VfsDirectoryTree {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('docs')).toBeInTheDocument();
        expect(screen.getByText('notes.txt')).toBeInTheDocument();
      });
    });

    it('displays file size for files', async () => {
      mockAdapter.readDir.mockResolvedValue([
        createDirEntry({ name: 'small.txt', type: 'file', size: 512 }),
        createDirEntry({ name: 'medium.txt', type: 'file', size: 2048 }),
      ]);

      render(<VfsDirectoryTree {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('512B')).toBeInTheDocument();
        expect(screen.getByText('2.0KB')).toBeInTheDocument();
      });
    });

    it('shows correct icons for files and directories', async () => {
      mockAdapter.readDir.mockResolvedValue([
        createDirEntry({ name: 'folder', type: 'dir' }),
        createDirEntry({ name: 'file.txt', type: 'file' }),
      ]);

      render(<VfsDirectoryTree {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('📁')).toBeInTheDocument();
        expect(screen.getByText('📄')).toBeInTheDocument();
      });
    });
  });

  describe('Selection', () => {
    it('calls onSelectFile when clicking a file', async () => {
      const onSelectFile = vi.fn();
      mockAdapter.readDir.mockResolvedValue([createDirEntry({ name: 'notes.txt', type: 'file' })]);

      render(<VfsDirectoryTree {...defaultProps} onSelectFile={onSelectFile} />);

      await waitFor(() => {
        expect(screen.getByText('notes.txt')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('notes.txt'));

      expect(onSelectFile).toHaveBeenCalledWith('/notes.txt');
    });

    it('calls onSelectDir when clicking a directory', async () => {
      const onSelectDir = vi.fn();
      mockAdapter.readDir.mockResolvedValue([createDirEntry({ name: 'docs', type: 'dir' })]);

      render(<VfsDirectoryTree {...defaultProps} onSelectDir={onSelectDir} />);

      await waitFor(() => {
        expect(screen.getByText('docs')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('docs'));

      expect(onSelectDir).toHaveBeenCalledWith('/docs');
    });

    it('highlights selected path', async () => {
      mockAdapter.readDir.mockResolvedValue([
        createDirEntry({ name: 'selected.txt', type: 'file' }),
        createDirEntry({ name: 'other.txt', type: 'file' }),
      ]);

      render(<VfsDirectoryTree {...defaultProps} selectedPath="/selected.txt" />);

      await waitFor(() => {
        expect(screen.getByText('selected.txt')).toBeInTheDocument();
      });

      const selectedButton = screen.getByText('selected.txt').closest('button');
      expect(selectedButton).toHaveClass('bg-blue-100');
    });
  });

  describe('Expand/Collapse', () => {
    it('expands directory on click and loads children', async () => {
      // First call returns root with a directory
      mockAdapter.readDir.mockResolvedValueOnce([createDirEntry({ name: 'docs', type: 'dir' })]);
      // Second call returns children of /docs
      mockAdapter.readDir.mockResolvedValueOnce([
        createDirEntry({ name: 'readme.md', type: 'file' }),
      ]);

      render(<VfsDirectoryTree {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('docs')).toBeInTheDocument();
      });

      // Click to expand
      fireEvent.click(screen.getByText('docs'));

      await waitFor(() => {
        expect(screen.getByText('readme.md')).toBeInTheDocument();
      });

      expect(mockAdapter.readDir).toHaveBeenCalledWith('/docs');
    });

    it('shows "(empty)" for empty directories', async () => {
      mockAdapter.readDir.mockResolvedValueOnce([
        createDirEntry({ name: 'empty-folder', type: 'dir' }),
      ]);
      mockAdapter.readDir.mockResolvedValueOnce([]);

      render(<VfsDirectoryTree {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('empty-folder')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('empty-folder'));

      await waitFor(() => {
        expect(screen.getByText('(empty)')).toBeInTheDocument();
      });
    });

    it('collapses expanded directory on second click', async () => {
      mockAdapter.readDir.mockResolvedValueOnce([createDirEntry({ name: 'docs', type: 'dir' })]);
      mockAdapter.readDir.mockResolvedValueOnce([
        createDirEntry({ name: 'readme.md', type: 'file' }),
      ]);

      render(<VfsDirectoryTree {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('docs')).toBeInTheDocument();
      });

      // Expand
      fireEvent.click(screen.getByText('docs'));

      await waitFor(() => {
        expect(screen.getByText('readme.md')).toBeInTheDocument();
      });

      // Collapse
      fireEvent.click(screen.getByText('docs'));

      await waitFor(() => {
        expect(screen.queryByText('readme.md')).not.toBeInTheDocument();
      });
    });

    it('handles nested directory expansion', async () => {
      mockAdapter.readDir.mockResolvedValueOnce([createDirEntry({ name: 'level1', type: 'dir' })]);
      mockAdapter.readDir.mockResolvedValueOnce([createDirEntry({ name: 'level2', type: 'dir' })]);
      mockAdapter.readDir.mockResolvedValueOnce([
        createDirEntry({ name: 'deep-file.txt', type: 'file' }),
      ]);

      render(<VfsDirectoryTree {...defaultProps} />);

      // Wait for root
      await waitFor(() => {
        expect(screen.getByText('level1')).toBeInTheDocument();
      });

      // Expand level1
      fireEvent.click(screen.getByText('level1'));
      await waitFor(() => {
        expect(screen.getByText('level2')).toBeInTheDocument();
      });

      // Expand level2
      fireEvent.click(screen.getByText('level2'));
      await waitFor(() => {
        expect(screen.getByText('deep-file.txt')).toBeInTheDocument();
      });
    });
  });

  describe('Error Handling', () => {
    it('shows empty state when directory load fails', async () => {
      mockAdapter.readDir.mockRejectedValue(new Error('Network error'));

      render(<VfsDirectoryTree {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('No files yet')).toBeInTheDocument();
      });
    });
  });

  describe('Root Node', () => {
    it('renders a clickable root "/" node', async () => {
      mockAdapter.readDir.mockResolvedValue([]);

      render(<VfsDirectoryTree {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('/')).toBeInTheDocument();
      });

      // Root should show the folder icon
      expect(screen.getByText('📂')).toBeInTheDocument();
    });

    it('calls onSelectDir with "/" when clicking root node', async () => {
      const onSelectDir = vi.fn();
      mockAdapter.readDir.mockResolvedValue([]);

      render(<VfsDirectoryTree {...defaultProps} onSelectDir={onSelectDir} />);

      await waitFor(() => {
        expect(screen.getByText('/')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('/'));

      expect(onSelectDir).toHaveBeenCalledWith('/');
    });

    it('highlights root when selectedPath is "/"', async () => {
      mockAdapter.readDir.mockResolvedValue([]);

      render(<VfsDirectoryTree {...defaultProps} selectedPath="/" />);

      await waitFor(() => {
        expect(screen.getByText('/')).toBeInTheDocument();
      });

      const rootButton = screen.getByText('/').closest('button');
      expect(rootButton).toHaveClass('bg-blue-100');
    });
  });

  describe('Path Construction', () => {
    it('constructs correct paths for nested files', async () => {
      const onSelectFile = vi.fn();
      mockAdapter.readDir.mockResolvedValueOnce([createDirEntry({ name: 'docs', type: 'dir' })]);
      mockAdapter.readDir.mockResolvedValueOnce([createDirEntry({ name: 'notes', type: 'dir' })]);
      mockAdapter.readDir.mockResolvedValueOnce([
        createDirEntry({ name: 'file.txt', type: 'file' }),
      ]);

      render(<VfsDirectoryTree {...defaultProps} onSelectFile={onSelectFile} />);

      await waitFor(() => expect(screen.getByText('docs')).toBeInTheDocument());
      fireEvent.click(screen.getByText('docs'));

      await waitFor(() => expect(screen.getByText('notes')).toBeInTheDocument());
      fireEvent.click(screen.getByText('notes'));

      await waitFor(() => expect(screen.getByText('file.txt')).toBeInTheDocument());
      fireEvent.click(screen.getByText('file.txt'));

      expect(onSelectFile).toHaveBeenCalledWith('/docs/notes/file.txt');
    });
  });
});
