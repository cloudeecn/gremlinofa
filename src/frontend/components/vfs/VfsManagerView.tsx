import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from '../ui/Modal';
import Spinner from '../ui/Spinner';
import VfsButton from './VfsButton';
import VfsFilePanel from './VfsFilePanel';
import type { FileTab } from './VfsFilePanel';
import VfsFolderActions from './VfsFolderActions';
import VfsFolderView from './VfsFolderView';
import VfsTree from './VfsTree';
import { gremlinClient } from '../../client';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useStableCallback } from '../../hooks/useStableCallback';
import { useVfsActions } from '../../hooks/useVfsActions';
import { useVfsTree } from '../../hooks/useVfsTree';
import type { EntryType } from '../../hooks/useVfsTree';
import { VFS_ROOT, basename, dirname, isWithin, vfsUrl } from '../../lib/vfsPath';

export interface VfsManagerViewProps {
  projectId: string;
  /** The selected path, from the URL (`/` when the URL has none) */
  path: string;
}

type SelectionKind = EntryType | 'pending' | 'missing';

/**
 * Memory Files page. The URL holds the selection: picking an entry replaces
 * the URL, so a reload or a shared link lands on the same file. The entry's
 * type comes from the click, or from the parent's listing for a path that
 * came in through the URL.
 */
