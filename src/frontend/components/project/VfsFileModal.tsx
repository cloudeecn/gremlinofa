import { useState, useEffect, useCallback, useRef } from 'react';
import Modal from '../ui/Modal';
import VfsFileViewer from './VfsFileViewer';
import VfsFileEditor from './VfsFileEditor';
import VfsDiffViewer from './VfsDiffViewer';
import type { VfsAdapter } from '../../../shared/protocol/types/vfs';
import { useAlert } from '../../hooks/useAlert';

// Phase 1.8 leak fix — see VfsFileEditor.tsx for the rationale.
const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? '';

export interface VfsFileModalProps {
  adapter: VfsAdapter;
  projectId: string;
  path: string;
  isOpen: boolean;
  onClose: () => void;
  onFileDeleted: () => void;
}

type Mode = 'view' | 'edit' | 'diff';

export default function VfsFileModal({
  adapter,
  projectId,
  path,
  isOpen,
  onClose,
  onFileDeleted,
}: VfsFileModalProps) {
  const [mode, setMode] = useState<Mode>('view');
  const [initialContent, setInitialContent] = useState('');
  const [contentVersion, setContentVersion] = useState(0);
  const { showDestructiveConfirm } = useAlert();

  // Bumped whenever the modal opens, closes or switches file, so an edit load
  // started before that can tell it's stale.
  const sessionSeqRef = useRef(0);

  // Reset to view mode when path changes or modal opens
  useEffect(() => {
    sessionSeqRef.current++;
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on modal open/path change
      setMode('view');
      setContentVersion(v => v + 1);
    }
  }, [isOpen, path]);

  // Load initial content for editor
  const handleEdit = useCallback(async () => {
    const sessionSeq = sessionSeqRef.current;
    try {
      const content = await adapter.readFile(path);
      // Reopened on another file mid-read: its editor must not get this content
      if (sessionSeqRef.current !== sessionSeq) return;
      setInitialContent(content);
      setMode('edit');
    } catch (error) {
      console.debug('[VfsFileModal] Failed to load content for edit:', error);
    }
  }, [adapter, path]);

  const handleDiff = useCallback(() => {
    setMode('diff');
  }, []);

  const handleDelete = useCallback(async () => {
    const filename = basename(path);
    const confirmed = await showDestructiveConfirm(
      'Delete File',
      `Are you sure you want to delete "${filename}"? This file will be marked as deleted.`,
      'Delete'
    );

    if (confirmed) {
      try {
        await adapter.deleteFile(path);
        onFileDeleted();
        onClose();
      } catch (error) {
        console.debug('[VfsFileModal] Failed to delete file:', error);
      }
    }
  }, [adapter, path, onFileDeleted, onClose, showDestructiveConfirm]);

  const handleSave = useCallback(() => {
    setMode('view');
    setContentVersion(v => v + 1);
  }, []);

  const handleCancel = useCallback(() => {
    setMode('view');
  }, []);

  const handleRollback = useCallback(() => {
    setMode('view');
    setContentVersion(v => v + 1);
  }, []);

  const handleDiffClose = useCallback(() => {
    setMode('view');
  }, []);

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="full" position="bottom">
      <div className="flex max-h-[85dvh] min-h-[350px] flex-col overflow-hidden overscroll-y-contain rounded-t-xl bg-white md:max-h-[700px] md:rounded-xl">
        {mode === 'view' && (
          <VfsFileViewer
            key={`view-${contentVersion}`}
            adapter={adapter}
            path={path}
            onEdit={handleEdit}
            onDiff={handleDiff}
            onDelete={handleDelete}
            onClose={onClose}
          />
        )}
        {mode === 'edit' && (
          <VfsFileEditor
            adapter={adapter}
            projectId={projectId}
            path={path}
            initialContent={initialContent}
            onSave={handleSave}
            onCancel={handleCancel}
          />
        )}
        {mode === 'diff' && (
          <VfsDiffViewer
            adapter={adapter}
            path={path}
            onRollback={handleRollback}
            onClose={handleDiffClose}
          />
        )}
      </div>
    </Modal>
  );
}
