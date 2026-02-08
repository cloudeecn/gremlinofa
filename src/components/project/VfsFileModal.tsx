import { useState, useEffect, useCallback } from 'react';
import Modal from '../ui/Modal';
import VfsFileViewer from './VfsFileViewer';
import VfsFileEditor from './VfsFileEditor';
import VfsDiffViewer from './VfsDiffViewer';
import * as vfsService from '../../services/vfs/vfsService';
import { useAlert } from '../../hooks/useAlert';

export interface VfsFileModalProps {
  projectId: string;
  path: string;
  isOpen: boolean;
  onClose: () => void;
  onFileDeleted: () => void;
}

type Mode = 'view' | 'edit' | 'diff';

export default function VfsFileModal({
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

  // Reset to view mode when path changes or modal opens
  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on modal open/path change
      setMode('view');
      setContentVersion(v => v + 1);
    }
  }, [isOpen, path]);

  // Load initial content for editor
  const handleEdit = useCallback(async () => {
    try {
      const content = await vfsService.readFile(projectId, path);
      setInitialContent(content);
      setMode('edit');
    } catch (error) {
      console.debug('[VfsFileModal] Failed to load content for edit:', error);
    }
  }, [projectId, path]);

  const handleDiff = useCallback(() => {
    setMode('diff');
  }, []);

  const handleDelete = useCallback(async () => {
    const filename = vfsService.getBasename(path);
    const confirmed = await showDestructiveConfirm(
      'Delete File',
      `Are you sure you want to delete "${filename}"? This file will be marked as deleted.`,
      'Delete'
    );

    if (confirmed) {
      try {
        await vfsService.deleteFile(projectId, path);
        onFileDeleted();
        onClose();
      } catch (error) {
        console.debug('[VfsFileModal] Failed to delete file:', error);
      }
    }
  }, [projectId, path, onFileDeleted, onClose, showDestructiveConfirm]);

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
            projectId={projectId}
            path={path}
            onEdit={handleEdit}
            onDiff={handleDiff}
            onDelete={handleDelete}
            onClose={onClose}
          />
        )}
        {mode === 'edit' && (
          <VfsFileEditor
            projectId={projectId}
            path={path}
            initialContent={initialContent}
            onSave={handleSave}
            onCancel={handleCancel}
          />
        )}
        {mode === 'diff' && (
          <VfsDiffViewer
            projectId={projectId}
            path={path}
            onRollback={handleRollback}
            onClose={handleDiffClose}
          />
        )}
      </div>
    </Modal>
  );
}
