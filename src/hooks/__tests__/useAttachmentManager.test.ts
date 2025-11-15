import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAttachmentManager } from '../useAttachmentManager';
import { storage } from '../../services/storage';
import type { AttachmentSection, MessageAttachment } from '../../types';

// Mock storage
vi.mock('../../services/storage');

describe('useAttachmentManager', () => {
  const mockSections: AttachmentSection[] = [
    {
      chatId: 'chat_1',
      chatName: 'Chat One',
      chatTimestamp: new Date('2024-01-15'),
      projectId: 'proj_1',
      projectName: 'Project One',
      projectIcon: '📁',
      attachments: [
        { id: 'att_1', messageId: 'msg_1', timestamp: new Date('2024-01-10') },
        { id: 'att_2', messageId: 'msg_1', timestamp: new Date('2024-01-11') },
      ],
    },
    {
      chatId: 'chat_2',
      chatName: 'Chat Two',
      chatTimestamp: new Date('2024-01-10'),
      projectId: 'proj_1',
      projectName: 'Project One',
      projectIcon: '📁',
      attachments: [{ id: 'att_3', messageId: 'msg_2', timestamp: new Date('2024-01-05') }],
    },
  ];

  const mockAttachments: MessageAttachment[] = [
    { id: 'att_1', type: 'image', mimeType: 'image/jpeg', data: 'base64data1' },
    { id: 'att_2', type: 'image', mimeType: 'image/png', data: 'base64data2' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    vi.mocked(storage.getAllAttachmentSections).mockResolvedValue(mockSections);
    vi.mocked(storage.getAttachments).mockResolvedValue(mockAttachments);
    vi.mocked(storage.deleteAttachment).mockResolvedValue('msg_1');
    vi.mocked(storage.updateMessageAttachmentIds).mockResolvedValue();
    vi.mocked(storage.deleteAttachmentsOlderThan).mockResolvedValue({
      deleted: 0,
      updatedMessageIds: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Initial state', () => {
    it('should have empty initial state', () => {
      const { result } = renderHook(() => useAttachmentManager());

      expect(result.current.sections).toEqual([]);
      expect(result.current.loadedData.size).toBe(0);
      expect(result.current.selectedIds.size).toBe(0);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe('loadSections', () => {
    it('should load sections from storage', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      expect(storage.getAllAttachmentSections).toHaveBeenCalled();
      expect(result.current.sections).toEqual(mockSections);
      expect(result.current.isLoading).toBe(false);
    });

    it('should set isLoading to false after completion', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      // isLoading should be false after completion
      expect(result.current.isLoading).toBe(false);
      expect(result.current.sections).toHaveLength(2);
    });

    it('should handle errors', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      vi.mocked(storage.getAllAttachmentSections).mockRejectedValue(new Error('Storage error'));

      await act(async () => {
        await result.current.loadSections();
      });

      expect(result.current.error).toBe('Storage error');
      expect(result.current.isLoading).toBe(false);
    });

    it('should clear selections and loaded data on reload', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      // Load initial data
      await act(async () => {
        await result.current.loadSections();
      });

      // Add some selections
      act(() => {
        result.current.toggleSelection('att_1');
      });

      expect(result.current.selectedIds.size).toBe(1);

      // Reload - should clear selections
      await act(async () => {
        await result.current.loadSections();
      });

      expect(result.current.selectedIds.size).toBe(0);
    });
  });

  describe('loadSectionData', () => {
    it('should load attachment data for a section', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      // First load sections
      await act(async () => {
        await result.current.loadSections();
      });

      // Then load section data
      await act(async () => {
        await result.current.loadSectionData('chat_1', ['msg_1']);
      });

      expect(storage.getAttachments).toHaveBeenCalledWith('msg_1');
      expect(result.current.loadedData.has('chat_1')).toBe(true);

      const loadedData = result.current.loadedData.get('chat_1');
      expect(loadedData).toHaveLength(2);
      expect(loadedData?.[0].id).toBe('att_1');
      expect(loadedData?.[0].data).toBe('base64data1');
    });

    it('should skip if already loaded', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      await act(async () => {
        await result.current.loadSectionData('chat_1', ['msg_1']);
      });

      expect(storage.getAttachments).toHaveBeenCalledTimes(1);

      // Try loading again
      await act(async () => {
        await result.current.loadSectionData('chat_1', ['msg_1']);
      });

      // Should not call storage again
      expect(storage.getAttachments).toHaveBeenCalledTimes(1);
    });

    it('should dedupe message IDs', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      await act(async () => {
        await result.current.loadSectionData('chat_1', ['msg_1', 'msg_1', 'msg_1']);
      });

      // Should only call once despite duplicate IDs
      expect(storage.getAttachments).toHaveBeenCalledTimes(1);
    });
  });

  describe('toggleSelection', () => {
    it('should add attachment to selection', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      act(() => {
        result.current.toggleSelection('att_1');
      });

      expect(result.current.selectedIds.has('att_1')).toBe(true);
    });

    it('should remove attachment from selection when already selected', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      act(() => {
        result.current.toggleSelection('att_1');
      });

      expect(result.current.selectedIds.has('att_1')).toBe(true);

      act(() => {
        result.current.toggleSelection('att_1');
      });

      expect(result.current.selectedIds.has('att_1')).toBe(false);
    });
  });

  describe('selectAllInSection', () => {
    it('should select all attachments in a section', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      act(() => {
        result.current.selectAllInSection('chat_1');
      });

      expect(result.current.selectedIds.has('att_1')).toBe(true);
      expect(result.current.selectedIds.has('att_2')).toBe(true);
      expect(result.current.selectedIds.has('att_3')).toBe(false);
    });

    it('should do nothing for invalid section', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      act(() => {
        result.current.selectAllInSection('invalid_chat');
      });

      expect(result.current.selectedIds.size).toBe(0);
    });
  });

  describe('deselectAllInSection', () => {
    it('should deselect all attachments in a section', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      // Select all
      act(() => {
        result.current.selectAllInSection('chat_1');
        result.current.selectAllInSection('chat_2');
      });

      expect(result.current.selectedIds.size).toBe(3);

      // Deselect one section
      act(() => {
        result.current.deselectAllInSection('chat_1');
      });

      expect(result.current.selectedIds.has('att_1')).toBe(false);
      expect(result.current.selectedIds.has('att_2')).toBe(false);
      expect(result.current.selectedIds.has('att_3')).toBe(true);
    });
  });

  describe('clearSelection', () => {
    it('should clear all selections', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      act(() => {
        result.current.selectAllInSection('chat_1');
        result.current.selectAllInSection('chat_2');
      });

      expect(result.current.selectedIds.size).toBe(3);

      act(() => {
        result.current.clearSelection();
      });

      expect(result.current.selectedIds.size).toBe(0);
    });
  });

  describe('deleteSelected', () => {
    it('should delete selected attachments', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      act(() => {
        result.current.toggleSelection('att_1');
        result.current.toggleSelection('att_2');
      });

      let deleteResult: { deleted: number; errors: string[] } | undefined;

      await act(async () => {
        deleteResult = await result.current.deleteSelected();
      });

      expect(storage.deleteAttachment).toHaveBeenCalledWith('att_1');
      expect(storage.deleteAttachment).toHaveBeenCalledWith('att_2');
      expect(deleteResult?.deleted).toBe(2);
      expect(deleteResult?.errors).toHaveLength(0);
    });

    it('should update message attachmentIds after deletion', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      // Select only one of two attachments in same message
      act(() => {
        result.current.toggleSelection('att_1');
      });

      await act(async () => {
        await result.current.deleteSelected();
      });

      // Should update message with remaining attachment IDs
      expect(storage.updateMessageAttachmentIds).toHaveBeenCalledWith(
        'chat_1',
        'msg_1',
        ['att_2'] // Only att_2 remains
      );
    });

    it('should handle deletion errors', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      vi.mocked(storage.deleteAttachment).mockRejectedValue(new Error('Delete failed'));

      act(() => {
        result.current.toggleSelection('att_1');
      });

      let deleteResult: { deleted: number; errors: string[] } | undefined;

      await act(async () => {
        deleteResult = await result.current.deleteSelected();
      });

      expect(deleteResult?.deleted).toBe(0);
      expect(deleteResult?.errors).toHaveLength(1);
    });

    it('should reload sections after deletion', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      act(() => {
        result.current.toggleSelection('att_1');
      });

      vi.mocked(storage.getAllAttachmentSections).mockClear();

      await act(async () => {
        await result.current.deleteSelected();
      });

      // Should reload sections after deletion
      expect(storage.getAllAttachmentSections).toHaveBeenCalled();
    });
  });

  describe('Multiple operations', () => {
    it('should handle complex selection workflow', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      // Select all in section 1
      act(() => {
        result.current.selectAllInSection('chat_1');
      });
      expect(result.current.selectedIds.size).toBe(2);

      // Toggle one off
      act(() => {
        result.current.toggleSelection('att_1');
      });
      expect(result.current.selectedIds.size).toBe(1);
      expect(result.current.selectedIds.has('att_2')).toBe(true);

      // Select section 2
      act(() => {
        result.current.selectAllInSection('chat_2');
      });
      expect(result.current.selectedIds.size).toBe(2);

      // Clear all
      act(() => {
        result.current.clearSelection();
      });
      expect(result.current.selectedIds.size).toBe(0);
    });
  });

  describe('deleteOlderThan', () => {
    it('should call storage.deleteAttachmentsOlderThan with correct days', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      vi.mocked(storage.deleteAttachmentsOlderThan).mockResolvedValue({
        deleted: 5,
        updatedMessageIds: [],
      });

      let deletedCount: number | undefined;

      await act(async () => {
        deletedCount = await result.current.deleteOlderThan(7);
      });

      expect(storage.deleteAttachmentsOlderThan).toHaveBeenCalledWith(7);
      expect(deletedCount).toBe(5);
    });

    it('should update message attachmentIds for affected messages', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      // Mock deleting attachments that affect msg_1
      vi.mocked(storage.deleteAttachmentsOlderThan).mockResolvedValue({
        deleted: 1,
        updatedMessageIds: ['msg_1'],
      });

      await act(async () => {
        await result.current.deleteOlderThan(30);
      });

      // Should call updateMessageAttachmentIds for the affected message
      expect(storage.updateMessageAttachmentIds).toHaveBeenCalled();
    });

    it('should reload sections after deletion', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      vi.mocked(storage.getAllAttachmentSections).mockClear();
      vi.mocked(storage.deleteAttachmentsOlderThan).mockResolvedValue({
        deleted: 2,
        updatedMessageIds: [],
      });

      await act(async () => {
        await result.current.deleteOlderThan(14);
      });

      // Should reload sections after deletion
      expect(storage.getAllAttachmentSections).toHaveBeenCalled();
    });

    it('should return count of deleted attachments', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      vi.mocked(storage.deleteAttachmentsOlderThan).mockResolvedValue({
        deleted: 10,
        updatedMessageIds: ['msg_1', 'msg_2'],
      });

      let deletedCount: number | undefined;

      await act(async () => {
        deletedCount = await result.current.deleteOlderThan(90);
      });

      expect(deletedCount).toBe(10);
    });

    it('should handle zero deleted attachments', async () => {
      const { result } = renderHook(() => useAttachmentManager());

      await act(async () => {
        await result.current.loadSections();
      });

      vi.mocked(storage.deleteAttachmentsOlderThan).mockResolvedValue({
        deleted: 0,
        updatedMessageIds: [],
      });

      let deletedCount: number | undefined;

      await act(async () => {
        deletedCount = await result.current.deleteOlderThan(1);
      });

      expect(deletedCount).toBe(0);
      // Should still reload sections
      expect(storage.getAllAttachmentSections).toHaveBeenCalled();
    });
  });
});
