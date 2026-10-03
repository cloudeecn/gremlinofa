import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import VfsManagerView from '../VfsManagerView';
import { normalizePath } from '../../../lib/vfsPath';
import type { DirEntry } from '../../../../shared/protocol/types/vfs';

const entry = (name: string, type: 'file' | 'dir', size?: number): DirEntry => ({
  name,
  type,
  deleted: false,
  createdAt: 0,
  updatedAt: 1_700_000_000_000,
  size,
});

let listings: Record<string, DirEntry[]>;
let contents: Record<string, string>;

const mockAdapter = vi.hoisted(() => ({
  readDir: vi.fn(),
  readFileWithMeta: vi.fn(),
  getFileMeta: vi.fn(),
  createFile: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  rmdir: vi.fn(),
}));

vi.mock('../../../client', () => ({
  gremlinClient: { getVfsAdapter: vi.fn(() => mockAdapter) },
}));

let mockIsMobile = false;
vi.mock('../../../hooks/useIsMobile', () => ({ useIsMobile: () => mockIsMobile }));

const alerts = vi.hoisted(() => ({
  showAlert: vi.fn(),
  showConfirm: vi.fn(),
  showDestructiveConfirm: vi.fn(),
  showPrompt: vi.fn(),
}));
vi.mock('../../../hooks/useAlert', () => ({ useAlert: () => alerts }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

function Location() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

/** Mirrors App's route: the splat is the selection, keyed by project only */
function Route_() {
  const { projectId, '*': splat } = useParams();
  return (
    <VfsManagerView key={projectId} projectId={projectId!} path={normalizePath(splat ?? '')} />
  );
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/project/:projectId/vfs/*" element={<Route_ />} />
        <Route path="*" element={null} />
      </Routes>
      <Location />
    </MemoryRouter>
  );
}

const location = () => screen.getByTestId('location').textContent;
const treeRow = (name: string) =>
  within(screen.getByRole('tree')).getByRole('treeitem', { name: new RegExp(name) });

beforeEach(() => {
  vi.clearAllMocks();
  mockIsMobile = false;
  listings = {
    '/': [entry('docs', 'dir'), entry('notes.md', 'file', 12), entry('my notes #1.md', 'file', 3)],
    '/docs': [entry('guide.md', 'file', 5)],
  };
  contents = {
    '/notes.md': 'Note content',
    '/my notes #1.md': 'odd name',
    '/docs/guide.md': 'Guide content',
  };
  mockAdapter.readDir.mockImplementation(async (path: string) => {
    if (!listings[path]) throw new Error(`Path not found: ${path}`);
    return listings[path];
  });
  mockAdapter.readFileWithMeta.mockImplementation(async (path: string) => {
    if (!(path in contents)) throw new Error(`Path not found: ${path}`);
    return { content: contents[path], isBinary: false, mime: 'text/plain' };
  });
  mockAdapter.getFileMeta.mockResolvedValue({
    version: 3,
    createdAt: 0,
    updatedAt: 0,
    minStoredVersion: 1,
    storedVersionCount: 3,
  });
  for (const fn of [
    mockAdapter.createFile,
    mockAdapter.mkdir,
    mockAdapter.writeFile,
    mockAdapter.deleteFile,
    mockAdapter.rmdir,
  ]) {
    fn.mockResolvedValue(undefined);
  }
});

describe('VfsManagerView', () => {
  describe('URL follows the selection', () => {
    it('opens on the root folder and lists its contents, folders first', async () => {
      renderAt('/project/p1/vfs');
      expect(await screen.findByRole('heading', { name: 'Memory Files' })).toBeInTheDocument();
      const listing = await screen.findByRole('list', { name: 'Folder contents' });
      expect(
        within(listing)
          .getAllByRole('button')
          .map(b => b.textContent)
      ).toEqual([
        expect.stringContaining('docs'),
        expect.stringContaining('my notes #1.md'),
        expect.stringContaining('notes.md'),
      ]);
    });

    it('rewrites the URL when a file is picked in the tree', async () => {
      renderAt('/project/p1/vfs');
      fireEvent.click(await screen.findByRole('treeitem', { name: /notes\.md/ }));

      expect(location()).toBe('/project/p1/vfs/notes.md');
      expect(await screen.findByText('Note content')).toBeInTheDocument();
    });

    it('round-trips names with spaces, # and % through the URL', async () => {
      renderAt('/project/p1/vfs');
      fireEvent.click(await screen.findByRole('treeitem', { name: /my notes #1/ }));

      expect(location()).toBe('/project/p1/vfs/my%20notes%20%231.md');
      expect(await screen.findByText('odd name')).toBeInTheDocument();
      expect(treeRow('my notes #1')).toHaveAttribute('aria-selected', 'true');
    });

    it('opens a folder from the contents list and reveals it in the tree', async () => {
      renderAt('/project/p1/vfs');
      const listing = await screen.findByRole('list', { name: 'Folder contents' });
      fireEvent.click(within(listing).getByRole('button', { name: /docs/ }));

      expect(location()).toBe('/project/p1/vfs/docs');
      expect(await screen.findByRole('treeitem', { name: /guide\.md/ })).toBeInTheDocument();
      expect(treeRow('docs')).toHaveAttribute('aria-selected', 'true');
    });
  });

  describe('deep links', () => {
    it('opens a nested file with its folders expanded', async () => {
      renderAt('/project/p1/vfs/docs/guide.md');
      expect(await screen.findByText('Guide content')).toBeInTheDocument();
      expect(await screen.findByRole('treeitem', { name: /guide\.md/ })).toHaveAttribute(
        'aria-selected',
        'true'
      );
    });

    it('reads a trailing slash as the folder itself', async () => {
      renderAt('/project/p1/vfs/docs/');
      await screen.findByRole('list', { name: 'Folder contents' });
      expect(await screen.findByRole('treeitem', { name: /docs/ })).toHaveAttribute(
        'aria-selected',
        'true'
      );
    });

    it('opens a folder', async () => {
      renderAt('/project/p1/vfs/docs');
      const listing = await screen.findByRole('list', { name: 'Folder contents' });
      expect(within(listing).getByRole('button', { name: /guide\.md/ })).toBeInTheDocument();
    });

    it('explains a path that does not exist and offers its parent', async () => {
      renderAt('/project/p1/vfs/docs/gone.md');
      expect(await screen.findByText(/It may have been deleted or moved/)).toBeInTheDocument();
      expect(screen.getByText('/docs/gone.md')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Open parent folder' }));
      expect(location()).toBe('/project/p1/vfs/docs');
    });

    it('keeps the user’s pick when the deep link’s folder finishes loading later', async () => {
      const slowListing = deferred<DirEntry[]>();
      mockAdapter.readDir.mockImplementation(async (path: string) =>
        path === '/slow' ? slowListing.promise : listings[path]
      );

      renderAt('/project/p1/vfs/slow/file.md');
      fireEvent.click(await screen.findByRole('treeitem', { name: /notes\.md/ }));
      await act(async () => slowListing.resolve([entry('file.md', 'file')]));

      expect(location()).toBe('/project/p1/vfs/notes.md');
      expect(await screen.findByText('Note content')).toBeInTheDocument();
    });
  });

  describe('links in rendered Markdown', () => {
    const openLinkFrom = async (markdown: string, name: string) => {
      contents['/notes.md'] = markdown;
      renderAt('/project/p1/vfs/notes.md');
      fireEvent.click(await screen.findByRole('link', { name }));
    };

    it('open a file in a folder the tree hasn’t loaded yet', async () => {
      await openLinkFrom('[guide](docs/guide.md)', 'guide');
      expect(await screen.findByText('Guide content')).toBeInTheDocument();
      expect(location()).toBe('/project/p1/vfs/docs/guide.md');
      expect(await screen.findByRole('treeitem', { name: /guide\.md/ })).toHaveAttribute(
        'aria-selected',
        'true'
      );
    });

    it('open a folder', async () => {
      await openLinkFrom('[docs](./docs)', 'docs');
      expect(await screen.findByRole('list', { name: 'Folder contents' })).toBeInTheDocument();
      expect(location()).toBe('/project/p1/vfs/docs');
    });

    it('explain a link to nothing', async () => {
      await openLinkFrom('[old](archive/old.md)', 'old');
      expect(await screen.findByText(/It may have been deleted or moved/)).toBeInTheDocument();
      expect(location()).toBe('/project/p1/vfs/archive/old.md');
    });
  });

  describe('mobile', () => {
    beforeEach(() => {
      mockIsMobile = true;
    });

    it('opens a tapped file in a sheet and keeps the selection when it closes', async () => {
      renderAt('/project/p1/vfs');
      fireEvent.click(await screen.findByRole('treeitem', { name: /notes\.md/ }));

      const sheet = await screen.findByRole('dialog', { name: 'notes.md' });
      expect(await within(sheet).findByText('Note content')).toBeInTheDocument();
      fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(location()).toBe('/project/p1/vfs/notes.md');
      expect(treeRow('notes.md')).toHaveAttribute('aria-selected', 'true');
    });

    it('opens a deep-linked file in the sheet', async () => {
      renderAt('/project/p1/vfs/notes.md');
      expect(await screen.findByRole('dialog', { name: 'notes.md' })).toBeInTheDocument();
    });

    it('does not open the sheet when the viewport later crosses into mobile', async () => {
      mockIsMobile = false;
      const view = renderAt('/project/p1/vfs/notes.md');
      await screen.findByText('Note content');

      mockIsMobile = true;
      view.rerender(
        <MemoryRouter initialEntries={['/project/p1/vfs/notes.md']}>
          <Routes>
            <Route path="/project/:projectId/vfs/*" element={<Route_ />} />
          </Routes>
          <Location />
        </MemoryRouter>
      );
      await screen.findByRole('treeitem', { name: /notes\.md/ });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('follows a rendered link to a file in the sheet', async () => {
      contents['/notes.md'] = '[guide](docs/guide.md)';
      renderAt('/project/p1/vfs/notes.md');
      const sheet = await screen.findByRole('dialog', { name: 'notes.md' });
      fireEvent.click(await within(sheet).findByRole('link', { name: 'guide' }));

      const next = await screen.findByRole('dialog', { name: 'guide.md' });
      expect(await within(next).findByText('Guide content')).toBeInTheDocument();
    });

    it('offers the folder actions for the selected file’s folder', async () => {
      renderAt('/project/p1/vfs/docs/guide.md');
      await screen.findByRole('dialog');
      expect(screen.getByText(/^In/)).toHaveTextContent('In /docs');
    });
  });

  describe('actions', () => {
    it('creates a file in the selected folder, then shows it in the editor', async () => {
      alerts.showPrompt.mockResolvedValue('new.md');
      contents['/docs/new.md'] = '';
      renderAt('/project/p1/vfs/docs');
      await screen.findByRole('list', { name: 'Folder contents' });

      listings['/docs'] = [...listings['/docs'], entry('new.md', 'file')];
      fireEvent.click(screen.getByRole('button', { name: 'New file' }));

      await waitFor(() => expect(mockAdapter.createFile).toHaveBeenCalledWith('/docs/new.md', ''));
      expect(alerts.showPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'New file', message: 'In /docs' })
      );
      await waitFor(() => expect(location()).toBe('/project/p1/vfs/docs/new.md'));
      expect(await screen.findByRole('textbox', { name: 'File content' })).toBeInTheDocument();
      expect(await screen.findByRole('treeitem', { name: /new\.md/ })).toHaveAttribute(
        'aria-selected',
        'true'
      );
    });

    it('does nothing when the name prompt is cancelled', async () => {
      alerts.showPrompt.mockResolvedValue(null);
      renderAt('/project/p1/vfs');
      await screen.findByRole('list', { name: 'Folder contents' });
      fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
      await waitFor(() => expect(alerts.showPrompt).toHaveBeenCalled());
      expect(mockAdapter.mkdir).not.toHaveBeenCalled();
    });

    it('selects the parent after deleting the open file', async () => {
      alerts.showDestructiveConfirm.mockResolvedValue(true);
      renderAt('/project/p1/vfs/docs/guide.md');
      await screen.findByText('Guide content');

      fireEvent.click(screen.getByRole('button', { name: 'Delete file' }));
      await waitFor(() => expect(mockAdapter.deleteFile).toHaveBeenCalledWith('/docs/guide.md'));
      await waitFor(() => expect(location()).toBe('/project/p1/vfs/docs'));
    });

    it('selects the parent after deleting a folder that holds the selection', async () => {
      alerts.showDestructiveConfirm.mockResolvedValue(true);
      renderAt('/project/p1/vfs/docs');
      await screen.findByRole('list', { name: 'Folder contents' });

      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(mockAdapter.rmdir).toHaveBeenCalledWith('/docs', true));
      await waitFor(() => expect(location()).toBe('/project/p1/vfs'));
    });

    it('has no Delete for the root folder', async () => {
      renderAt('/project/p1/vfs');
      await screen.findByRole('list', { name: 'Folder contents' });
      expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    });

    it('reports a failed delete in a dialog', async () => {
      alerts.showDestructiveConfirm.mockResolvedValue(true);
      mockAdapter.deleteFile.mockRejectedValue(new Error('READONLY'));
      renderAt('/project/p1/vfs/notes.md');
      await screen.findByText('Note content');

      fireEvent.click(screen.getByRole('button', { name: 'Delete file' }));
      await waitFor(() =>
        expect(alerts.showAlert).toHaveBeenCalledWith('Couldn’t delete file', 'READONLY')
      );
      expect(location()).toBe('/project/p1/vfs/notes.md');
    });

    it('shows upload progress in the status strip and disables the actions meanwhile', async () => {
      const write = deferred<void>();
      mockAdapter.writeFile.mockReturnValueOnce(write.promise);
      renderAt('/project/p1/vfs');
      await screen.findByRole('list', { name: 'Folder contents' });

      const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
      // jsdom's File has no arrayBuffer()
      Object.defineProperty(file, 'arrayBuffer', {
        value: async () => new TextEncoder().encode('hello').buffer,
      });
      fireEvent.change(screen.getByTestId('vfs-upload-input'), { target: { files: [file] } });

      expect(await screen.findByText(/Uploading/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();

      contents['/hello.txt'] = 'hello';
      await act(async () => write.resolve());
      await waitFor(() => expect(screen.queryByText(/Uploading/)).not.toBeInTheDocument());
      expect(mockAdapter.writeFile).toHaveBeenCalledWith('/hello.txt', 'hello');
      await waitFor(() => expect(location()).toBe('/project/p1/vfs/hello.txt'));
    });
  });
});
