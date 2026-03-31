import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useAlert } from '../../hooks/useAlert';
import { useVfsAdapter } from '../../hooks/useVfsAdapter';
import VfsDirectoryTree from './VfsDirectoryTree';
import VfsFileViewer from './VfsFileViewer';
import VfsFileEditor from './VfsFileEditor';
import VfsDiffViewer from './VfsDiffViewer';
import VfsFileModal from './VfsFileModal';
import { getBasename } from '../../services/vfs';
import { zip, unzip } from 'fflate';

export interface VfsManagerViewProps {
  projectId: string;
  initialPath?: string;
}

type DesktopMode = 'view' | 'edit' | 'diff';

export default function VfsManagerView({ projectId, initialPath }: VfsManagerViewProps) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { showDestructiveConfirm } = useAlert();
  const adapter = useVfsAdapter(projectId);

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

  // File upload input refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  // Loading state for operations
  const [isOperating, setIsOperating] = useState(false);

  // Handle initial path from URL deep link
  useEffect(() => {
    if (!initialPath || !adapter) return;

    const checkAndSelectPath = async () => {
      try {
        const isFileResult = await adapter.isFile(initialPath);
        if (isFileResult) {
          setSelectedPath(initialPath);
          setSelectedType('file');
          if (isMobile) {
            setMobileModalOpen(true);
          }
          return;
        }

        const isDirResult = await adapter.isDirectory(initialPath);
        if (isDirResult) {
          setSelectedPath(initialPath);
          setSelectedType('dir');
        }
      } catch (error) {
        console.debug('[VfsManagerView] Initial path check failed:', error);
      }
    };

    checkAndSelectPath();
  }, [initialPath, adapter, isMobile]);

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
    if (!selectedPath || !adapter) return;

    try {
      const content = await adapter.readFile(selectedPath);
      setEditInitialContent(content);
      setDesktopMode('edit');
    } catch (error) {
      console.debug('[VfsManagerView] Failed to load content for edit:', error);
    }
  }, [adapter, selectedPath]);

  // Desktop: Diff
  const handleDesktopDiff = useCallback(() => {
    setDesktopMode('diff');
  }, []);

  // Desktop: Delete file
  const handleDesktopDeleteFile = useCallback(async () => {
    if (!selectedPath || !adapter) return;

    const filename = getBasename(selectedPath);
    const confirmed = await showDestructiveConfirm(
      'Delete File',
      `Are you sure you want to delete "${filename}"? This file will be marked as deleted.`,
      'Delete'
    );

    if (confirmed) {
      try {
        await adapter.deleteFile(selectedPath);
        setSelectedPath(null);
        setSelectedType(null);
        setTreeKey(k => k + 1);
      } catch (error) {
        console.debug('[VfsManagerView] Failed to delete file:', error);
      }
    }
  }, [adapter, selectedPath, showDestructiveConfirm]);

  // Desktop: Delete directory (root cannot be deleted)
  const handleDeleteDirectory = useCallback(async () => {
    if (!selectedPath || !adapter || selectedType !== 'dir' || selectedPath === '/') return;

    const dirname = getBasename(selectedPath);
    const confirmed = await showDestructiveConfirm(
      'Delete Directory',
      `Are you sure you want to delete "${dirname}" and all its contents? This directory will be marked as deleted.`,
      'Delete'
    );

    if (confirmed) {
      try {
        await adapter.rmdir(selectedPath, true);
        setSelectedPath(null);
        setSelectedType(null);
        setTreeKey(k => k + 1);
      } catch (error) {
        console.debug('[VfsManagerView] Failed to delete directory:', error);
      }
    }
  }, [adapter, selectedPath, selectedType, showDestructiveConfirm]);

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
    if (!adapter) return;
    const dirPath = selectedPath && selectedType === 'dir' ? selectedPath : '/';
    const filename = prompt('Enter file name:');
    if (!filename || !filename.trim()) return;

    const filePath = dirPath === '/' ? `/${filename.trim()}` : `${dirPath}/${filename.trim()}`;

    try {
      await adapter.createFile(filePath, '');
      setTreeKey(k => k + 1);
      setSelectedPath(filePath);
      setSelectedType('file');
      setContentKey(k => k + 1);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to create file';
      alert(msg);
    }
  }, [adapter, selectedPath, selectedType]);

  // Create new directory
  const handleCreateDirectory = useCallback(async () => {
    if (!adapter) return;
    const dirPath = selectedPath && selectedType === 'dir' ? selectedPath : '/';
    const dirname = prompt('Enter directory name:');
    if (!dirname || !dirname.trim()) return;

    const newDirPath = dirPath === '/' ? `/${dirname.trim()}` : `${dirPath}/${dirname.trim()}`;

    try {
      await adapter.mkdir(newDirPath);
      setTreeKey(k => k + 1);
      setSelectedPath(newDirPath);
      setSelectedType('dir');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to create directory';
      alert(msg);
    }
  }, [adapter, selectedPath, selectedType]);

  // Upload file - detect UTF-8 or binary
  const handleFileUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file || !adapter) return;

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
          await adapter.writeFile(filePath, textContent);
        } else {
          await adapter.writeFile(filePath, buffer);
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
    [adapter, selectedPath, selectedType]
  );

  // Download directory as ZIP
  const handleDownloadZip = useCallback(async () => {
    if (!selectedPath || !adapter || selectedType !== 'dir') return;

    setIsOperating(true);
    try {
      // Collect all files recursively
      const files: Record<string, Uint8Array> = {};

      const collectFiles = async (dirPath: string, prefix: string) => {
        const entries = await adapter.readDir(dirPath);
        for (const entry of entries) {
          const entryPath = dirPath === '/' ? `/${entry.name}` : `${dirPath}/${entry.name}`;
          const zipPath = prefix ? `${prefix}/${entry.name}` : entry.name;

          if (entry.type === 'file') {
            const result = await adapter.readFileWithMeta(entryPath);
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

      const dirName = selectedPath === '/' ? 'vfs-root' : getBasename(selectedPath) || 'root';
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
  }, [adapter, selectedPath, selectedType]);

  // Upload ZIP - extract contents into selected directory
  const handleUploadZip = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file || !adapter) return;

      event.target.value = '';

      const dirPath = selectedPath && selectedType === 'dir' ? selectedPath : '/';

      setIsOperating(true);
      try {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        // Extract ZIP
        const extracted = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
          unzip(bytes, (err, data) => {
            if (err) reject(err);
            else resolve(data);
          });
        });

        const entries = Object.entries(extracted);
        if (entries.length === 0) {
          alert('ZIP file is empty');
          setIsOperating(false);
          return;
        }

        // Detect common root prefix (e.g. all files under "mydir/")
        const filePaths = entries.map(([p]) => p).filter(p => !p.endsWith('/'));
        let stripPrefix = '';
        if (filePaths.length > 0) {
          const firstSegments = filePaths.map(p => p.split('/')[0]);
          const candidate = firstSegments[0];
          if (firstSegments.every(s => s === candidate)) {
            // Check that this candidate is actually a directory prefix (has slash after it)
            if (filePaths.every(p => p.includes('/'))) {
              stripPrefix = candidate + '/';
            }
          }
        }

        // Sort: directories first, then files (shortest paths first)
        const dirEntries = entries
          .filter(([p]) => p.endsWith('/'))
          .sort((a, b) => a[0].length - b[0].length);
        const fileEntries = entries.filter(([p]) => !p.endsWith('/'));

        let failed = 0;

        // Create directories
        for (const [rawPath] of dirEntries) {
          let relPath =
            stripPrefix && rawPath.startsWith(stripPrefix)
              ? rawPath.slice(stripPrefix.length)
              : rawPath;
          relPath = relPath.replace(/\/+$/, ''); // remove trailing slash
          if (!relPath) continue;

          const fullPath = dirPath === '/' ? `/${relPath}` : `${dirPath}/${relPath}`;
          try {
            await adapter.mkdir(fullPath);
          } catch {
            // Directory may already exist
          }
        }

        // Write files
        for (const [rawPath, content] of fileEntries) {
          const relPath =
            stripPrefix && rawPath.startsWith(stripPrefix)
              ? rawPath.slice(stripPrefix.length)
              : rawPath;
          if (!relPath) continue;

          const fullPath = dirPath === '/' ? `/${relPath}` : `${dirPath}/${relPath}`;

          // Ensure parent directories exist
          const parentSegments = relPath.split('/').slice(0, -1);
          let parentPath = dirPath;
          for (const seg of parentSegments) {
            parentPath = parentPath === '/' ? `/${seg}` : `${parentPath}/${seg}`;
            try {
              await adapter.mkdir(parentPath);
            } catch {
              // Already exists
            }
          }

          try {
            // Detect text vs binary
            let isText = false;
            let textContent = '';
            try {
              const decoder = new TextDecoder('utf-8', { fatal: true });
              textContent = decoder.decode(content);
              isText = true;
            } catch {
              isText = false;
            }

            if (isText) {
              await adapter.writeFile(fullPath, textContent);
            } else {
              await adapter.writeFile(fullPath, content.buffer as ArrayBuffer);
            }
          } catch {
            failed++;
          }
        }

        setTreeKey(k => k + 1);

        if (failed > 0) {
          alert(
            `Extracted ${fileEntries.length - failed}/${fileEntries.length} files. ${failed} failed.`
          );
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Failed to extract ZIP';
        alert(msg);
      } finally {
        setIsOperating(false);
      }
    },
    [adapter, selectedPath, selectedType]
  );

  if (!adapter) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-gray-50">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-gray-50">
      {/* Header with safe area */}
      <div className="border-b border-gray-200 bg-white">
        <div className="safe-area-inset-top" />
        <div className="flex h-14 items-center px-4">
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
            adapter={adapter}
            selectedPath={selectedPath}
            initialPath={initialPath}
            refreshToken={treeKey}
            onSelectFile={handleSelectFile}
            onSelectDir={handleSelectDir}
          />

          {/* Directory actions (mobile) */}
          {selectedType === 'dir' && selectedPath && (
            <div className="border-t border-gray-200 bg-white p-4">
              <div className="flex flex-col gap-3">
                <div className="text-sm text-gray-600">
                  Selected: <span className="font-medium">{getBasename(selectedPath) || '/'}</span>
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
                    className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
                    onClick={() => zipInputRef.current?.click()}
                    disabled={isOperating}
                  >
                    📦 Upload ZIP
                  </button>
                  {selectedPath !== '/' && (
                    <button
                      type="button"
                      className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                      onClick={handleDeleteDirectory}
                      disabled={isOperating}
                    >
                      🗑️ Delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Mobile modal */}
          {selectedPath && selectedType === 'file' && (
            <VfsFileModal
              adapter={adapter}
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
              adapter={adapter}
              selectedPath={selectedPath}
              initialPath={initialPath}
              refreshToken={treeKey}
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
                    {getBasename(selectedPath) || '/'}
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
                      className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
                      onClick={() => zipInputRef.current?.click()}
                      disabled={isOperating}
                    >
                      📦 Upload ZIP
                    </button>
                    {selectedPath !== '/' && (
                      <button
                        type="button"
                        className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                        onClick={handleDeleteDirectory}
                        disabled={isOperating}
                      >
                        🗑️ Delete Directory
                      </button>
                    )}
                  </div>
                  {isOperating && (
                    <div className="flex items-center gap-2 text-gray-500">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
                      <span className="text-sm">Processing...</span>
                    </div>
                  )}
                </div>
              </div>
            ) : desktopMode === 'view' ? (
              <VfsFileViewer
                key={`view-${contentKey}`}
                adapter={adapter}
                path={selectedPath}
                onEdit={handleDesktopEdit}
                onDiff={handleDesktopDiff}
                onDelete={handleDesktopDeleteFile}
              />
            ) : desktopMode === 'edit' ? (
              <VfsFileEditor
                adapter={adapter}
                path={selectedPath}
                initialContent={editInitialContent}
                onSave={handleDesktopSave}
                onCancel={handleDesktopCancel}
              />
            ) : (
              <VfsDiffViewer
                adapter={adapter}
                path={selectedPath}
                onRollback={handleDesktopRollback}
                onClose={handleDesktopDiffClose}
              />
            )}
          </div>
        </div>
      )}

      {/* Hidden file inputs for upload (shared between mobile and desktop) */}
      <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileUpload} />
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={handleUploadZip}
      />
    </div>
  );
}
