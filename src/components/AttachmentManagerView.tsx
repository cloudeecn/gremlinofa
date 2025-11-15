/**
 * Attachment Manager View
 * Allows users to view and manage attachments grouped by chat
 */

import { useCallback, useEffect, useState } from 'react';
import { useAttachmentManager } from '../hooks/useAttachmentManager';
import { AttachmentSection } from './AttachmentSection';
import DeleteOlderThanModal from './DeleteOlderThanModal';

interface AttachmentManagerViewProps {
  onMenuPress?: () => void;
}

export function AttachmentManagerView({ onMenuPress }: AttachmentManagerViewProps) {
  const {
    sections,
    loadedData,
    selectedIds,
    isLoading,
    error,
    loadSections,
    loadSectionData,
    unloadSectionData,
    toggleSelection,
    selectAllInSection,
    deselectAllInSection,
    clearSelection,
    deleteSelected,
    deleteOlderThan,
  } = useAttachmentManager();

  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState<{ deleted: number; errors: string[] } | null>(
    null
  );
  const [isDeleteOlderModalOpen, setIsDeleteOlderModalOpen] = useState(false);

  // Load sections on mount
  useEffect(() => {
    loadSections();
  }, [loadSections]);

  // Handle section visibility change (load data when visible, unload when not)
  const handleSectionVisibilityChange = useCallback(
    (chatId: string, messageIds: string[], isVisible: boolean) => {
      if (isVisible) {
        loadSectionData(chatId, messageIds);
      } else {
        unloadSectionData(chatId);
      }
    },
    [loadSectionData, unloadSectionData]
  );

  // Handle delete selected
  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;

    setIsDeleting(true);
    setDeleteResult(null);

    try {
      const result = await deleteSelected();
      setDeleteResult(result);
    } catch (err) {
      console.error('[AttachmentManagerView] Delete failed:', err);
      setDeleteResult({
        deleted: 0,
        errors: [err instanceof Error ? err.message : 'Delete failed'],
      });
    } finally {
      setIsDeleting(false);
    }
  };

  // Calculate total attachment count
  const totalAttachments = sections.reduce((sum, section) => sum + section.attachments.length, 0);

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Header with safe area */}
      <div className="border-b border-gray-200 bg-white">
        <div className="safe-area-inset-top" />
        <div className="flex h-14 items-center px-4">
          {/* Mobile menu button */}
          {onMenuPress && (
            <button
              onClick={onMenuPress}
              className="-ml-2 flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-gray-100 md:hidden"
              aria-label="Open menu"
            >
              <span className="text-2xl text-gray-700">☰</span>
            </button>
          )}

          <h1 className="flex-1 text-center text-lg font-semibold text-gray-900">
            Manage Attachments
          </h1>

          {/* Delete older than button */}
          <button
            onClick={() => setIsDeleteOlderModalOpen(true)}
            className="rounded-lg bg-red-50 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={sections.length === 0 || isLoading}
          >
            Delete older...
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="ios-scroll scroll-safe-bottom min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
        {isLoading ? (
          // Loading state
          <div className="flex items-center justify-center p-8">
            <div className="text-center">
              <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-blue-500" />
              <p className="text-gray-600">Loading attachments...</p>
            </div>
          </div>
        ) : error ? (
          // Error state
          <div className="flex items-center justify-center p-8">
            <div className="text-center">
              <div className="mb-4 text-4xl">⚠️</div>
              <h2 className="mb-2 text-lg font-semibold text-gray-800">
                Error loading attachments
              </h2>
              <p className="mb-4 text-gray-600">{error}</p>
              <button
                onClick={loadSections}
                className="rounded-lg bg-blue-500 px-4 py-2 text-white hover:bg-blue-600"
              >
                Try again
              </button>
            </div>
          </div>
        ) : sections.length === 0 ? (
          // Empty state
          <div className="flex items-center justify-center p-8">
            <div className="text-center">
              <div className="mb-4 text-6xl">📎</div>
              <h2 className="mb-2 text-xl font-semibold text-gray-800">No attachments</h2>
              <p className="text-gray-600">
                Your chats don&apos;t have any image attachments yet.
                <br />
                Attachments will appear here after you send messages with images.
              </p>
            </div>
          </div>
        ) : (
          // Sections list
          <div className="pb-20">
            {/* Stats bar */}
            <div className="sticky top-0 z-20 border-b border-gray-200 bg-white px-4 py-2 text-sm text-gray-600">
              {totalAttachments} attachment{totalAttachments !== 1 ? 's' : ''} in {sections.length}{' '}
              chat{sections.length !== 1 ? 's' : ''}
            </div>

            {/* Sections */}
            {sections.map(section => (
              <AttachmentSection
                key={section.chatId}
                section={section}
                loadedData={loadedData.get(section.chatId)}
                selectedIds={selectedIds}
                onToggleSelection={toggleSelection}
                onSelectAll={() => selectAllInSection(section.chatId)}
                onDeselectAll={() => deselectAllInSection(section.chatId)}
                onVisibilityChange={isVisible =>
                  handleSectionVisibilityChange(
                    section.chatId,
                    section.attachments.map(a => a.messageId),
                    isVisible
                  )
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* Floating action bar when items selected */}
      {selectedIds.size > 0 && (
        <div className="absolute right-4 bottom-4 left-4 md:right-4 md:left-auto md:w-96">
          <div className="flex items-center justify-between rounded-lg bg-gray-900 px-4 py-3 shadow-lg">
            <div className="text-white">
              <span className="font-semibold">{selectedIds.size}</span>
              <span className="ml-1 text-gray-300">selected</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={clearSelection}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-300 hover:text-white"
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteSelected}
                disabled={isDeleting}
                className="flex items-center gap-2 rounded-lg bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
              >
                {isDeleting ? (
                  <>
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    <span>Deleting...</span>
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                    <span>Delete</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete result toast */}
      {deleteResult && (
        <div className="absolute right-4 bottom-4 left-4 md:right-4 md:left-auto md:w-96">
          <div
            className={`rounded-lg px-4 py-3 shadow-lg ${
              deleteResult.errors.length > 0 ? 'bg-yellow-500' : 'bg-green-500'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="text-white">
                {deleteResult.deleted > 0 && (
                  <span>
                    Deleted {deleteResult.deleted} attachment
                    {deleteResult.deleted !== 1 ? 's' : ''}
                  </span>
                )}
                {deleteResult.errors.length > 0 && (
                  <span className="ml-2">
                    ({deleteResult.errors.length} error{deleteResult.errors.length !== 1 ? 's' : ''}
                    )
                  </span>
                )}
              </div>
              <button
                onClick={() => setDeleteResult(null)}
                className="ml-2 rounded p-1 text-white/70 hover:text-white"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete older than modal */}
      <DeleteOlderThanModal
        isOpen={isDeleteOlderModalOpen}
        onClose={() => setIsDeleteOlderModalOpen(false)}
        onDelete={deleteOlderThan}
        sections={sections}
      />
    </div>
  );
}
