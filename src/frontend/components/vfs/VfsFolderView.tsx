import { useEffect } from 'react';
import Spinner from '../ui/Spinner';
import VfsBreadcrumb from './VfsBreadcrumb';
import VfsFolderActions from './VfsFolderActions';
import type { VfsActions } from '../../hooks/useVfsActions';
import type { EntryType, VfsTreeState } from '../../hooks/useVfsTree';
import { formatBytes } from '../../lib/formatBytes';
import { formatTimestamp } from '../../lib/messageFormatters';
import { VFS_ROOT, joinPath } from '../../lib/vfsPath';

interface VfsFolderViewProps {
  dir: string;
  tree: VfsTreeState;
  actions: VfsActions;
  onOpen: (path: string, type: EntryType) => void;
}

const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_6rem_11rem] items-center gap-4';

/** Desktop right panel for a selected folder: path, actions and its contents. */
export default function VfsFolderView({ dir, tree, actions, onOpen }: VfsFolderViewProps) {
  // A folder opened from the URL or the breadcrumb may never have been expanded
  const { ensureLoaded } = tree;
  useEffect(() => {
    ensureLoaded(dir);
  }, [dir, ensureLoaded]);

  const state = tree.dirs.get(dir);
  const entries = state?.entries;

  let body;
  if (entries && entries.length > 0) {
    body = (
      <div>
        <div
          aria-hidden="true"
          className={`${COLUMNS} border-b border-gray-100 px-4 py-2 text-xs font-medium tracking-wide text-gray-400 uppercase`}
        >
          <span>Name</span>
          <span className="text-right">Size</span>
          <span>Modified</span>
        </div>
        <ul aria-label="Folder contents">
          {entries.map(entry => (
            <li key={entry.name}>
              <button
                type="button"
                onClick={() => onOpen(joinPath(dir, entry.name), entry.type)}
                className={`${COLUMNS} w-full px-4 py-2 text-left text-sm hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden="true">{entry.type === 'dir' ? '📁' : '📄'}</span>
                  <span className="truncate text-gray-900">{entry.name}</span>
                </span>
                <span className="text-right text-gray-500">
                  {entry.type === 'file' ? formatBytes(entry.size ?? 0) : '—'}
                </span>
                <span className="truncate text-gray-500">
                  {entry.updatedAt ? formatTimestamp(new Date(entry.updatedAt)) : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  } else if (state?.status === 'error') {
    body = (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-sm">
        <p className="text-red-600">Couldn’t load this folder: {state.error}</p>
        <button
          type="button"
          className="text-blue-600 hover:underline"
          onClick={() => tree.refresh(dir)}
        >
          Retry
        </button>
      </div>
    );
  } else if (!state || state.status === 'loading') {
    body = (
      <div className="flex justify-center py-12 text-gray-400">
        <Spinner size={24} />
      </div>
    );
  } else {
    body = (
      <p className="px-6 py-12 text-center text-sm text-gray-500">
        {dir === VFS_ROOT
          ? 'No memory files yet. The agent’s memory tool writes here as it works, or create and upload files yourself.'
          : 'This folder is empty.'}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-gray-200 px-4 py-3">
        <VfsBreadcrumb path={dir} onNavigate={target => onOpen(target, 'dir')} />
        <div className="ml-auto">
          <VfsFolderActions dir={dir} actions={actions} variant="toolbar" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  );
}
