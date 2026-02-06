/**
 * Modal for deleting attachments older than a specified number of days
 */

import { useEffect, useMemo, useState } from 'react';
import Modal from './ui/Modal';
import type { AttachmentSection } from '../types';

interface DeleteOlderThanModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDelete: (days: number) => Promise<number>;
  sections: AttachmentSection[];
}

export default function DeleteOlderThanModal({
  isOpen,
  onClose,
  onDelete,
  sections,
}: DeleteOlderThanModalProps) {
  const [days, setDays] = useState(7);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setDays(7);
      setIsDeleting(false);
      setDeleteResult(null);
      setError(null);
    }
  }, [isOpen]);

  // Calculate preview count based on days
  const previewCount = useMemo(() => {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    let count = 0;
    for (const section of sections) {
      for (const att of section.attachments) {
        if (att.timestamp < cutoffDate) {
          count++;
        }
      }
    }
    return count;
  }, [days, sections]);

  const handleDelete = async () => {
    setIsDeleting(true);
    setError(null);

    try {
      const deleted = await onDelete(days);
      setDeleteResult(deleted);
    } catch (err) {
      console.error('[DeleteOlderThanModal] Delete failed:', err);
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDaysChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value, 10);
    if (!isNaN(value) && value >= 1) {
      setDays(value);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm">
      <div className="rounded-lg bg-white p-6 shadow-xl">
        {deleteResult !== null ? (
          // Success state
          <div className="text-center">
            <div className="mb-4 text-4xl">✅</div>
            <h2 className="mb-2 text-lg font-semibold text-gray-900">
              {deleteResult > 0 ? 'Attachments Deleted' : 'No Attachments Deleted'}
            </h2>
            <p className="mb-4 text-gray-600">
              {deleteResult > 0
                ? `Successfully deleted ${deleteResult} attachment${deleteResult !== 1 ? 's' : ''}.`
                : 'No attachments were older than the specified date.'}
            </p>
            <button
              onClick={onClose}
              className="rounded-lg bg-blue-500 px-4 py-2 font-medium text-white hover:bg-blue-600"
            >
              Done
            </button>
          </div>
        ) : (
          // Input state
          <>
            <h2 className="mb-4 text-lg font-semibold text-gray-900">Delete Old Attachments</h2>

            <div className="mb-4">
              <label htmlFor="days-input" className="mb-2 block text-sm font-medium text-gray-700">
                Delete attachments older than
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="days-input"
                  type="number"
                  min="1"
                  value={days}
                  onChange={handleDaysChange}
                  className="w-20 rounded-lg border border-gray-300 px-3 py-2 text-center text-base focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                  disabled={isDeleting}
                />
                <span className="text-gray-600">day{days !== 1 ? 's' : ''}</span>
              </div>
            </div>

            <div className="mb-6 rounded-lg bg-gray-50 p-3">
              <p className="text-sm text-gray-600">
                {previewCount > 0 ? (
                  <>
                    <span className="font-semibold text-red-600">{previewCount}</span> attachment
                    {previewCount !== 1 ? 's' : ''} will be permanently deleted.
                  </>
                ) : (
                  <>No attachments are older than {days} days.</>
                )}
              </p>
            </div>

            {error && (
              <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</div>
            )}

            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2 font-medium text-gray-700 hover:bg-gray-50"
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={isDeleting || previewCount === 0}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-500 px-4 py-2 font-medium text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isDeleting ? (
                  <>
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    <span>Deleting...</span>
                  </>
                ) : (
                  <span>Delete</span>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
