import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllDrafts,
  clearDraft,
  cleanupExpiredDrafts,
  DRAFT_EXPIRY_MS,
  useDraftPersistence,
} from '../useDraftPersistence';

describe('useDraftPersistence', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  describe('clearDraft', () => {
    it('should remove specific draft from localStorage', () => {
      const draftData = { content: 'test content', createdAt: Date.now() };
      localStorage.setItem('draft_chatview_chat1', JSON.stringify(draftData));
      localStorage.setItem('draft_chatview_chat2', JSON.stringify(draftData));

      clearDraft('chatview', 'chat1');

      expect(localStorage.getItem('draft_chatview_chat1')).toBeNull();
      expect(localStorage.getItem('draft_chatview_chat2')).not.toBeNull();
    });

    it('should not throw if draft does not exist', () => {
      expect(() => clearDraft('chatview', 'nonexistent')).not.toThrow();
    });
  });

  describe('clearAllDrafts', () => {
    it('should remove all draft entries from localStorage', () => {
      const draftData = { content: 'test', createdAt: Date.now() };
      localStorage.setItem('draft_chatview_chat1', JSON.stringify(draftData));
      localStorage.setItem('draft_project-chat_proj1', JSON.stringify(draftData));
      localStorage.setItem('draft_system-prompt-modal_proj2', JSON.stringify(draftData));
      localStorage.setItem('other_key', 'should remain');

      clearAllDrafts();

      expect(localStorage.getItem('draft_chatview_chat1')).toBeNull();
      expect(localStorage.getItem('draft_project-chat_proj1')).toBeNull();
      expect(localStorage.getItem('draft_system-prompt-modal_proj2')).toBeNull();
      expect(localStorage.getItem('other_key')).toBe('should remain');
    });

    it('should handle empty localStorage', () => {
      expect(() => clearAllDrafts()).not.toThrow();
    });
  });

  describe('cleanupExpiredDrafts', () => {
    it('should remove expired drafts', () => {
      const freshDraft = { content: 'fresh', createdAt: Date.now() };
      const expiredDraft = { content: 'expired', createdAt: Date.now() - DRAFT_EXPIRY_MS - 1000 };

      localStorage.setItem('draft_chatview_fresh', JSON.stringify(freshDraft));
      localStorage.setItem('draft_chatview_expired', JSON.stringify(expiredDraft));

      cleanupExpiredDrafts();

      expect(localStorage.getItem('draft_chatview_fresh')).not.toBeNull();
      expect(localStorage.getItem('draft_chatview_expired')).toBeNull();
    });

    it('should remove invalid draft entries', () => {
      localStorage.setItem('draft_chatview_invalid1', 'not json');
      localStorage.setItem('draft_chatview_invalid2', JSON.stringify({ wrong: 'structure' }));
      localStorage.setItem('draft_chatview_invalid3', JSON.stringify({ content: 123 }));

      cleanupExpiredDrafts();

      expect(localStorage.getItem('draft_chatview_invalid1')).toBeNull();
      expect(localStorage.getItem('draft_chatview_invalid2')).toBeNull();
      expect(localStorage.getItem('draft_chatview_invalid3')).toBeNull();
    });

    it('should not remove non-draft keys', () => {
      localStorage.setItem('other_key', 'value');

      cleanupExpiredDrafts();

      expect(localStorage.getItem('other_key')).toBe('value');
    });
  });

  describe('hook - saving drafts', () => {
    it('should save draft after debounce period', async () => {
      const onChange = vi.fn();
      const { rerender } = renderHook(
        ({ value }) =>
          useDraftPersistence({
            place: 'chatview',
            contextId: 'chat1',
            value,
            onChange,
          }),
        { initialProps: { value: '' } }
      );

      // Update value
      rerender({ value: 'hello world' });

      // Should not save immediately
      expect(localStorage.getItem('draft_chatview_chat1')).toBeNull();

      // Advance past debounce
      act(() => {
        vi.advanceTimersByTime(600);
      });

      const stored = localStorage.getItem('draft_chatview_chat1');
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored!);
      expect(parsed.content).toBe('hello world');
      expect(typeof parsed.createdAt).toBe('number');
    });

    it('should clear draft when value becomes empty', async () => {
      const onChange = vi.fn();
      const draftData = { content: 'existing', createdAt: Date.now() };
      localStorage.setItem('draft_chatview_chat1', JSON.stringify(draftData));

      const { rerender } = renderHook(
        ({ value }) =>
          useDraftPersistence({
            place: 'chatview',
            contextId: 'chat1',
            value,
            onChange,
          }),
        { initialProps: { value: 'existing' } }
      );

      // Clear value
      rerender({ value: '' });

      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(localStorage.getItem('draft_chatview_chat1')).toBeNull();
    });

    it('should not save when disabled', () => {
      const onChange = vi.fn();
      const { rerender } = renderHook(
        ({ value }) =>
          useDraftPersistence({
            place: 'chatview',
            contextId: 'chat1',
            value,
            onChange,
            enabled: false,
          }),
        { initialProps: { value: '' } }
      );

      rerender({ value: 'test content' });

      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(localStorage.getItem('draft_chatview_chat1')).toBeNull();
    });
  });

  describe('hook - restoring drafts', () => {
    it('should restore draft on mount', () => {
      const draftData = { content: 'saved draft', createdAt: Date.now() };
      localStorage.setItem('draft_chatview_chat1', JSON.stringify(draftData));

      const onChange = vi.fn();
      renderHook(() =>
        useDraftPersistence({
          place: 'chatview',
          contextId: 'chat1',
          value: '',
          onChange,
        })
      );

      expect(onChange).toHaveBeenCalledWith('saved draft');
    });

    it('should not restore expired draft', () => {
      const expiredDraft = { content: 'old draft', createdAt: Date.now() - DRAFT_EXPIRY_MS - 1000 };
      localStorage.setItem('draft_chatview_chat1', JSON.stringify(expiredDraft));

      const onChange = vi.fn();
      renderHook(() =>
        useDraftPersistence({
          place: 'chatview',
          contextId: 'chat1',
          value: '',
          onChange,
        })
      );

      expect(onChange).not.toHaveBeenCalled();
      expect(localStorage.getItem('draft_chatview_chat1')).toBeNull();
    });

    it('should not restore when disabled', () => {
      const draftData = { content: 'saved draft', createdAt: Date.now() };
      localStorage.setItem('draft_chatview_chat1', JSON.stringify(draftData));

      const onChange = vi.fn();
      renderHook(() =>
        useDraftPersistence({
          place: 'chatview',
          contextId: 'chat1',
          value: '',
          onChange,
          enabled: false,
        })
      );

      expect(onChange).not.toHaveBeenCalled();
    });

    it('should remove invalid draft entries on restore attempt', () => {
      localStorage.setItem('draft_chatview_chat1', 'invalid json');

      const onChange = vi.fn();
      renderHook(() =>
        useDraftPersistence({
          place: 'chatview',
          contextId: 'chat1',
          value: '',
          onChange,
        })
      );

      expect(onChange).not.toHaveBeenCalled();
      expect(localStorage.getItem('draft_chatview_chat1')).toBeNull();
    });
  });

  describe('hook - context changes', () => {
    it('should support multiple concurrent drafts', () => {
      const draft1 = { content: 'chat1 content', createdAt: Date.now() };
      const draft2 = { content: 'chat2 content', createdAt: Date.now() };
      localStorage.setItem('draft_chatview_chat1', JSON.stringify(draft1));
      localStorage.setItem('draft_chatview_chat2', JSON.stringify(draft2));

      const onChange1 = vi.fn();
      renderHook(() =>
        useDraftPersistence({
          place: 'chatview',
          contextId: 'chat1',
          value: '',
          onChange: onChange1,
        })
      );

      const onChange2 = vi.fn();
      renderHook(() =>
        useDraftPersistence({
          place: 'chatview',
          contextId: 'chat2',
          value: '',
          onChange: onChange2,
        })
      );

      expect(onChange1).toHaveBeenCalledWith('chat1 content');
      expect(onChange2).toHaveBeenCalledWith('chat2 content');
    });

    it('should support drafts in different places', () => {
      const chatDraft = { content: 'chat message', createdAt: Date.now() };
      const projectDraft = { content: 'project message', createdAt: Date.now() };
      localStorage.setItem('draft_chatview_id1', JSON.stringify(chatDraft));
      localStorage.setItem('draft_project-chat_id1', JSON.stringify(projectDraft));

      const chatOnChange = vi.fn();
      renderHook(() =>
        useDraftPersistence({
          place: 'chatview',
          contextId: 'id1',
          value: '',
          onChange: chatOnChange,
        })
      );

      const projectOnChange = vi.fn();
      renderHook(() =>
        useDraftPersistence({
          place: 'project-chat',
          contextId: 'id1',
          value: '',
          onChange: projectOnChange,
        })
      );

      expect(chatOnChange).toHaveBeenCalledWith('chat message');
      expect(projectOnChange).toHaveBeenCalledWith('project message');
    });
  });

  describe('hook - debouncing', () => {
    it('should debounce rapid value changes', () => {
      const onChange = vi.fn();
      const { rerender } = renderHook(
        ({ value }) =>
          useDraftPersistence({
            place: 'chatview',
            contextId: 'chat1',
            value,
            onChange,
          }),
        { initialProps: { value: '' } }
      );

      // Rapid changes
      rerender({ value: 'h' });
      rerender({ value: 'he' });
      rerender({ value: 'hel' });
      rerender({ value: 'hell' });
      rerender({ value: 'hello' });

      // Nothing saved yet
      expect(localStorage.getItem('draft_chatview_chat1')).toBeNull();

      // Advance past debounce
      act(() => {
        vi.advanceTimersByTime(600);
      });

      // Only final value saved
      const stored = localStorage.getItem('draft_chatview_chat1');
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!).content).toBe('hello');
    });

    it('should reset debounce timer on each change', () => {
      const onChange = vi.fn();
      const { rerender } = renderHook(
        ({ value }) =>
          useDraftPersistence({
            place: 'chatview',
            contextId: 'chat1',
            value,
            onChange,
          }),
        { initialProps: { value: '' } }
      );

      rerender({ value: 'first' });

      // Advance partially
      act(() => {
        vi.advanceTimersByTime(400);
      });

      // Still not saved
      expect(localStorage.getItem('draft_chatview_chat1')).toBeNull();

      // Another change resets timer
      rerender({ value: 'second' });

      // Advance another 400ms (total 800ms since last change = 400ms)
      act(() => {
        vi.advanceTimersByTime(400);
      });

      // Still not saved (only 400ms since last change)
      expect(localStorage.getItem('draft_chatview_chat1')).toBeNull();

      // Advance to trigger save
      act(() => {
        vi.advanceTimersByTime(200);
      });

      const stored = localStorage.getItem('draft_chatview_chat1');
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!).content).toBe('second');
    });
  });
});
