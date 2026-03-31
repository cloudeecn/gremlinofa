/**
 * Modal for compacting a project's VFS — purges stale deleted nodes,
 * orphans, and prunes old file versions using tiered retention.
 */

import { useRef, useState } from 'react';
import Modal from '../ui/Modal';
import type { CompactResult } from '../../services/vfs';
import { useVfsAdapter } from '../../hooks/useVfsAdapter';
import { showDestructiveConfirm } from '../../utils/alerts';

interface CompactModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
}

type ModalState = 'idle' | 'running' | 'done' | 'error';

function CompactModalContent({ onClose, projectId }: { onClose: () => void; projectId: string }) {
  const [state, setState] = useState<ModalState>('idle');
  const [itemsProcessed, setItemsProcessed] = useState(0);
  const [result, setResult] = useState<CompactResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [purgeAllDeleted, setPurgeAllDeleted] = useState(false);
  const abortedRef = useRef(false);
  const adapter = useVfsAdapter(projectId);

  const handleCompact = async () => {
    if (!adapter) return;

    if (purgeAllDeleted) {
      const confirmed = await showDestructiveConfirm(
        'Purge All Deleted Files',
        'This will permanently remove ALL deleted files and orphans, including recently deleted ones. This cannot be undone.',
        'Purge All'
      );
      if (!confirmed) return;
    }

    setState('running');
    setItemsProcessed(0);
    abortedRef.current = false;

    try {
      const compactResult = await adapter.compactProject(
        progress => {
          if (abortedRef.current) return;
          setItemsProcessed(progress.current);
        },
        { purgeAllDeleted }
      );

      if (abortedRef.current) return;
      setResult(compactResult);
      setState('done');
    } catch (err) {
      if (abortedRef.current) return;
      console.debug('[CompactModal] Compact failed:', err);
      setError(err instanceof Error ? err.message : 'Compact failed');
      setState('error');
    }
  };

  const totalCleaned =
    result != null ? result.purgedNodes + result.purgedOrphans + result.prunedRevisions : 0;

  return (
    <div className="rounded-lg bg-white p-6 shadow-xl">
      {state === 'done' && result != null ? (
        <div className="text-center">
          <div className="mb-4 text-4xl">✅</div>
          <h2 className="mb-2 text-lg font-semibold text-gray-900">
            {totalCleaned > 0 ? 'Project Compacted' : 'Already Clean'}
          </h2>
          <div className="mb-4 space-y-1 text-sm text-gray-600">
            {result.purgedNodes > 0 && (
              <p>
                {result.purgedNodes} deleted node{result.purgedNodes !== 1 ? 's' : ''} purged
              </p>
            )}
            {result.purgedOrphans > 0 && (
              <p>
                {result.purgedOrphans} orphan{result.purgedOrphans !== 1 ? 's' : ''} purged
              </p>
            )}
            {result.prunedRevisions > 0 && (
              <p>
                {result.prunedRevisions} revision{result.prunedRevisions !== 1 ? 's' : ''} pruned
                across {result.collapsedFiles} file{result.collapsedFiles !== 1 ? 's' : ''}
              </p>
            )}
            {totalCleaned === 0 && <p>No stale data found.</p>}
          </div>
          {/* Post-compact summary */}
          <div className="mb-4 rounded-lg bg-gray-50 px-4 py-3 text-left text-xs text-gray-500">
            <p>
              {result.treeNodes} tree node{result.treeNodes !== 1 ? 's' : ''} &middot;{' '}
              {result.fileCount} file{result.fileCount !== 1 ? 's' : ''} &middot;{' '}
              {result.totalRevisions} revision{result.totalRevisions !== 1 ? 's' : ''}
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
          <h2 className="mb-2 text-lg font-semibold text-gray-900">Compact Failed</h2>
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
          <h2 className="mb-3 text-lg font-semibold text-gray-900">Compact Project</h2>
          <div className="mb-4 space-y-2 text-sm text-gray-600">
            <p>Cleans up stale VFS data to reclaim storage:</p>
            <ul className="ml-4 list-disc space-y-1">
              <li>Purge deleted files and orphans older than 1 week</li>
              <li>
                Prune revision history — keeps all revisions from the last 24h, hourly snapshots for
                3 days, daily for 30 days, weekly for 1 year
              </li>
            </ul>
          </div>

          <label className="mb-4 flex cursor-pointer items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
            <input
              type="checkbox"
              checked={purgeAllDeleted}
              onChange={e => setPurgeAllDeleted(e.target.checked)}
              disabled={state === 'running'}
              className="mt-0.5 accent-red-600"
            />
            <span className="text-sm text-red-700">
              Purge <strong>all</strong> deleted files (skip 1-week grace period)
            </span>
          </label>

          {state === 'running' && (
            <div className="mb-4 rounded-lg bg-gray-50 p-3">
              <div className="flex items-center gap-2 text-sm text-gray-700">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
                <span>{itemsProcessed} items processed</span>
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
              onClick={handleCompact}
              disabled={state === 'running'}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-500 px-4 py-2 font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state === 'running' ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  <span>Compacting...</span>
                </>
              ) : (
                <span>Compact</span>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function CompactModal({ isOpen, onClose, projectId }: CompactModalProps) {
  // key={isOpen} forces remount when modal reopens, resetting all state
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm">
      <CompactModalContent key={String(isOpen)} onClose={onClose} projectId={projectId} />
    </Modal>
  );
}
