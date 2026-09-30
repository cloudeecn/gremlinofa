import { useState } from 'react';
import Modal from '../ui/Modal';
import VfsDirectoryTree from './VfsDirectoryTree';
import type { VfsAdapter } from '../../../shared/protocol/types/vfs';

interface VfsPathPickerModalProps {
  isOpen: boolean;
  adapter: VfsAdapter;
  initialPath?: string;
  title?: string;
  onCancel: () => void;
  onSelect: (path: string) => void;
}

/**
 * Pick one VFS file path. Thin wrapper over `VfsDirectoryTree` for the places
 * that ask for a path rather than open a file — the chat settings panel's
 * persona / prompt-file rows.
 */
export default function VfsPathPickerModal({
  isOpen,
  adapter,
  initialPath,
  title = 'Choose a file',
  onCancel,
  onSelect,
}: VfsPathPickerModalProps) {
  const [selected, setSelected] = useState<string | null>(initialPath ?? null);

  return (
    <Modal isOpen={isOpen} onClose={onCancel} size="lg" position="bottom">
      <div className="flex max-h-[85dvh] flex-col rounded-t-2xl bg-white md:max-h-[700px] md:rounded-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 p-4">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button
            onClick={onCancel}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center text-gray-600 transition-colors hover:text-gray-900"
          >
            <span className="text-2xl leading-none">✕</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          <VfsDirectoryTree
            adapter={adapter}
            selectedPath={selected}
            initialPath={initialPath}
            onSelectFile={setSelected}
            onSelectDir={() => {}}
          />
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-gray-200 p-4">
          <span className="min-w-0 truncate font-mono text-xs text-gray-500">
            {selected ?? 'No file selected'}
          </span>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={onCancel}
              className="h-11 rounded-lg px-4 text-base text-gray-700 transition-colors hover:bg-gray-100"
            >
              Cancel
            </button>
            <button
              onClick={() => selected && onSelect(selected)}
              disabled={!selected}
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
