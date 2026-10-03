import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import VfsFilePanel from '../VfsFilePanel';
import type { VfsAdapter } from '../../../../shared/protocol/types/vfs';

const alerts = vi.hoisted(() => ({
  showAlert: vi.fn(),
  showConfirm: vi.fn(),
  showDestructiveConfirm: vi.fn(),
  showPrompt: vi.fn(),
}));
vi.mock('../../../hooks/useAlert', () => ({ useAlert: () => alerts }));

const downloadBlob = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/download', () => ({ downloadBlob }));

interface Meta {
  version: number;
  storedVersionCount: number;
  minStoredVersion: number;
}

function makeAdapter(content = 'hello', meta: Partial<Meta> = {}) {
  const fullMeta = {
    version: 3,
    storedVersionCount: 3,
    minStoredVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    ...meta,
  };
  return {
    readFileWithMeta: vi.fn().mockResolvedValue({ content, isBinary: false, mime: 'text/plain' }),
    getFileMeta: vi.fn().mockResolvedValue(fullMeta),
    writeFile: vi.fn().mockResolvedValue(undefined),
    getFileId: vi.fn().mockResolvedValue('file_1'),
    dropOldVersions: vi.fn().mockResolvedValue(2),
    listVersions: vi.fn().mockResolvedValue([]),
    getVersion: vi.fn().mockResolvedValue('x'),
  };
}

let adapter: ReturnType<typeof makeAdapter>;
const handlers = {
  onNavigate: vi.fn(),
  onOpenLink: vi.fn(),
  onChanged: vi.fn(),
  onDelete: vi.fn(),
};

function renderPanel(props: Partial<Parameters<typeof VfsFilePanel>[0]> = {}) {
  return render(
    <VfsFilePanel
      adapter={adapter as unknown as VfsAdapter}
      projectId="p1"
      path="/notes/todo.md"
      {...handlers}
      {...props}
    />
  );
}

const tab = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const editor = () => screen.getByRole('textbox', { name: 'File content' });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  adapter = makeAdapter();
});

