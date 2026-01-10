import { useState, useEffect, useCallback } from 'react';
import * as vfsService from '../../services/vfs/vfsService';
import { getBasename } from '../../services/vfs/vfsService';

export interface VfsFileViewerProps {
  projectId: string;
  path: string;
  onEdit: () => void;
  onDiff: () => void;
  onDelete: () => void;
  onClose?: () => void; // Mobile only
}

interface FileState {
  content: string;
  version: number;
  loading: boolean;
  error: string | null;
}

export default function VfsFileViewer({
  projectId,
  path,
  onEdit,
  onDiff,
  onDelete,
  onClose,
}: VfsFileViewerProps) {
  const [state, setState] = useState<FileState>({
    content: '',
    version: 0,
    loading: true,
    error: null,
  });

  const loadFile = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      const [content, meta] = await Promise.all([
        vfsService.readFile(projectId, path),
        vfsService.getFileMeta(projectId, path),
      ]);

      setState({
        content,
        version: meta?.version ?? 1,
        loading: false,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load file';
      setState(prev => ({
        ...prev,
        loading: false,
        error: message,
      }));
    }
  }, [projectId, path]);

  // Load file on mount/path change (deferred to avoid synchronous setState in effect)
  useEffect(() => {
    const timer = setTimeout(() => {
      loadFile();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadFile]);

  const filename = getBasename(path);

  if (state.loading) {
    return (
      <div className="flex h-full flex-col">
        <Header
          filename={filename}
          version={null}
          onClose={onClose}
          onEdit={onEdit}
          onDiff={onDiff}
          onDelete={onDelete}
          disabled
        />
        <div className="flex flex-1 items-center justify-center">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="flex h-full flex-col">
        <Header
          filename={filename}
          version={null}
          onClose={onClose}
          onEdit={onEdit}
          onDiff={onDiff}
          onDelete={onDelete}
          disabled
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4">
          <span className="text-red-500">⚠️</span>
          <p className="text-center text-sm text-gray-600">{state.error}</p>
          <button
            type="button"
            className="mt-2 text-sm text-blue-600 hover:underline"
            onClick={loadFile}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Header
        filename={filename}
        version={state.version}
        onClose={onClose}
        onEdit={onEdit}
        onDiff={onDiff}
        onDelete={onDelete}
      />

      {/* Content area */}
      <div className="flex-1 overflow-auto bg-gray-50 p-4">
        <pre className="font-mono text-sm break-words whitespace-pre-wrap text-gray-800">
          {state.content || <span className="text-gray-400 italic">(empty file)</span>}
        </pre>
      </div>
    </div>
  );
}

interface HeaderProps {
  filename: string;
  version: number | null;
  onClose?: () => void;
  onEdit: () => void;
  onDiff: () => void;
  onDelete: () => void;
  disabled?: boolean;
}

function Header({ filename, version, onClose, onEdit, onDiff, onDelete, disabled }: HeaderProps) {
  return (
    <div className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3">
      {/* Filename and version */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-gray-900">{filename}</span>
          {version !== null && (
            <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
              v{version}
            </span>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="rounded p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
          onClick={onEdit}
          disabled={disabled}
          title="Edit file"
        >
          ✏️
        </button>
        <button
          type="button"
          className="rounded p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
          onClick={onDiff}
          disabled={disabled || (version !== null && version < 2)}
          title="View diff"
        >
          📊
        </button>
        <button
          type="button"
          className="rounded p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-red-600 disabled:opacity-50"
          onClick={onDelete}
          disabled={disabled}
          title="Delete file"
        >
          🗑️
        </button>
        {onClose && (
          <button
            type="button"
            className="rounded p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
            onClick={onClose}
            title="Close"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
