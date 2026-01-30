import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useAlert } from '../../hooks/useAlert';
import VfsDirectoryTree from './VfsDirectoryTree';
import VfsFileViewer from './VfsFileViewer';
import VfsFileEditor from './VfsFileEditor';
import VfsDiffViewer from './VfsDiffViewer';
import VfsFileModal from './VfsFileModal';
import * as vfsService from '../../services/vfs/vfsService';
import { zip } from 'fflate';

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

  // File upload input ref
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Loading state for operations
  const [isOperating, setIsOperating] = useState(false);

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
    navigate(`/project/${projectId}`);
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

  // Create new file
  const handleCreateFile = useCallback(async () => {
    const dirPath = selectedPath && selectedType === 'dir' ? selectedPath : '/';
    const filename = prompt('Enter file name:');
    if (!filename || !filename.trim()) return;

    const filePath = dirPath === '/' ? `/${filename.trim()}` : `${dirPath}/${filename.trim()}`;

    try {
      await vfsService.createFile(projectId, filePath, '');
      setTreeKey(k => k + 1);
      setSelectedPath(filePath);
      setSelectedType('file');
      setContentKey(k => k + 1);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to create file';
      alert(msg);
    }
  }, [projectId, selectedPath, selectedType]);

  // Create new directory
  const handleCreateDirectory = useCallback(async () => {
    const dirPath = selectedPath && selectedType === 'dir' ? selectedPath : '/';
    const dirname = prompt('Enter directory name:');
    if (!dirname || !dirname.trim()) return;

    const newDirPath = dirPath === '/' ? `/${dirname.trim()}` : `${dirPath}/${dirname.trim()}`;

    try {
      await vfsService.mkdir(projectId, newDirPath);
      setTreeKey(k => k + 1);
      setSelectedPath(newDirPath);
      setSelectedType('dir');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to create directory';
      alert(msg);
    }
  }, [projectId, selectedPath, selectedType]);

  // Upload file - detect UTF-8 or binary
  const handleFileUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      // Reset input so same file can be re-selected
      event.target.value = '';

      const dirPath = selectedPath && selectedType === 'dir' ? selectedPath : '/';
      const filePath = dirPath === '/' ? `/${file.name}` : `${dirPath}/${file.name}`;

      setIsOperating(true);
      try {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        // Try to decode as UTF-8
        let isText = false;
        let textContent = '';
        try {
          const decoder = new TextDecoder('utf-8', { fatal: true });
          textContent = decoder.decode(bytes);
          isText = true;
        } catch {
          // Contains invalid UTF-8 sequences, treat as binary
          isText = false;
        }

        if (isText) {
          await vfsService.writeFile(projectId, filePath, textContent);
        } else {
          await vfsService.writeFile(projectId, filePath, buffer);
        }

        setTreeKey(k => k + 1);
        setSelectedPath(filePath);
        setSelectedType('file');
        setContentKey(k => k + 1);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Failed to upload file';
        alert(msg);
      } finally {
        setIsOperating(false);
      }
    },
    [projectId, selectedPath, selectedType]
  );

  // Download directory as ZIP
  const handleDownloadZip = useCallback(async () => {
    if (!selectedPath || selectedType !== 'dir') return;

    setIsOperating(true);
    try {
      // Collect all files recursively
      const files: Record<string, Uint8Array> = {};

      const collectFiles = async (dirPath: string, prefix: string) => {
        const entries = await vfsService.readDir(projectId, dirPath);
        for (const entry of entries) {
          const entryPath = dirPath === '/' ? `/${entry.name}` : `${dirPath}/${entry.name}`;
          const zipPath = prefix ? `${prefix}/${entry.name}` : entry.name;

          if (entry.type === 'file') {
            const result = await vfsService.readFileWithMeta(projectId, entryPath);
            if (result.isBinary) {
              // Binary: content is base64
              const binary = atob(result.content);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
              }
              files[zipPath] = bytes;
            } else {
              // Text: encode as UTF-8
              const encoder = new TextEncoder();
              files[zipPath] = encoder.encode(result.content);
            }
          } else if (entry.type === 'dir') {
            await collectFiles(entryPath, zipPath);
          }
        }
      };

      const dirName = vfsService.getBasename(selectedPath) || 'root';
      await collectFiles(selectedPath, '');

      if (Object.keys(files).length === 0) {
        alert('Directory is empty');
        setIsOperating(false);
        return;
      }

      // Create ZIP using fflate
      zip(files, { level: 6 }, (err, data) => {
        setIsOperating(false);
        if (err) {
          console.debug('[VfsManagerView] Failed to create ZIP:', err);
          alert('Failed to create ZIP file');
          return;
        }

        // Download the ZIP (copy to new ArrayBuffer to satisfy TypeScript)
        const arrayBuffer = new ArrayBuffer(data.length);
        new Uint8Array(arrayBuffer).set(data);
        const blob = new Blob([arrayBuffer], { type: 'application/zip' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${dirName}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      });
    } catch (error) {
      setIsOperating(false);
      const msg = error instanceof Error ? error.message : 'Failed to download directory';
      alert(msg);
    }
  }, [projectId, selectedPath, selectedType]);

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

          {/* Directory actions (mobile) */}
          {selectedType === 'dir' && selectedPath && (
            <div className="border-t border-gray-200 bg-white p-4">
              <div className="flex flex-col gap-3">
                <div className="text-sm text-gray-600">
                  Selected:{' '}
                  <span className="font-medium">{vfsService.getBasename(selectedPath) || '/'}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                    onClick={handleCreateFile}
                    disabled={isOperating}
                  >
                    📄 New File
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                    onClick={handleCreateDirectory}
                    disabled={isOperating}
                  >
                    📁 New Folder
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-50"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isOperating}
                  >
                    ⬆️ Upload
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-purple-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-purple-700 disabled:opacity-50"
                    onClick={handleDownloadZip}
                    disabled={isOperating}
                  >
                    📦 Download ZIP
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                    onClick={handleDeleteDirectory}
                    disabled={isOperating}
                  >
                    🗑️ Delete
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Hidden file input for upload */}
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileUpload} />

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
                <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
                  <div className="flex flex-wrap justify-center gap-3">
                    <button
                      type="button"
                      className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                      onClick={handleCreateFile}
                      disabled={isOperating}
                    >
                      📄 New File
                    </button>
                    <button
                      type="button"
                      className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                      onClick={handleCreateDirectory}
                      disabled={isOperating}
                    >
                      📁 New Folder
                    </button>
                    <button
                      type="button"
                      className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-50"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isOperating}
                    >
                      ⬆️ Upload File
                    </button>
                  </div>
                  <div className="flex flex-wrap justify-center gap-3">
                    <button
                      type="button"
                      className="rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-700 disabled:opacity-50"
                      onClick={handleDownloadZip}
                      disabled={isOperating}
                    >
                      📦 Download ZIP
                    </button>
                    <button
                      type="button"
                      className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                      onClick={handleDeleteDirectory}
                      disabled={isOperating}
                    >
                      🗑️ Delete Directory
                    </button>
                  </div>
                  {isOperating && (
                    <div className="flex items-center gap-2 text-gray-500">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
                      <span className="text-sm">Processing...</span>
                    </div>
                  )}
                </div>
                {/* Hidden file input for upload (desktop) */}
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={handleFileUpload}
                />
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
