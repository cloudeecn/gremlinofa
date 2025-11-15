/**
 * Attachment Section Component
 * Displays a chat's attachments with virtual scroll loading
 * Uses IntersectionObserver to load/unload image data based on visibility
 */

import { useEffect, useRef } from 'react';
import type { AttachmentSection as AttachmentSectionType } from '../types';
import type { AttachmentWithData } from '../hooks/useAttachmentManager';

interface AttachmentSectionProps {
  section: AttachmentSectionType;
  loadedData: AttachmentWithData[] | undefined;
  selectedIds: Set<string>;
  onToggleSelection: (attachmentId: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onVisibilityChange: (isVisible: boolean) => void;
}

/**
 * Calculate relative time string from a date
 */
function getRelativeTimeString(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return 'Today';
  } else if (diffDays === 1) {
    return '1 day ago';
  } else {
    return `${diffDays} days ago`;
  }
}

export function AttachmentSection({
  section,
  loadedData,
  selectedIds,
  onToggleSelection,
  onSelectAll,
  onDeselectAll,
  onVisibilityChange,
}: AttachmentSectionProps) {
  const sectionRef = useRef<HTMLDivElement>(null);

  // Check if all attachments in this section are selected
  const allSelected = section.attachments.every(att => selectedIds.has(att.id));
  const someSelected = section.attachments.some(att => selectedIds.has(att.id));
  const selectedCount = section.attachments.filter(att => selectedIds.has(att.id)).length;

  // Set up IntersectionObserver for lazy loading/unloading
  useEffect(() => {
    const element = sectionRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      entries => {
        const entry = entries[0];
        // Notify parent of visibility change (both entering and leaving)
        onVisibilityChange(entry.isIntersecting);
      },
      {
        root: null,
        // Load/unload when section is 2 screen heights away
        rootMargin: '200% 0px',
        threshold: 0,
      }
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [onVisibilityChange]);

  // Create a map of loaded data by attachment ID for quick lookup
  const loadedDataMap = new Map(loadedData?.map(att => [att.id, att]) || []);
  const isLoading = !loadedData;

  // Calculate relative time from chat timestamp
  const relativeTime = getRelativeTimeString(section.chatTimestamp);

  return (
    <div ref={sectionRef} className="border-b border-gray-200 pb-4">
      {/* Section Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between bg-gray-50 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex-shrink-0 text-lg">{section.projectIcon}</span>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-gray-900">{section.chatName}</div>
            <div className="truncate text-xs text-gray-500">
              {section.projectName} · {relativeTime} · {section.attachments.length} attachment
              {section.attachments.length !== 1 ? 's' : ''}
            </div>
          </div>
        </div>

        {/* Select All Checkbox */}
        <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-600 hover:text-gray-900">
          <input
            type="checkbox"
            checked={allSelected}
            ref={input => {
              if (input) {
                input.indeterminate = someSelected && !allSelected;
              }
            }}
            onChange={() => {
              if (allSelected) {
                onDeselectAll();
              } else {
                onSelectAll();
              }
            }}
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span>{selectedCount > 0 ? `${selectedCount} selected` : 'Select all'}</span>
        </label>
      </div>

      {/* Attachment Grid */}
      <div className="px-4 pt-3">
        {isLoading ? (
          // Loading skeleton
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10">
            {section.attachments.map(att => (
              <div key={att.id} className="aspect-square animate-pulse rounded-lg bg-gray-100" />
            ))}
          </div>
        ) : (
          // Actual thumbnails
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10">
            {section.attachments.map(att => {
              const data = loadedDataMap.get(att.id);
              const isSelected = selectedIds.has(att.id);

              return (
                <button
                  key={att.id}
                  onClick={() => onToggleSelection(att.id)}
                  className={`relative aspect-square overflow-hidden rounded-lg focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 focus:outline-none ${isSelected ? 'ring-2 ring-blue-500 ring-offset-1' : 'hover:ring-2 hover:ring-gray-300'} `}
                  title={`Attachment from ${att.timestamp.toLocaleDateString()}`}
                >
                  {data ? (
                    <img
                      src={`data:${data.mimeType};base64,${data.data}`}
                      alt="Attachment"
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-gray-100">
                      <span className="text-xs text-gray-400">?</span>
                    </div>
                  )}

                  {/* Selection overlay */}
                  <div
                    className={`absolute inset-0 transition-colors ${isSelected ? 'bg-blue-500/20' : 'bg-transparent'} `}
                  />

                  {/* Checkbox */}
                  <div
                    className={`absolute top-1 left-1 flex h-5 w-5 items-center justify-center rounded-full transition-all ${
                      isSelected
                        ? 'bg-blue-500 text-white'
                        : 'bg-black/40 text-white/70 hover:bg-black/60'
                    } `}
                  >
                    {isSelected ? (
                      <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    ) : (
                      <div className="h-2 w-2 rounded-full border border-current" />
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
