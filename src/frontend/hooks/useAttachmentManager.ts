/**
 * Hook for managing attachments - viewing, selecting, and deleting
 * Loads attachment sections grouped by chat, with lazy loading of image data
 */

import { useCallback, useRef, useState } from 'react';
import { gremlinClient } from '../client';
import type { AttachmentSection } from '../../shared/protocol/types';

export interface AttachmentWithData {
  id: string;
  messageId: string;
  timestamp: Date;
  mimeType: string;
  data: string; // base64
}

interface UseAttachmentManagerReturn {
  // State
  sections: AttachmentSection[];
  loadedData: Map<string, AttachmentWithData[]>;
  selectedIds: Set<string>;
  isLoading: boolean;
  error: string | null;

  // Actions
  loadSections: () => Promise<void>;
  loadSectionData: (chatId: string, messageIds: string[]) => Promise<void>;
  unloadSectionData: (chatId: string) => void;
  toggleSelection: (attachmentId: string) => void;
  selectAllInSection: (chatId: string) => void;
  deselectAllInSection: (chatId: string) => void;
  clearSelection: () => void;
  deleteSelected: () => Promise<{ deleted: number; errors: string[] }>;
  deleteOlderThan: (days: number) => Promise<number>;
}

export function useAttachmentManager(): UseAttachmentManagerReturn {
  const [sections, setSections] = useState<AttachmentSection[]>([]);
  const [loadedData, setLoadedData] = useState<Map<string, AttachmentWithData[]>>(new Map());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bookkeeping for the lazy loader lives in refs so loadSectionData stays stable
  // and never reads a stale closure. `wanted`: sections currently in the observer's
  // buffer zone. `inFlight`: chatId -> token of the fetch that owns it; a reload
  // or unload makes older fetches' results fall on the floor. `loaded` mirrors
  // loadedData's keys.
  const sectionsRef = useRef<AttachmentSection[]>([]);
  const wantedRef = useRef(new Set<string>());
  const inFlightRef = useRef(new Map<string, object>());
  const loadedRef = useRef(new Set<string>());

  /**
   * Load all attachment sections (metadata only, no image data)
   */
  const loadSections = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const allSections = await gremlinClient.getAllAttachmentSections();
      sectionsRef.current = allSections;
      wantedRef.current.clear();
      inFlightRef.current.clear();
      loadedRef.current.clear();
      setSections(allSections);
      // Clear loaded data and selection when reloading sections
      setLoadedData(new Map());
      setSelectedIds(new Set());
    } catch (err) {
      console.error('[useAttachmentManager] Failed to load sections:', err);
      setError(err instanceof Error ? err.message : 'Failed to load attachments');
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Load attachment data for a specific section (decrypt and load images).
   * No-op while the section is loaded or already being fetched.
   */
  const loadSectionData = useCallback(async (chatId: string, messageIds: string[]) => {
    wantedRef.current.add(chatId);
    if (loadedRef.current.has(chatId) || inFlightRef.current.has(chatId)) return;

    const token = {};
    inFlightRef.current.set(chatId, token);
    const isStillWanted = () =>
      inFlightRef.current.get(chatId) === token && wantedRef.current.has(chatId);

    const section = sectionsRef.current.find(s => s.chatId === chatId);
    const timestamps = new Map(section?.attachments.map(att => [att.id, att.timestamp]));

    try {
      const attachmentsWithData: AttachmentWithData[] = [];
      for (const messageId of new Set(messageIds)) {
        const attachments = await gremlinClient.getAttachments(messageId);
        if (!isStillWanted()) {
          console.debug(
            '[useAttachmentManager] Dropping data for %s: unloaded or reloaded mid-fetch',
            chatId
          );
          return;
        }

        for (const att of attachments) {
          attachmentsWithData.push({
            id: att.id,
            messageId,
            timestamp: timestamps.get(att.id) ?? new Date(),
            mimeType: att.mimeType,
            data: att.data,
          });
        }
      }

      loadedRef.current.add(chatId);
      setLoadedData(prev => new Map(prev).set(chatId, attachmentsWithData));
    } catch (err) {
      console.error('[useAttachmentManager] Failed to load section data:', err);
    } finally {
      if (inFlightRef.current.get(chatId) === token) inFlightRef.current.delete(chatId);
    }
  }, []);

  /**
   * Unload attachment data for a specific section to free memory
   */
  const unloadSectionData = useCallback((chatId: string) => {
    wantedRef.current.delete(chatId);
    loadedRef.current.delete(chatId);
    setLoadedData(prev => {
      if (!prev.has(chatId)) return prev;
      const next = new Map(prev);
      next.delete(chatId);
      return next;
    });
  }, []);

  /**
   * Toggle selection of a single attachment
   */
  const toggleSelection = useCallback((attachmentId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(attachmentId)) {
        next.delete(attachmentId);
      } else {
        next.add(attachmentId);
      }
      return next;
    });
  }, []);

  /**
   * Select all attachments in a section
   */
  const selectAllInSection = useCallback(
    (chatId: string) => {
      const section = sections.find(s => s.chatId === chatId);
      if (!section) return;

      setSelectedIds(prev => {
        const next = new Set(prev);
        for (const att of section.attachments) {
          next.add(att.id);
        }
        return next;
      });
    },
    [sections]
  );

  /**
   * Deselect all attachments in a section
   */
  const deselectAllInSection = useCallback(
    (chatId: string) => {
      const section = sections.find(s => s.chatId === chatId);
      if (!section) return;

      setSelectedIds(prev => {
        const next = new Set(prev);
        for (const att of section.attachments) {
          next.delete(att.id);
        }
        return next;
      });
    },
    [sections]
  );

  /**
   * Clear all selections
   */
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  /**
   * Delete all selected attachments
   */
  const deleteSelected = useCallback(async () => {
    const errors: string[] = [];
    let deleted = 0;

    // Group selected attachments by message for batch update
    const messageAttachments = new Map<string, { chatId: string; attachmentIds: string[] }>();

    for (const section of sections) {
      for (const att of section.attachments) {
        if (selectedIds.has(att.id)) {
          const existing = messageAttachments.get(att.messageId);
          if (existing) {
            existing.attachmentIds.push(att.id);
          } else {
            messageAttachments.set(att.messageId, {
              chatId: section.chatId,
              attachmentIds: [att.id],
            });
          }
        }
      }
    }

    // Delete each attachment and update message's attachmentIds
    for (const [messageId, { chatId, attachmentIds }] of messageAttachments) {
      for (const attachmentId of attachmentIds) {
        try {
          await gremlinClient.deleteAttachment(attachmentId);
          deleted++;
        } catch (err) {
          console.error('[useAttachmentManager] Failed to delete attachment:', err);
          errors.push(`Failed to delete attachment ${attachmentId}`);
        }
      }

      // Get remaining attachment IDs for this message
      const section = sections.find(s => s.chatId === chatId);
      if (section) {
        const remainingIds = section.attachments
          .filter(att => att.messageId === messageId && !attachmentIds.includes(att.id))
          .map(att => att.id);

        try {
          await gremlinClient.updateMessageAttachmentIds(chatId, messageId, remainingIds);
        } catch (err) {
          console.error('[useAttachmentManager] Failed to update message attachmentIds:', err);
          errors.push(`Failed to update message ${messageId}`);
        }
      }
    }

    // Reload sections to reflect changes
    await loadSections();

    return { deleted, errors };
  }, [sections, selectedIds, loadSections]);

  /**
   * Delete all attachments older than specified number of days
   */
  const deleteOlderThan = useCallback(
    async (days: number): Promise<number> => {
      const result = await gremlinClient.deleteAttachmentsOlderThan(days);

      // Update message attachmentIds for affected messages
      for (const messageId of result.updatedMessageIds) {
        // Find the section and chat containing this message
        for (const section of sections) {
          const messageAttachments = section.attachments.filter(att => att.messageId === messageId);
          if (messageAttachments.length > 0) {
            // Calculate remaining attachment IDs (those not deleted)
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - days);

            const remainingIds = messageAttachments
              .filter(att => att.timestamp >= cutoffDate)
              .map(att => att.id);

            try {
              await gremlinClient.updateMessageAttachmentIds(
                section.chatId,
                messageId,
                remainingIds
              );
            } catch (err) {
              console.error('[useAttachmentManager] Failed to update message attachmentIds:', err);
            }
            break;
          }
        }
      }

      // Reload sections to reflect changes
      await loadSections();

      return result.deleted;
    },
    [sections, loadSections]
  );

  return {
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
  };
}
