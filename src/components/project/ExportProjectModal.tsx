/**
 * Modal for exporting a project as a .gremlin.json bundle.
 * Shows progress during export and a summary when done.
 */

import { useRef, useState } from 'react';
import Modal from '../ui/Modal';
import { exportProject, triggerProjectDownload } from '../../utils/projectExport';
import type { ExportProjectResult } from '../../utils/projectExport';

interface ExportProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
}

type ModalState = 'idle' | 'running' | 'done' | 'error';

function ExportProjectModalContent({
  onClose,
  projectId,
  projectName,
}: {
  onClose: () => void;
  projectId: string;
  projectName: string;
}) {
  const [state, setState] = useState<ModalState>('idle');
  const [filesLoaded, setFilesLoaded] = useState(0);
  const [totalFiles, setTotalFiles] = useState(0);
  const [result, setResult] = useState<ExportProjectResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortedRef = useRef(false);

  const handleExport = async () => {
    setState('running');
    setFilesLoaded(0);
    setTotalFiles(0);
    abortedRef.current = false;

    try {
      const exportResult = await exportProject(projectId, (loaded, total) => {
        if (abortedRef.current) return;
        setFilesLoaded(loaded);
        setTotalFiles(total);
      });

      if (abortedRef.current) return;

      triggerProjectDownload(exportResult.blob, projectName);
      setResult(exportResult);
      setState('done');
    } catch (err) {
      if (abortedRef.current) return;
      console.debug('[ExportProjectModal] Export failed:', err);
      setError(err instanceof Error ? err.message : 'Export failed');
      setState('error');
    }
  };

  return (
    <div className="rounded-lg bg-white p-6 shadow-xl">
      {state === 'done' && result != null ? (
        <div className="text-center">
          <div className="mb-4 text-4xl">✅</div>
          <h2 className="mb-2 text-lg font-semibold text-gray-900">Project Exported</h2>
          <div className="mb-4 space-y-1 text-sm text-gray-600">
            <p>
              {result.fileCount} file{result.fileCount !== 1 ? 's' : ''} exported
              {result.dirCount > 0 && (
                <>
                  , {result.dirCount} empty director{result.dirCount !== 1 ? 'ies' : 'y'}
                </>
              )}
            </p>
          </div>
          <div className="mb-4 rounded-lg bg-gray-50 px-4 py-3 text-xs text-gray-500">
            <p>
              Saved as <span className="font-mono">.gremlin.json</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg bg-blue-500 px-4 py-2 font-medium text-white hover:bg-blue-600"
          >
            Done
          </button>
        </div>
      ) : state === 'error' ? (
        <div className="text-center">
          <div className="mb-4 text-4xl">❌</div>
          <h2 className="mb-2 text-lg font-semibold text-gray-900">Export Failed</h2>
          <p className="mb-4 text-sm text-red-600">{error}</p>
          <button
            onClick={onClose}
            className="rounded-lg bg-gray-200 px-4 py-2 font-medium text-gray-700 hover:bg-gray-300"
          >
            Close
          </button>
        </div>
      ) : (
        <>
          <h2 className="mb-3 text-lg font-semibold text-gray-900">Export Project</h2>
          <div className="mb-4 space-y-2 text-sm text-gray-600">
            <p>
              Export &ldquo;{projectName}&rdquo; as a portable <code>.gremlin.json</code> file.
            </p>
            <p>Includes project settings and all VFS files. Chats are not exported.</p>
          </div>

          {state === 'running' && (
            <div className="mb-4 rounded-lg bg-gray-50 p-3">
              <div className="flex items-center gap-2 text-sm text-gray-700">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
                <span>
                  {totalFiles > 0
                    ? `Loading files... ${filesLoaded}/${totalFiles}`
                    : 'Preparing...'}
                </span>
              </div>
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-2 font-medium text-gray-700 hover:bg-gray-50"
              disabled={state === 'running'}
            >
              Cancel
            </button>
            <button
              onClick={handleExport}
              disabled={state === 'running'}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-500 px-4 py-2 font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state === 'running' ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  <span>Exporting...</span>
                </>
              ) : (
                <span>Export</span>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function ExportProjectModal({
  isOpen,
  onClose,
  projectId,
  projectName,
}: ExportProjectModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm">
      <ExportProjectModalContent
        key={String(isOpen)}
        onClose={onClose}
        projectId={projectId}
        projectName={projectName}
      />
    </Modal>
  );
}