export default function VfsManagerView({ projectId, path }: VfsManagerViewProps) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const adapter = useMemo(() => gremlinClient.getVfsAdapter(projectId), [projectId]);
  const tree = useVfsTree(adapter, { reveal: path });

  const [picked, setPicked] = useState<{ path: string; type: EntryType } | null>(null);
  // Which file the mobile sheet shows. A deep link opens it; crossing the
  // breakpoint later (tablet rotation) doesn't.
  const [sheetPath, setSheetPath] = useState<string | null>(() =>
    isMobile && path !== VFS_ROOT ? path : null
  );
  const [requestedTab, setRequestedTab] = useState<{ path: string; tab: FileTab } | null>(null);

  // A path that arrived through the URL is looked up in its parent's
  // listing; a listing without it, or a parent that failed to load, means
  // it doesn't exist.
  const parentStatus = tree.dirs.get(dirname(path))?.status;
  const kind: SelectionKind =
    picked?.path === path
      ? picked.type
      : (tree.entryKind(path) ??
        (parentStatus === 'ready' || parentStatus === 'error' ? 'missing' : 'pending'));

  // The tree loads the deep link's folders on mount; this covers a URL
  // changed by hand while the page is open
  const { ensureLoaded } = tree;
  useEffect(() => {
    ensureLoaded(dirname(path));
  }, [ensureLoaded, path]);

  /** Selection from the tree, which handles its own expansion */
  const select = (target: string, type: EntryType, tab?: FileTab) => {
    setPicked({ path: target, type });
    setRequestedTab(tab ? { path: target, tab } : null);
    if (type === 'file' && isMobile) setSheetPath(target);
    if (target !== path) navigate(vfsUrl(projectId, target), { replace: true });
  };

  /** Selection from anywhere else: also show it in the tree */
  const open = (target: string, type: EntryType, tab?: FileTab) => {
    tree.reveal(target);
    if (type === 'dir') tree.expand(target);
    select(target, type, tab);
  };

  const openFolder = (dir: string) => {
    setSheetPath(null);
    open(dir, 'dir');
  };

  /** A link in a rendered file, to a path that may be unlisted or missing */
  const openLink = (target: string) => {
    const type = tree.entryKind(target);
    if (type === 'dir') {
      openFolder(target);
      return;
    }
    if (type === 'file') {
      open(target, 'file');
      return;
    }
    // Resolved like a deep link, from the parent's listing
    tree.reveal(target);
    setPicked(null);
    setRequestedTab(null);
    setSheetPath(isMobile ? target : null);
    navigate(vfsUrl(projectId, target), { replace: true });
  };

  // Called when an action finishes, possibly after the user moved on, so
  // they read the selection from the latest render
  const handleCreated = useStableCallback((target: string, type: EntryType, isNew: boolean) =>
    open(target, type, type === 'file' && isNew ? 'edit' : undefined)
  );
  const handleDeleted = useStableCallback((deleted: string) => {
    if (isWithin(path, deleted)) openFolder(dirname(deleted));
  });

  const actions = useVfsActions({
    adapter,
    tree,
    onCreated: handleCreated,
    onDeleted: handleDeleted,
  });

  const filePanel = (onClose?: () => void) => (
    <VfsFilePanel
      key={path}
      adapter={adapter}
      projectId={projectId}
      path={path}
      initialTab={requestedTab?.path === path ? requestedTab.tab : undefined}
      onNavigate={openFolder}
      onOpenLink={openLink}
      onChanged={() => tree.refresh(dirname(path))}
      onDelete={() => void actions.deleteEntry(path, 'file')}
      onClose={onClose}
    />
  );

  const explorer = (
    <>
      <div className="flex items-center justify-between py-1 pr-1.5 pl-3">
        <span className="text-xs font-medium tracking-wide text-gray-500 uppercase">Files</span>
        <VfsButton icon="↻" label="Refresh" iconOnly onClick={() => tree.refresh()} />
      </div>
      <div className="ios-scroll min-h-0 flex-1 overflow-y-auto overscroll-y-contain pb-4">
        <VfsTree tree={tree} selectedPath={kind === 'missing' ? null : path} onSelect={select} />
      </div>
    </>
  );

  let content;
  switch (kind) {
    case 'pending':
      content = (
        <div className="flex flex-1 items-center justify-center text-gray-400">
          <Spinner size={24} />
        </div>
      );
      break;
    case 'missing':
      content = (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm">
          <p className="text-gray-600">
            Nothing at <span className="font-mono break-all">{path}</span>. It may have been deleted
            or moved.
          </p>
          <VfsButton label="Open parent folder" onClick={() => openFolder(dirname(path))} />
        </div>
      );
      break;
    case 'dir':
      content = <VfsFolderView dir={path} tree={tree} actions={actions} onOpen={open} />;
      break;
    case 'file':
      content = filePanel();
      break;
  }

  const actionDir = kind === 'dir' ? path : dirname(path);
  const sheetOpen = isMobile && kind === 'file' && sheetPath === path;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="safe-area-inset-top" />
        <div className="flex h-14 items-center gap-2 px-2">
          <button
            type="button"
            onClick={() => navigate(`/project/${projectId}`)}
            className="flex h-11 items-center gap-1 rounded-lg px-2 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
          >
            <span aria-hidden="true" className="text-xl">
              ←
            </span>
            <span className="hidden sm:inline">Back</span>
            <span className="sr-only sm:hidden">Back to project</span>
          </button>
          <h1 className="text-lg font-semibold text-gray-900">Memory Files</h1>
        </div>
      </header>

      <div aria-live="polite">
        {actions.busy && (
          <div className="flex items-center gap-2 border-b border-blue-100 bg-blue-50 px-4 py-1.5 text-sm text-blue-800">
            <Spinner size={14} />
            <span>
              {actions.busy.label}
              {actions.busy.total ? ` ${actions.busy.done}/${actions.busy.total}` : ''}…
            </span>
          </div>
        )}
      </div>

      {isMobile ? (
        <div className="flex min-h-0 flex-1 flex-col bg-white">
          {kind === 'missing' && (
            <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
              Nothing at <span className="font-mono break-all">{path}</span>.
            </p>
          )}
          {explorer}
          <div className="border-t border-gray-200 bg-white px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            <p className="mb-1.5 truncate text-xs text-gray-500">
              In <span className="font-medium text-gray-700">{actionDir}</span>
            </p>
            <VfsFolderActions dir={actionDir} actions={actions} variant="bar" />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-72 shrink-0 flex-col border-r border-gray-200 bg-white lg:w-80">
            {explorer}
          </div>
          <div className="flex min-w-0 flex-1 flex-col bg-white">{content}</div>
        </div>
      )}

      {sheetOpen && (
        <Modal
          isOpen
          onClose={() => setSheetPath(null)}
          size="full"
          position="bottom"
          ariaLabel={basename(path)}
        >
          <div className="flex h-[85dvh] flex-col overflow-hidden rounded-t-xl bg-white">
            {filePanel(() => setSheetPath(null))}
          </div>
        </Modal>
      )}
    </div>
  );
}
