import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import VfsFileEditor from '../VfsFileEditor';

// Mock vfsService
const mockUpdateFile = vi.fn();

vi.mock('../../../services/vfs/vfsService', () => ({
  updateFile: (...args: unknown[]) => mockUpdateFile(...args),
  getBasename: (path: string) => {
    const lastSlash = path.lastIndexOf('/');
    return lastSlash === -1 ? path : path.slice(lastSlash + 1);
  },
}));

describe('VfsFileEditor', () => {
  const defaultProps = {
    projectId: 'proj_test_123',
    path: '/docs/notes.txt',
    initialContent: 'Initial file content',
    onSave: vi.fn(),
    onCancel: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    localStorage.clear();
    mockUpdateFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  describe('Rendering', () => {
    it('displays filename in header', () => {
      render(<VfsFileEditor {...defaultProps} />);

      expect(screen.getByText('notes.txt')).toBeInTheDocument();
      expect(screen.getByText('(editing)')).toBeInTheDocument();
    });

    it('displays initial content in textarea', () => {
      render(<VfsFileEditor {...defaultProps} />);

      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveValue('Initial file content');
    });

    it('displays Cancel and Save buttons', () => {
      render(<VfsFileEditor {...defaultProps} />);

      expect(screen.getByText('Cancel')).toBeInTheDocument();
      expect(screen.getByText('Save')).toBeInTheDocument();
    });

    it('extracts filename from nested path', () => {
      render(<VfsFileEditor {...defaultProps} path="/deep/nested/file.md" />);

      expect(screen.getByText('file.md')).toBeInTheDocument();
    });
  });

  describe('Content Editing', () => {
    it('updates textarea value on user input', () => {
      render(<VfsFileEditor {...defaultProps} />);

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'New content' } });

      expect(textarea).toHaveValue('New content');
    });

    it('preserves whitespace and newlines', () => {
      render(<VfsFileEditor {...defaultProps} initialContent="" />);

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'Line 1\n  Indented\n\nDouble newline' } });

      expect(textarea).toHaveValue('Line 1\n  Indented\n\nDouble newline');
    });
  });

  describe('Save Action', () => {
    it('calls updateFile with correct parameters on save', async () => {
      // Use real timers for async save tests
      vi.useRealTimers();

      render(<VfsFileEditor {...defaultProps} />);

      // Modify content
      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'Modified content' } });

      // Click save
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(mockUpdateFile).toHaveBeenCalledWith(
          'proj_test_123',
          '/docs/notes.txt',
          'Modified content'
        );
      });

      vi.useFakeTimers();
    });

    it('calls onSave callback after successful save', async () => {
      vi.useRealTimers();

      const onSave = vi.fn();
      render(<VfsFileEditor {...defaultProps} onSave={onSave} />);

      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(onSave).toHaveBeenCalled();
      });

      vi.useFakeTimers();
    });

    it('shows spinner while saving', () => {
      mockUpdateFile.mockImplementation(() => new Promise(() => {}));

      render(<VfsFileEditor {...defaultProps} />);

      fireEvent.click(screen.getByText('Save'));

      expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    });

    it('disables buttons while saving', () => {
      mockUpdateFile.mockImplementation(() => new Promise(() => {}));

      render(<VfsFileEditor {...defaultProps} />);

      fireEvent.click(screen.getByText('Save'));

      // Save button contains spinner + text, get button by role
      const saveButton = screen.getByRole('button', { name: /save/i });
      expect(saveButton).toBeDisabled();
      expect(screen.getByText('Cancel')).toBeDisabled();
    });

    it('disables textarea while saving', () => {
      mockUpdateFile.mockImplementation(() => new Promise(() => {}));

      render(<VfsFileEditor {...defaultProps} />);

      fireEvent.click(screen.getByText('Save'));

      expect(screen.getByRole('textbox')).toBeDisabled();
    });
  });

  describe('Error Handling', () => {
    it('displays error message when save fails', async () => {
      vi.useRealTimers();

      mockUpdateFile.mockRejectedValue(new Error('Permission denied'));

      render(<VfsFileEditor {...defaultProps} />);

      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(screen.getByText('Permission denied')).toBeInTheDocument();
      });

      vi.useFakeTimers();
    });

    it('re-enables buttons after save error', async () => {
      vi.useRealTimers();

      mockUpdateFile.mockRejectedValue(new Error('Error'));

      render(<VfsFileEditor {...defaultProps} />);

      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(screen.getByText('Save')).not.toBeDisabled();
        expect(screen.getByText('Cancel')).not.toBeDisabled();
      });

      vi.useFakeTimers();
    });

    it('clears error when save succeeds after previous error', async () => {
      vi.useRealTimers();

      mockUpdateFile.mockRejectedValueOnce(new Error('First error'));
      mockUpdateFile.mockResolvedValueOnce(undefined);

      render(<VfsFileEditor {...defaultProps} />);

      // First save fails
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(screen.getByText('First error')).toBeInTheDocument();
      });

      // Second save succeeds
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(screen.queryByText('First error')).not.toBeInTheDocument();
      });

      vi.useFakeTimers();
    });
  });

  describe('Cancel Action', () => {
    it('calls onCancel when Cancel button clicked', () => {
      const onCancel = vi.fn();
      render(<VfsFileEditor {...defaultProps} onCancel={onCancel} />);

      fireEvent.click(screen.getByText('Cancel'));

      expect(onCancel).toHaveBeenCalled();
    });

    it('does not call updateFile when cancelled', () => {
      render(<VfsFileEditor {...defaultProps} />);

      // Modify content
      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'Changed content' } });

      // Cancel
      fireEvent.click(screen.getByText('Cancel'));

      expect(mockUpdateFile).not.toHaveBeenCalled();
    });
  });

  describe('Draft Persistence', () => {
    it('saves draft to localStorage after debounce', () => {
      render(<VfsFileEditor {...defaultProps} />);

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'Draft content' } });

      // Advance past debounce
      act(() => {
        vi.advanceTimersByTime(600);
      });

      const draftKey = `draft_vfs-editor_proj_test_123_${encodeURIComponent('/docs/notes.txt')}`;
      const stored = localStorage.getItem(draftKey);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!).content).toBe('Draft content');
    });

    it('restores draft on mount', () => {
      const draftKey = `draft_vfs-editor_proj_test_123_${encodeURIComponent('/docs/notes.txt')}`;
      const draftData = { content: 'Restored draft', createdAt: Date.now() };
      localStorage.setItem(draftKey, JSON.stringify(draftData));

      render(<VfsFileEditor {...defaultProps} />);

      expect(screen.getByRole('textbox')).toHaveValue('Restored draft');
    });

    it('shows draft warning when restored draft differs from initial', () => {
      const draftKey = `draft_vfs-editor_proj_test_123_${encodeURIComponent('/docs/notes.txt')}`;
      const draftData = { content: 'Different draft', createdAt: Date.now() };
      localStorage.setItem(draftKey, JSON.stringify(draftData));

      render(<VfsFileEditor {...defaultProps} initialContent="Original content" />);

      expect(
        screen.getByText('Unsaved draft restored. Changes differ from saved version.')
      ).toBeInTheDocument();
    });

    it('does not show draft warning when draft matches initial', () => {
      const draftKey = `draft_vfs-editor_proj_test_123_${encodeURIComponent('/docs/notes.txt')}`;
      const draftData = { content: 'Same content', createdAt: Date.now() };
      localStorage.setItem(draftKey, JSON.stringify(draftData));

      render(<VfsFileEditor {...defaultProps} initialContent="Same content" />);

      expect(
        screen.queryByText('Unsaved draft restored. Changes differ from saved version.')
      ).not.toBeInTheDocument();
    });

    it('clears draft on successful save', async () => {
      vi.useRealTimers();

      // Pre-populate a draft
      const draftKey = `draft_vfs-editor_proj_test_123_${encodeURIComponent('/docs/notes.txt')}`;
      const draftData = { content: 'Draft to clear on save', createdAt: Date.now() };
      localStorage.setItem(draftKey, JSON.stringify(draftData));

      render(<VfsFileEditor {...defaultProps} />);

      // Click save
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(localStorage.getItem(draftKey)).toBeNull();
      });

      vi.useFakeTimers();
    });

    it('clears draft on cancel', () => {
      const draftKey = `draft_vfs-editor_proj_test_123_${encodeURIComponent('/docs/notes.txt')}`;
      const draftData = { content: 'Draft to clear', createdAt: Date.now() };
      localStorage.setItem(draftKey, JSON.stringify(draftData));

      render(<VfsFileEditor {...defaultProps} />);

      fireEvent.click(screen.getByText('Cancel'));

      expect(localStorage.getItem(draftKey)).toBeNull();
    });

    it('uses encoded path in draft key to handle slashes', () => {
      render(<VfsFileEditor {...defaultProps} path="/deep/nested/path.txt" />);

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'test' } });

      act(() => {
        vi.advanceTimersByTime(600);
      });

      // Path should be URL-encoded in the key
      const expectedKey = `draft_vfs-editor_proj_test_123_${encodeURIComponent('/deep/nested/path.txt')}`;
      expect(localStorage.getItem(expectedKey)).not.toBeNull();
    });
  });
});