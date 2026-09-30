import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import VfsManagerView from '../VfsManagerView';
import { gremlinClient } from '../../../client';
import type { VfsAdapter } from '../../../../shared/protocol/types/vfs';

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

// Phase 1.7 deleted `useVfsAdapter`; the facade is now built by
// `gremlinClient.getVfsAdapter(projectId)`. The mock here intercepts the
// client method so the component receives the same `mockAdapter`.
vi.mock('../../../client', () => ({
  gremlinClient: {
    getVfsAdapter: vi.fn(() => mockAdapter),
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

  describe('Deep Link', () => {
    const renderDeepLink = () => {
      const ui = () => (
        <MemoryRouter>
          <VfsManagerView {...defaultProps} initialPath="/notes.txt" />
        </MemoryRouter>
      );
      const view = render(ui());
      return { rerender: () => view.rerender(ui()) };
    };

    it('does not re-run when the viewport crosses the mobile breakpoint', async () => {
      mockIsMobile = true;
      mockAdapter.isFile.mockImplementation(async (path: string) => path === '/notes.txt');
      const { rerender } = renderDeepLink();

      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

      // Rotate to desktop, pick a directory, rotate back
      mockIsMobile = false;
      rerender();
      await waitFor(() => expect(screen.getByText('docs')).toBeInTheDocument());
      fireEvent.click(screen.getByText('docs'));
      await waitFor(() => expect(screen.getByText('🗑️ Delete Directory')).toBeInTheDocument());

      mockIsMobile = true;
      rerender();

      await waitFor(() => expect(screen.getByText('Selected:')).toBeInTheDocument());
      expect(screen.getByText('Selected:').parentElement).toHaveTextContent('Selected: docs');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(mockAdapter.isFile).toHaveBeenCalledTimes(1);
    });

    it('does not overwrite a selection made while the lookup is pending', async () => {
      mockIsMobile = false;
      let resolveIsFile!: (isFile: boolean) => void;
      mockAdapter.isFile.mockImplementation(
        () =>
          new Promise<boolean>(resolve => {
            resolveIsFile = resolve;
          })
      );
      renderDeepLink();

      await waitFor(() => expect(screen.getByText('docs')).toBeInTheDocument());
      fireEvent.click(screen.getByText('docs'));
      await waitFor(() => expect(screen.getByText('🗑️ Delete Directory')).toBeInTheDocument());

      await act(async () => {
        resolveIsFile(true);
      });

      expect(screen.getByText('🗑️ Delete Directory')).toBeInTheDocument();
      expect(mockAdapter.readFileWithMeta).not.toHaveBeenCalledWith('/notes.txt');
    });

    // App keys the route by project and path, so a project switch remounts the
    // view (App.test.tsx). These cover the component's own guard for an
    // `adapter` that changes under a mounted view: the `cancelled` flag and
    // the `desktopMode` reset.
    describe('project switch on the same path', () => {
      const otherAdapter = {
        ...mockAdapter,
        isFile: vi.fn(),
        isDirectory: vi.fn(),
      };

      // The fakes only cover what VfsManagerView calls
      const asVfsAdapter = (fake: typeof mockAdapter) => fake as unknown as VfsAdapter;

      beforeEach(() => {
        vi.mocked(gremlinClient.getVfsAdapter).mockImplementation(projectId =>
          asVfsAdapter(projectId === 'proj_other' ? otherAdapter : mockAdapter)
        );
      });

      afterEach(() => {
        vi.mocked(gremlinClient.getVfsAdapter).mockImplementation(() => asVfsAdapter(mockAdapter));
        vi.restoreAllMocks();
      });

      const renderProject = (projectId: string, initialPath: string) => {
        const ui = (id: string) => (
          <MemoryRouter>
            <VfsManagerView projectId={id} initialPath={initialPath} />
          </MemoryRouter>
        );
        const view = render(ui(projectId));
        return { switchTo: (id: string) => view.rerender(ui(id)) };
      };

      it("ignores the previous project's lookup once it resolves late", async () => {
        mockIsMobile = false;
        let resolveIsFile!: (isFile: boolean) => void;
        mockAdapter.isFile.mockImplementation(
          () =>
            new Promise<boolean>(resolve => {
              resolveIsFile = resolve;
            })
        );
        otherAdapter.isFile.mockResolvedValue(false);
        otherAdapter.isDirectory.mockResolvedValue(true);
        const { switchTo } = renderProject(defaultProps.projectId, '/shared');

        switchTo('proj_other');
        await waitFor(() => expect(screen.getByText('🗑️ Delete Directory')).toBeInTheDocument());

        await act(async () => {
          resolveIsFile(true);
        });

        expect(screen.getByText('🗑️ Delete Directory')).toBeInTheDocument();
        expect(mockAdapter.readFileWithMeta).not.toHaveBeenCalledWith('/shared');
      });

      it('does not open the deep-linked file in an editor holding another file', async () => {
        mockIsMobile = false;
        mockAdapter.readDir.mockResolvedValue([
          { name: 'notes.txt', type: 'file', size: 100 },
          { name: 'todo.txt', type: 'file', size: 50 },
        ]);
        mockAdapter.isFile.mockImplementation(async (path: string) => path === '/notes.txt');
        mockAdapter.readFile.mockResolvedValue('todo body');
        otherAdapter.isFile.mockResolvedValue(true);
        const { switchTo } = renderProject(defaultProps.projectId, '/notes.txt');

        await waitFor(() => expect(screen.getByText('todo.txt')).toBeInTheDocument());
        fireEvent.click(screen.getByText('todo.txt'));
        // The viewer disables Edit until its content has loaded
        await waitFor(() => expect(screen.getByTitle('Edit file')).toBeEnabled());
        fireEvent.click(screen.getByTitle('Edit file'));
        await waitFor(() => expect(document.querySelector('textarea')).toHaveValue('todo body'));

        await act(async () => {
          switchTo('proj_other');
        });

        await waitFor(() => expect(otherAdapter.isFile).toHaveBeenCalledWith('/notes.txt'));
        await waitFor(() => expect(document.querySelector('textarea')).toBeNull());
        expect(screen.getByTitle('Edit file')).toBeInTheDocument();
      });

      it('leaves edit mode when the deep link resolves to a directory', async () => {
        mockIsMobile = false;
        mockAdapter.readFile.mockResolvedValue('notes body');
        otherAdapter.isFile.mockResolvedValue(false);
        otherAdapter.isDirectory.mockResolvedValue(true);
        vi.spyOn(window, 'prompt').mockReturnValue('new.txt');
        const { switchTo } = renderProject(defaultProps.projectId, '/docs');

        await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());
        fireEvent.click(screen.getByText('notes.txt'));
        await waitFor(() => expect(screen.getByTitle('Edit file')).toBeEnabled());
        fireEvent.click(screen.getByTitle('Edit file'));
        await waitFor(() => expect(document.querySelector('textarea')).toHaveValue('notes body'));

        switchTo('proj_other');
        await waitFor(() => expect(screen.getByText('📄 New File')).toBeInTheDocument());

        // A file created from the directory panel must open in the viewer, not in an
        // editor still holding notes.txt's content
        fireEvent.click(screen.getByText('📄 New File'));
        await waitFor(() =>
          expect(otherAdapter.createFile).toHaveBeenCalledWith('/docs/new.txt', '')
        );
        await waitFor(() => expect(screen.getByTitle('Edit file')).toBeInTheDocument());
        expect(document.querySelector('textarea')).toBeNull();
      });
    });
  });

  describe('Desktop Edit', () => {
    it('does not open the editor for a file picked while the previous one was loading', async () => {
      mockIsMobile = false;
      mockAdapter.readDir.mockResolvedValue([
        { name: 'notes.txt', type: 'file', size: 100 },
        { name: 'todo.txt', type: 'file', size: 50 },
      ]);
      let resolveReadFile!: (content: string) => void;
      mockAdapter.readFile.mockImplementation(
        () =>
          new Promise<string>(resolve => {
            resolveReadFile = resolve;
          })
      );
      renderWithRouter(<VfsManagerView {...defaultProps} />);

      await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());
      fireEvent.click(screen.getByText('notes.txt'));
      // The viewer disables Edit until its content has loaded
      await waitFor(() => expect(screen.getByTitle('Edit file')).toBeEnabled());
      fireEvent.click(screen.getByTitle('Edit file'));

      fireEvent.click(screen.getByText('todo.txt'));
      await act(async () => {
        resolveReadFile('notes body');
      });

      expect(document.querySelector('textarea')).toBeNull();
      await waitFor(() => expect(screen.getByTitle('Edit file')).toBeInTheDocument());
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
