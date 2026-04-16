import { useState, useCallback } from 'react';
import Spinner from '../ui/Spinner';
import { useDraftPersistence, clearDraft } from '../../hooks/useDraftPersistence';
import type { VfsAdapter } from '../../../shared/protocol/types/vfs';

// Phase 1.8 leak fix: inlined `getBasename` so the React layer doesn't
// import from `src/lib/vfsPaths` (which becomes backend-only). Paths
// reaching this component are already normalized by the VFS adapter; the
// helper just trims the trailing slash + returns the last segment.
const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? '';

export interface VfsFileEditorProps {
  adapter: VfsAdapter;
  path: string;
  initialContent: string;
  onSave: () => void;
  onCancel: () => void;
}

export default function VfsFileEditor({
  adapter,
  path,
  initialContent,
  onSave,
  onCancel,
}: VfsFileEditorProps) {
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Draft context ID: encodedPath to handle "/" in paths
  const draftContextId = `vfs_${encodeURIComponent(path)}`;

  const isDirty = content !== initialContent;

  useDraftPersistence({
    place: 'vfs-editor',
    contextId: draftContextId,
    value: content,
    onChange: setContent,
  });

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);

    try {
      await adapter.writeFile(path, content);
      clearDraft('vfs-editor', draftContextId);
      onSave();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save file';
      setError(message);
      setSaving(false);
    }
  }, [adapter, path, content, draftContextId, onSave]);

  const handleCancel = useCallback(() => {
    clearDraft('vfs-editor', draftContextId);
    onCancel();
  }, [draftContextId, onCancel]);

  const filename = basename(path);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3">
        <div className="min-w-0 flex-1">
          <span className="truncate font-medium text-gray-900">{filename}</span>
          <span className="ml-2 text-sm text-gray-500">(editing)</span>
        </div>
      </div>

      {/* Draft warning banner */}
      {isDirty && (
        <div className="flex items-center justify-between border-b border-yellow-200 bg-yellow-50 px-4 py-2">
          <span className="text-sm text-yellow-800">Unsaved changes</span>
          <button
            type="button"
            onClick={() => {
              clearDraft('vfs-editor', draftContextId);
              setContent(initialContent);
            }}
            className="text-sm font-medium text-yellow-700 hover:text-yellow-900"
          >
            Revert
          </button>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2">
          <span className="text-red-600">⚠️</span>
          <span className="text-sm text-red-800">{error}</span>
        </div>
      )}

      {/* Editor area */}
      <div className="ios-scroll flex-1 overflow-y-auto overscroll-y-contain bg-gray-50 p-4">
        <textarea
          className="ios-scroll h-full min-h-[300px] w-full resize-none overflow-y-auto overscroll-y-contain rounded border border-gray-300 bg-white p-3 font-mono text-base text-gray-800 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          value={content}
          onChange={e => setContent(e.target.value)}
          disabled={saving}
          placeholder="Enter file content..."
          spellCheck={false}
        />
      </div>

      {/* Action buttons */}
      <div className="flex justify-end gap-3 border-t border-gray-200 bg-white px-4 py-3">
        <button
          type="button"
          className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
          onClick={handleCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
          onClick={handleSave}
          disabled={saving}
        >
          {saving && <Spinner size={14} colorClass="border-white" />}
          Save
        </button>
      </div>
    </div>
  );
}
