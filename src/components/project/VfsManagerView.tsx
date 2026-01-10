import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useAlert } from '../../hooks/useAlert';
import VfsDirectoryTree from './VfsDirectoryTree';
import VfsFileViewer from './VfsFileViewer';
import VfsFileEditor from './VfsFileEditor';
import VfsDiffViewer from './VfsDiffViewer';
import VfsFileModal from './VfsFileModal';
import * as vfsService from '../../services/vfs/vfsService';

export interface VfsManagerViewProps {
  projectId: string;
  initialPath?: string;
  onMenuPress?: () => void;
}

type DesktopMode = 'view' | 'edit' | 'diff';

export default function VfsManagerView({
  projectId,
  initialPath,
  onMenuPress,
}: VfsManagerViewProps) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { showDestructiveConfirm } = useAlert();

  // Selection state
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<'file' | 'dir' | null>(null);

  // Desktop mode state
  const [desktopMode, setDesktopMode] = useState<DesktopMode>('view');
  const [editInitialContent, setEditInitialContent] = useState('');

  // Mobile modal state
  const [mobileModalOpen, setMobileModalOpen] = useState(false);

  // Tree refresh key
  const [treeKey, setTreeKey] = useState(0);

  // Content refresh key for desktop
  const [contentKey, setContentKey] = useState(0);

  // Handle initial path from URL deep link
  useEffect(() => {
    if (!initialPath) return;

    const checkAndSelectPath = async () => {
      try {
        const isFileResult = await vfsService.isFile(projectId, initialPath);
        if (isFileResult) {
          setSelectedPath(initialPath);
          setSelectedType('file');
          if (isMobile) {
            setMobileModalOpen(true);
          }
          return;
        }

        const isDirResult = await vfsService.isDirectory(projectId, initialPath);
        if (isDirResult) {
          setSelectedPath(initialPath);
          setSelectedType('dir');
        }
        // If neither exists, just ignore (user may want to see empty tree)
      } catch (error) {
        console.debug('[VfsManagerView] Initial path check failed:', error);
      }
    };

    checkAndSelectPath();
  }, [initialPath, projectId, isMobile]);

  const handleSelectFile = useCallback(
    (path: string) => {
      setSelectedPath(path);
      setSelectedType('file');
      setDesktopMode('view');
      setContentKey(k => k + 1);

      if (isMobile) {
        setMobileModalOpen(true);
      }
    },
    [isMobile]
  );

  const handleSelectDir = useCallback((path: string) => {
    setSelectedPath(path);
    setSelectedType('dir');
    setDesktopMode('view');
  }, []);

  const handleBack = useCallback(() => {
    navigate(`/project/${projectId}/settings`);
  }, [navigate, projectId]);

  // Desktop: Edit
  const handleDesktopEdit = useCallback(async () => {
    if (!selectedPath) return;

    try {
      const content = await vfsService.readFile(projectId, selectedPath);
      setEditInitialContent(content);
      setDesktopMode('edit');
    } catch (error) {
      console.debug('[VfsManagerView] Failed to load content for edit:', error);
    }
  }, [projectId, selectedPath]);

  // Desktop: Diff
  const handleDesktopDiff = useCallback(() => {
    setDesktopMode('diff');
  }, []);

  // Desktop: Delete file
  const handleDesktopDeleteFile = useCallback(async () => {
    if (!selectedPath) return;

    const filename = vfsService.getBasename(selectedPath);
    const confirmed = await showDestructiveConfirm(
      'Delete File',
      `Are you sure you want to delete "${filename}"? This file will be marked as deleted.`,
      'Delete'
    );

    if (confirmed) {
      try {
        await vfsService.deleteFile(projectId, selectedPath);
        setSelectedPath(null);
        setSelectedType(null);
        setTreeKey(k => k + 1);
      } catch (error) {
        console.debug('[VfsManagerView] Failed to delete file:', error);
      }
    }
  }, [projectId, selectedPath, showDestructiveConfirm]);

  // Desktop: Delete directory
  const handleDeleteDirectory = useCallback(async () => {
    if (!selectedPath || selectedType !== 'dir') return;

    const dirname = vfsService.getBasename(selectedPath);
    const confirmed = await showDestructiveConfirm(
      'Delete Directory',
      `Are you sure you want to delete "${dirname}" and all its contents? This directory will be marked as deleted.`,
      'Delete'
    );

    if (confirmed) {
      try {
        await vfsService.rmdir(projectId, selectedPath, true);
        setSelectedPath(null);
        setSelectedType(null);
        setTreeKey(k => k + 1);
      } catch (error) {
        console.debug('[VfsManagerView] Failed to delete directory:', error);
      }
    }
  }, [projectId, selectedPath, selectedType, showDestructiveConfirm]);

  // Desktop: Save from editor
  const handleDesktopSave = useCallback(() => {
    setDesktopMode('view');
    setContentKey(k => k + 1);
    setTreeKey(k => k + 1);
  }, []);

  // Desktop: Cancel edit
  const handleDesktopCancel = useCallback(() => {
    setDesktopMode('view');
  }, []);

  // Desktop: Rollback from diff
  const handleDesktopRollback = useCallback(() => {
    setDesktopMode('view');
    setContentKey(k => k + 1);
    setTreeKey(k => k + 1);
  }, []);

  // Desktop: Close diff
  const handleDesktopDiffClose = useCallback(() => {
    setDesktopMode('view');
  }, []);

  // Mobile: File deleted
  const handleMobileFileDeleted = useCallback(() => {
    setSelectedPath(null);
    setSelectedType(null);
    setTreeKey(k => k + 1);
  }, []);

  // Mobile: Modal close
  const handleMobileModalClose = useCallback(() => {
    setMobileModalOpen(false);
    // Tree refresh handled by handleMobileFileDeleted when files are deleted
    // Don't refresh on close to preserve expand state
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-gray-50">
      {/* Header with safe area */}
      <div className="border-b border-gray-200 bg-white">
        <div className="safe-area-inset-top" />
        <div className="flex h-14 items-center px-4">
          {onMenuPress && (
            <button
              onClick={onMenuPress}
              className="flex h-11 w-11 items-center justify-center text-gray-700 hover:text-gray-900 md:hidden"
            >
              <span className="text-2xl">☰</span>
            </button>
          )}
          <button
            onClick={handleBack}
            className="flex h-11 items-center gap-1 text-gray-600 hover:text-gray-900"
          >
            <span className="text-xl">←</span>
            <span className="hidden sm:inline">Back</span>
          </button>
          <div className="flex-1 text-center">
            <h1 className="text-lg font-semibold text-gray-900">Memory Files</h1>
          </div>
          <div className="w-11" /> {/* Spacer for balance */}
        </div>
      </div>

      {/* Content area */}
      {isMobile ? (
        // Mobile: Full-width tree, modal for file
        <div className="flex flex-1 flex-col overflow-hidden">
          <VfsDirectoryTree
            key={treeKey}
            projectId={projectId}
            selectedPath={selectedPath}
            initialPath={initialPath}
            onSelectFile={handleSelectFile}
            onSelectDir={handleSelectDir}
          />

          {/* Directory actions */}
          {selectedType === 'dir' && selectedPath && (
            <div className="border-t border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">
                  Selected:{' '}
                  <span className="font-medium">{vfsService.getBasename(selectedPath)}</span>
                </span>
                <button
                  type="button"
                  className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-700"
                  onClick={handleDeleteDirectory}
                >
                  Delete
                </button>
              </div>
            </div>
          )}

          {/* Mobile modal */}
          {selectedPath && selectedType === 'file' && (
            <VfsFileModal
              projectId={projectId}
              path={selectedPath}
              isOpen={mobileModalOpen}
              onClose={handleMobileModalClose}
              onFileDeleted={handleMobileFileDeleted}
            />
          )}
        </div>
      ) : (
        // Desktop: Side-by-side layout
        <div className="flex flex-1 overflow-hidden">
          {/* Left panel: Directory tree */}
          <div className="flex w-2/5 max-w-[400px] min-w-[200px] flex-col border-r border-gray-200 bg-white">
            <VfsDirectoryTree
              key={treeKey}
              projectId={projectId}
              selectedPath={selectedPath}
              initialPath={initialPath}
              onSelectFile={handleSelectFile}
              onSelectDir={handleSelectDir}
            />
          </div>

          {/* Right panel: File content or directory info */}
          <div className="flex flex-1 flex-col overflow-hidden bg-white">
            {!selectedPath ? (
              <div className="flex flex-1 items-center justify-center">
                <p className="text-gray-400">Select a file to view its content</p>
              </div>
            ) : selectedType === 'dir' ? (
              <div className="flex flex-1 flex-col">
                {/* Directory header */}
                <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-3">
                  <span className="text-xl">📁</span>
                  <span className="font-medium text-gray-900">
                    {vfsService.getBasename(selectedPath) || '/'}
                  </span>
                </div>
                {/* Directory actions */}
                <div className="flex flex-1 flex-col items-center justify-center gap-4 p-4">
                  <p className="text-gray-500">Directory selected</p>
                  <button
                    type="button"
                    className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
                    onClick={handleDeleteDirectory}
                  >
                    🗑️ Delete Directory
                  </button>
                </div>
              </div>
            ) : desktopMode === 'view' ? (
              <VfsFileViewer
                key={`view-${contentKey}`}
                projectId={projectId}
                path={selectedPath}
                onEdit={handleDesktopEdit}
                onDiff={handleDesktopDiff}
                onDelete={handleDesktopDeleteFile}
              />
            ) : desktopMode === 'edit' ? (
              <VfsFileEditor
                projectId={projectId}
                path={selectedPath}
                initialContent={editInitialContent}
                onSave={handleDesktopSave}
                onCancel={handleDesktopCancel}
              />
            ) : (
              <VfsDiffViewer
                projectId={projectId}
                path={selectedPath}
                onRollback={handleDesktopRollback}
                onClose={handleDesktopDiffClose}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
