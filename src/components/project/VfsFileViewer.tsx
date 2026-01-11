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
  isBinary: boolean;
  mime: string;
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
    isBinary: false,
    mime: 'text/plain',
  });

  const loadFile = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      const [result, meta] = await Promise.all([
        vfsService.readFileWithMeta(projectId, path),
        vfsService.getFileMeta(projectId, path),
      ]);

      setState({
        content: result.content,
        version: meta?.version ?? 1,
        loading: false,
        error: null,
        isBinary: result.isBinary,
        mime: result.mime,
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

  const handleDownload = useCallback(() => {
    // content is base64 for binary files
    const dataUrl = `data:${state.mime};base64,${state.content}`;
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [state.content, state.mime, filename]);

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
        onEdit={state.isBinary ? undefined : onEdit}
        onDiff={state.isBinary ? undefined : onDiff}
        onDelete={onDelete}
        onDownload={state.isBinary ? handleDownload : undefined}
        isBinary={state.isBinary}
        mime={state.mime}
      />

      {/* Content area */}
      <div className="flex-1 overflow-auto bg-gray-50 p-4">
        {state.isBinary ? (
          <BinaryFileView
            mime={state.mime}
            content={state.content}
            filename={filename}
            onDownload={handleDownload}
          />
        ) : (
          <pre className="font-mono text-sm break-words whitespace-pre-wrap text-gray-800">
            {state.content || <span className="text-gray-400 italic">(empty file)</span>}
          </pre>
        )}
      </div>
    </div>
  );
}

interface HeaderProps {
  filename: string;
  version: number | null;
  onClose?: () => void;
  onEdit?: () => void;
  onDiff?: () => void;
  onDelete: () => void;
  onDownload?: () => void;
  isBinary?: boolean;
  mime?: string;
  disabled?: boolean;
}

function Header({
  filename,
  version,
  onClose,
  onEdit,
  onDiff,
  onDelete,
  onDownload,
  isBinary,
  mime,
  disabled,
}: HeaderProps) {
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
          {isBinary && mime && (
            <span className="shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-600">
              {mime}
            </span>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-1">
        {onDownload && (
          <button
            type="button"
            className="rounded p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-blue-600 disabled:opacity-50"
            onClick={onDownload}
            disabled={disabled}
            title="Download file"
          >
            ⬇️
          </button>
        )}
        {onEdit && (
          <button
            type="button"
            className="rounded p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
            onClick={onEdit}
            disabled={disabled}
            title="Edit file"
          >
            ✏️
          </button>
        )}
        {onDiff && (
          <button
            type="button"
            className="rounded p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
            onClick={onDiff}
            disabled={disabled || (version !== null && version < 2)}
            title="View diff"
          >
            📊
          </button>
        )}
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

interface BinaryFileViewProps {
  mime: string;
  content: string; // base64
  filename: string;
  onDownload: () => void;
}

function BinaryFileView({ mime, content, filename, onDownload }: BinaryFileViewProps) {
  const isImage = mime.startsWith('image/');
  const dataUrl = `data:${mime};base64,${content}`;

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-8">
      {isImage ? (
        <img
          src={dataUrl}
          alt={filename}
          className="max-h-64 max-w-full rounded border border-gray-200 shadow-sm"
        />
      ) : (
        <div className="flex h-24 w-24 items-center justify-center rounded-lg bg-gray-200 text-4xl">
          📄
        </div>
      )}
      <div className="text-center">
        <p className="font-medium text-gray-900">{filename}</p>
        <p className="text-sm text-gray-500">{mime}</p>
      </div>
      <button
        type="button"
        className="rounded-lg bg-blue-500 px-4 py-2 text-white transition-colors hover:bg-blue-600"
        onClick={onDownload}
      >
        ⬇️ Download
      </button>
    </div>
  );
}
