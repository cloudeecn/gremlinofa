import { useState } from 'react';
import Modal from '../ui/Modal';
import VfsTree from './VfsTree';
import type { VfsAdapter } from '../../../shared/protocol/types/vfs';
import { useVfsTree } from '../../hooks/useVfsTree';

interface VfsPathPickerModalProps {
  isOpen: boolean;
  adapter: VfsAdapter;
  initialPath?: string;
  /** Folder shown open when there is no `initialPath` */
  openDir?: string;
  /** Why a file can't be picked, or null when it can. Shown in place of the path. */
  validate?: (path: string) => string | null;
  title?: string;
  onCancel: () => void;
  onSelect: (path: string) => void;
}

/**
 * Pick one VFS file path, for the places that ask for a path rather than
 * open a file: the chat settings panel's persona / prompt-file rows and the
 * chat menu's DUMMY hook. Folders only expand and collapse here.
 */
export default function VfsPathPickerModal({
  isOpen,
  adapter,
  initialPath,
  openDir,
  validate,
  title = 'Choose a file',
  onCancel,
  onSelect,
}: VfsPathPickerModalProps) {
  const [selected, setSelected] = useState<string | null>(initialPath ?? null);
  const tree = useVfsTree(adapter, { reveal: initialPath, openDir });
  const problem = selected && validate ? validate(selected) : null;

  return (
    <Modal isOpen={isOpen} onClose={onCancel} size="lg" position="bottom" ariaLabel={title}>
      <div className="flex max-h-[85dvh] flex-col rounded-t-2xl bg-white md:max-h-[700px] md:rounded-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 p-4">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center text-gray-600 transition-colors hover:text-gray-900"
          >
            <span className="text-2xl leading-none">✕</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          <VfsTree
            tree={tree}
            selectedPath={selected}
            onSelect={setSelected}
            selectDirs={false}
            label="Files"
          />
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-gray-200 p-4">
          {problem ? (
            <span className="min-w-0 text-xs text-red-600" role="alert">
              {problem}
            </span>
          ) : (
            <span className="min-w-0 truncate font-mono text-xs text-gray-500">
              {selected ?? 'No file selected'}
            </span>
          )}
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="h-11 rounded-lg px-4 text-base text-gray-700 transition-colors hover:bg-gray-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => selected && !problem && onSelect(selected)}
              disabled={!selected || !!problem}
              className="h-11 rounded-lg bg-blue-600 px-4 text-base font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              Select
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