describe('VfsFilePanel', () => {
  it('opens a Markdown file rendered, with its version and breadcrumb', async () => {
    adapter = makeAdapter('# Plans');
    renderPanel();
    expect(await screen.findByRole('heading', { name: 'Plans' })).toBeInTheDocument();
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(tab('Render')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(tab('Source'));
    expect(screen.getByText('# Plans')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'notes' }));
    expect(handlers.onNavigate).toHaveBeenCalledWith('/notes');
  });

  it('shows a load error with Retry', async () => {
    adapter.readFileWithMeta.mockRejectedValueOnce(new Error('Path not found'));
    renderPanel();
    expect(await screen.findByText(/Couldn’t open “todo.md”: Path not found/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('hello')).toBeInTheDocument();
  });

  it('opens other text on Source, with no Render tab', async () => {
    renderPanel({ path: '/notes/todo.txt' });
    expect(await screen.findByText('hello')).toBeInTheDocument();
    expect(tab('Source')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: /^Render/ })).not.toBeInTheDocument();
  });

  it('shows a binary image with no tabs, downloadable from the toolbar', async () => {
    adapter.readFileWithMeta.mockResolvedValue({
      content: 'iVBORw==',
      isBinary: true,
      mime: 'image/png',
    });
    renderPanel({ path: '/pic.png' });

    expect(await screen.findByRole('img', { name: 'pic.png' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'View' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Download file' }));
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'pic.png');
    expect((downloadBlob.mock.calls[0][0] as Blob).type).toBe('image/png');
  });

  it('offers other binary files as a download only', async () => {
    adapter.readFileWithMeta.mockResolvedValue({
      content: 'UEsDBA==',
      isBinary: true,
      mime: 'application/zip',
    });
    renderPanel({ path: '/backup.zip' });

    expect(await screen.findByText('application/zip · no text preview')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'View' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'backup.zip');
  });

  it('hands rendered links to other memory files to the parent', async () => {
    adapter = makeAdapter('See [done](../done.md)');
    renderPanel();
    fireEvent.click(await screen.findByRole('link', { name: 'done' }));
    expect(handlers.onOpenLink).toHaveBeenCalledWith('/done.md');
  });

  it('disables History until an earlier version is stored', async () => {
    adapter = makeAdapter('hello', { version: 1, storedVersionCount: 1 });
    renderPanel();
    await screen.findByText('hello');
    expect(tab('History')).toBeDisabled();
  });

  describe('drop old versions', () => {
    it('is offered only while more than 10 versions are stored', async () => {
      // Dropped down to 10 already: v15 with 10 stored
      adapter = makeAdapter('hello', { version: 15, storedVersionCount: 10, minStoredVersion: 6 });
      renderPanel();
      await screen.findByText('hello');
      expect(screen.getByText('v15 (10 stored)')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Drop old versions/ })).not.toBeInTheDocument();
    });

    it('keeps the latest 10 and reloads', async () => {
      adapter = makeAdapter('hello', { version: 12, storedVersionCount: 12 });
      alerts.showDestructiveConfirm.mockResolvedValue(true);
      renderPanel();
      await screen.findByText('hello');

      fireEvent.click(screen.getByRole('button', { name: /Drop old versions/ }));
      await waitFor(() => expect(adapter.dropOldVersions).toHaveBeenCalledWith('file_1', 10));
      expect(alerts.showDestructiveConfirm.mock.calls[0][1]).toMatch(/2 oldest stored versions/);
      await waitFor(() => expect(adapter.readFileWithMeta).toHaveBeenCalledTimes(2));
    });
  });

  describe('editing', () => {
    it('keeps the draft across tab switches and marks the Edit tab', async () => {
      renderPanel();
      await screen.findByText('hello');

      fireEvent.click(tab('Edit'));
      fireEvent.change(editor(), { target: { value: 'hello world' } });
      expect(screen.getByTitle('Unsaved draft')).toBeInTheDocument();

      fireEvent.click(tab('Source'));
      expect(screen.getByText('hello')).toBeInTheDocument();
      fireEvent.click(tab('Edit'));
      expect(editor()).toHaveValue('hello world');
    });

    it('saves, reloads and returns to the rendered view', async () => {
      renderPanel({ initialTab: 'edit' });
      await waitFor(() => expect(editor()).toHaveValue('hello'));

      fireEvent.change(editor(), { target: { value: 'saved text' } });
      adapter.readFileWithMeta.mockResolvedValue({
        content: 'saved text',
        isBinary: false,
        mime: 'text/plain',
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(adapter.writeFile).toHaveBeenCalledWith('/notes/todo.md', 'saved text')
      );
      expect(alerts.showConfirm).not.toHaveBeenCalled();
      expect(await screen.findByText('saved text')).toBeInTheDocument();
      expect(tab('Render')).toHaveAttribute('aria-pressed', 'true');
      expect(handlers.onChanged).toHaveBeenCalled();
    });

    it('saves with Ctrl/Cmd+S', async () => {
      renderPanel({ initialTab: 'edit' });
      await waitFor(() => expect(editor()).toHaveValue('hello'));
      fireEvent.change(editor(), { target: { value: 'quick' } });

      fireEvent.keyDown(editor(), { key: 's', metaKey: true });
      await waitFor(() =>
        expect(adapter.writeFile).toHaveBeenCalledWith('/notes/todo.md', 'quick')
      );
    });

    it('asks before overwriting a version saved after the one being edited', async () => {
      renderPanel({ initialTab: 'edit' });
      await waitFor(() => expect(editor()).toHaveValue('hello'));
      fireEvent.change(editor(), { target: { value: 'mine' } });

      adapter.getFileMeta.mockResolvedValue({
        version: 4,
        storedVersionCount: 4,
        minStoredVersion: 1,
        createdAt: 0,
        updatedAt: 0,
      });
      alerts.showConfirm.mockResolvedValueOnce(false);
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(alerts.showConfirm).toHaveBeenCalled());
      expect(alerts.showConfirm.mock.calls[0][1]).toMatch(/v4 was saved after the v3/);
      expect(adapter.writeFile).not.toHaveBeenCalled();
      expect(editor()).toHaveValue('mine');

      alerts.showConfirm.mockResolvedValueOnce(true);
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(adapter.writeFile).toHaveBeenCalledWith('/notes/todo.md', 'mine'));
    });

    it('shows a failed save inline and keeps the text', async () => {
      adapter.writeFile.mockRejectedValue(new Error('READONLY'));
      renderPanel({ initialTab: 'edit' });
      await waitFor(() => expect(editor()).toHaveValue('hello'));
      fireEvent.change(editor(), { target: { value: 'mine' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t save: READONLY');
      expect(editor()).toHaveValue('mine');
    });

    it('discards only after confirming', async () => {
      renderPanel({ initialTab: 'edit' });
      await waitFor(() => expect(editor()).toHaveValue('hello'));
      fireEvent.change(editor(), { target: { value: 'scratch' } });

      alerts.showDestructiveConfirm.mockResolvedValueOnce(false);
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      await waitFor(() => expect(alerts.showDestructiveConfirm).toHaveBeenCalledTimes(1));
      expect(editor()).toHaveValue('scratch');

      alerts.showDestructiveConfirm.mockResolvedValueOnce(true);
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      await waitFor(() => expect(editor()).toHaveValue('hello'));
    });

    it('restores a draft left from an earlier visit', async () => {
      const first = renderPanel({ initialTab: 'edit' });
      await waitFor(() => expect(editor()).toHaveValue('hello'));
      fireEvent.change(editor(), { target: { value: 'unsaved' } });
      first.unmount();

      renderPanel();
      await screen.findByText('hello');
      expect(await screen.findByTitle('Unsaved draft')).toBeInTheDocument();
      fireEvent.click(tab('Edit'));
      expect(editor()).toHaveValue('unsaved');
    });
  });

  it('hands Delete to the parent', async () => {
    renderPanel();
    await screen.findByText('hello');
    fireEvent.click(screen.getByRole('button', { name: 'Delete file' }));
    expect(handlers.onDelete).toHaveBeenCalled();
  });
});
