import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useProject } from '../useProject';
import { generateUniqueId } from '../../../shared/protocol/idGenerator';
import * as alerts from '../../lib/alerts';
import type { Chat, Project } from '../../../shared/protocol/types';

// Mock app actions
const mockSaveProject = vi.fn();
const mockPatchProject = vi.fn();
const mockDeleteProject = vi.fn();

// Mock dependencies
vi.mock('../../client', () => ({
  gremlinClient: {
    getProject: vi.fn(),
    getChats: vi.fn(),
    saveChat: vi.fn(),
    deleteChat: vi.fn(),
  },
}));
vi.mock('../../../shared/protocol/idGenerator');
vi.mock('../../lib/alerts');
vi.mock('../useApp', () => ({
  useAppActions: () => ({
    saveProject: mockSaveProject,
    patchProject: mockPatchProject,
    deleteProject: mockDeleteProject,
  }),
}));

import { gremlinClient } from '../../client';

describe('useProject', () => {
  const mockProject: Project = {
    id: 'proj_123',
    name: 'Test Project',
    icon: '📁',
    createdAt: new Date('2024-01-01'),
    lastUsedAt: new Date('2024-01-01'),
    apiDefinitionId: 'api_123',
    modelId: 'gpt-4',
    systemPrompt: 'Test prompt',
    preFillResponse: '',
    webSearchEnabled: false,
    temperature: 1.0,
    maxOutputTokens: 2048,
    enableReasoning: false,
    reasoningBudgetTokens: 2048,
  };

  const mockChat: Chat = {
    id: 'chat_123',
    projectId: 'proj_123',
    name: 'Test Chat',
    createdAt: new Date('2024-01-01'),
    lastModifiedAt: new Date('2024-01-01'),
    apiDefinitionId: null,
    modelId: null,
    messageCount: 5,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    vi.mocked(gremlinClient.getProject).mockResolvedValue(mockProject);
    vi.mocked(gremlinClient.getChats).mockResolvedValue([mockChat]);
    vi.mocked(gremlinClient.saveChat).mockResolvedValue(undefined);
    vi.mocked(gremlinClient.deleteChat).mockResolvedValue(undefined);
    vi.mocked(generateUniqueId).mockReturnValue('chat_new_123');
    vi.mocked(alerts.showAlert).mockResolvedValue();
    // The backend's merged row: what is stored, plus the patch
    let stored = { ...mockProject };
    mockPatchProject.mockImplementation(async (_id: string, fields: Partial<Project>) => {
      stored = { ...stored, ...fields, lastUsedAt: new Date() };
      return stored;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Initial Loading', () => {
    it('should load project and chats on mount', async () => {
      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      expect(result.current.isLoading).toBe(true);

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.project).toEqual(mockProject);
      expect(result.current.chats).toEqual([mockChat]);
      expect(gremlinClient.getProject).toHaveBeenCalledWith('proj_123');
      expect(gremlinClient.getChats).toHaveBeenCalledWith('proj_123');
    });

    it('skips the chat list with withChats: false', async () => {
      const onChatsLoaded = vi.fn();
      const { result } = renderHook(() =>
        useProject({ projectId: 'proj_123', withChats: false, callbacks: { onChatsLoaded } })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.project).toEqual(mockProject);
      expect(result.current.chats).toEqual([]);
      expect(gremlinClient.getChats).not.toHaveBeenCalled();
      expect(onChatsLoaded).not.toHaveBeenCalled();
    });

    it('does not reload when the caller passes a new callbacks object each render', async () => {
      const { result, rerender } = renderHook(() =>
        useProject({ projectId: 'proj_123', callbacks: { onProjectLoaded: () => {} } })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
      rerender();
      rerender();

      expect(gremlinClient.getProject).toHaveBeenCalledTimes(1);
      expect(gremlinClient.getChats).toHaveBeenCalledTimes(1);
    });

    it('calls the latest callbacks, not the ones from the first render', async () => {
      let resolveProject: (project: Project) => void = () => {};
      vi.mocked(gremlinClient.getProject).mockReturnValue(
        new Promise(resolve => {
          resolveProject = resolve;
        })
      );
      const first = vi.fn();
      const latest = vi.fn();
      const { rerender } = renderHook(
        ({ onProjectLoaded }) =>
          useProject({ projectId: 'proj_123', callbacks: { onProjectLoaded } }),
        { initialProps: { onProjectLoaded: first } }
      );

      rerender({ onProjectLoaded: latest });
      resolveProject(mockProject);

      await waitFor(() => {
        expect(latest).toHaveBeenCalledWith('proj_123', mockProject);
      });
      expect(first).not.toHaveBeenCalled();
    });

    it('should call onProjectLoaded callback when project loads', async () => {
      const onProjectLoaded = vi.fn();

      renderHook(() =>
        useProject({
          projectId: 'proj_123',
          callbacks: { onProjectLoaded },
        })
      );

      await waitFor(() => {
        expect(onProjectLoaded).toHaveBeenCalledWith('proj_123', mockProject);
      });
    });

    it('should call onChatsLoaded callback when chats load', async () => {
      const onChatsLoaded = vi.fn();

      renderHook(() =>
        useProject({
          projectId: 'proj_123',
          callbacks: { onChatsLoaded },
        })
      );

      await waitFor(() => {
        expect(onChatsLoaded).toHaveBeenCalledWith('proj_123', [mockChat]);
      });
    });

    it('should handle project not found', async () => {
      vi.mocked(gremlinClient.getProject).mockResolvedValue(null);
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(consoleError).toHaveBeenCalled();
      expect(alerts.showAlert).toHaveBeenCalledWith('Error', 'Failed to load project data');

      consoleError.mockRestore();
    });

    it('should cancel loading when unmounted', async () => {
      const { unmount } = renderHook(() => useProject({ projectId: 'proj_123' }));

      unmount();

      // Wait a bit to ensure no state updates occur after unmount
      await new Promise(resolve => setTimeout(resolve, 10));
    });
  });

  describe('createNewChat', () => {
    it('should create new chat with message', async () => {
      const onChatCreated = vi.fn();
      const { result } = renderHook(() =>
        useProject({
          projectId: 'proj_123',
          callbacks: { onChatCreated },
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const newChat = await result.current.createNewChat('Hello world');

      expect(newChat).toMatchObject({
        id: 'chat_new_123',
        projectId: 'proj_123',
        name: 'Hello world',
      });
      // pendingState is no longer set on the chat — the project view fires
      // gremlinClient.startLoop directly after createNewChat returns.
      expect(newChat?.pendingState).toBeUndefined();

      expect(gremlinClient.saveChat).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'chat_new_123',
        })
      );

      expect(onChatCreated).toHaveBeenCalledWith('proj_123', newChat);

      // Wait for state update to reflect new chat in array
      await waitFor(() => {
        expect(result.current.chats).toContainEqual(newChat);
      });
    });

    it('should truncate long chat names to 50 characters', async () => {
      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const longMessage = 'A'.repeat(100);
      const newChat = await result.current.createNewChat(longMessage);

      expect(newChat?.name).toHaveLength(50);
      expect(newChat?.name).toBe('A'.repeat(50));
    });

    it('should support model override', async () => {
      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const newChat = await result.current.createNewChat('Test', 'api_456', 'claude-3');

      expect(newChat?.apiDefinitionId).toBe('api_456');
      expect(newChat?.modelId).toBe('claude-3');
    });

    it('should reject empty messages', async () => {
      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const newChat = await result.current.createNewChat('   ');

      expect(newChat).toBeNull();
      expect(alerts.showAlert).toHaveBeenCalledWith(
        'Error',
        'Please enter a message to start the chat'
      );
    });

    it('should reject when project not configured', async () => {
      const projectWithoutConfig: Project = {
        ...mockProject,
        apiDefinitionId: null,
        modelId: null,
      };
      vi.mocked(gremlinClient.getProject).mockResolvedValue(projectWithoutConfig);

      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const newChat = await result.current.createNewChat('Test');

      expect(newChat).toBeNull();
      expect(alerts.showAlert).toHaveBeenCalledWith(
        'Configuration Required',
        expect.stringContaining('select an API provider and model')
      );
    });

    it('should return null when no project loaded', async () => {
      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      // Call before project loads
      const newChat = await result.current.createNewChat('Test');

      expect(newChat).toBeNull();
    });

    it('should handle creation errors gracefully', async () => {
      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      vi.mocked(gremlinClient.saveChat).mockRejectedValueOnce(new Error('Save failed'));

      const newChat = await result.current.createNewChat('Test');

      expect(newChat).toBeNull();
      expect(alerts.showAlert).toHaveBeenCalledWith(
        'Error',
        'Failed to create chat. Please try again.'
      );
    });

    it('should set isCreatingChat during creation', async () => {
      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.isCreatingChat).toBe(false);

      const createPromise = result.current.createNewChat('Test');

      // Should be true during creation (but hard to test due to speed)
      // Just verify it returns to false after completion
      await createPromise;

      expect(result.current.isCreatingChat).toBe(false);
    });
  });

  describe('deleteChat', () => {
    it('should delete chat from gremlinClient and state', async () => {
      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.chats).toHaveLength(1);
      });

      await result.current.deleteChat('chat_123');

      expect(gremlinClient.deleteChat).toHaveBeenCalledWith('chat_123');

      // Wait for state update to reflect deleted chat
      await waitFor(() => {
        expect(result.current.chats).toHaveLength(0);
      });
    });

    it('should handle deletion errors', async () => {
      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      vi.mocked(gremlinClient.deleteChat).mockRejectedValueOnce(new Error('Delete failed'));

      await result.current.deleteChat('chat_123');

      expect(alerts.showAlert).toHaveBeenCalledWith('Error', 'Failed to delete chat');
    });

    it('keeps both of two quick updates', async () => {
      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // Same render, so both calls see the same `project`
      const { updateProject } = result.current;
      await Promise.all([updateProject({ name: 'Renamed' }), updateProject({ icon: '🦊' })]);

      await waitFor(() => {
        expect(result.current.project?.name).toBe('Renamed');
        expect(result.current.project?.icon).toBe('🦊');
      });
    });

    it('returns true once saved, and false with an alert when the save fails', async () => {
      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(await result.current.updateProject({ name: 'Saved' })).toBe(true);

      mockPatchProject.mockRejectedValueOnce(new Error('offline'));
      expect(await result.current.updateProject({ name: 'Lost' })).toBe(false);
      expect(alerts.showAlert).toHaveBeenCalledWith('Project not saved', 'offline');
      await waitFor(() => expect(result.current.project?.name).toBe('Saved'));
    });

    it('should do nothing when no project loaded', async () => {
      vi.mocked(gremlinClient.getProject).mockResolvedValue(null);

      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await result.current.deleteChat('chat_123');

      expect(gremlinClient.deleteChat).not.toHaveBeenCalled();
    });
  });

  describe('updateProject', () => {
    it('should update project with new values', async () => {
      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await result.current.updateProject({
        name: 'Updated Name',
        temperature: 0.7,
      });

      await waitFor(() => {
        // Surgical patch: only the changed fields are sent (+ touch), not the
        // whole project object.
        expect(mockPatchProject).toHaveBeenCalledWith(
          'proj_123',
          expect.objectContaining({
            name: 'Updated Name',
            temperature: 0.7,
          }),
          { touch: true }
        );
        expect(result.current.project?.name).toBe('Updated Name');
      });
    });

    it('should route cleared fields through unset so they cross the wire', async () => {
      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await result.current.updateProject({
        name: 'x',
        thinkingKeepTurns: undefined,
        pruneThinkingBeforeApiCall: undefined,
      });

      await waitFor(() => {
        expect(mockPatchProject).toHaveBeenCalledWith(
          'proj_123',
          expect.objectContaining({ name: 'x' }),
          {
            touch: true,
            unset: expect.arrayContaining(['thinkingKeepTurns', 'pruneThinkingBeforeApiCall']),
          }
        );
      });
    });

    it('should omit unset when no fields are cleared', async () => {
      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await result.current.updateProject({ name: 'Defined Only' });

      await waitFor(() => {
        expect(mockPatchProject).toHaveBeenCalledWith(
          'proj_123',
          expect.objectContaining({ name: 'Defined Only' }),
          { touch: true }
        );
      });
    });

    it('should update lastUsedAt timestamp', async () => {
      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const beforeUpdate = new Date();

      await result.current.updateProject({ name: 'New Name' });

      await waitFor(() => {
        expect(result.current.project?.lastUsedAt.getTime()).toBeGreaterThanOrEqual(
          beforeUpdate.getTime()
        );
      });
    });

    it('should do nothing when no project loaded', async () => {
      vi.mocked(gremlinClient.getProject).mockResolvedValue(null);

      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await result.current.updateProject({ name: 'New Name' });

      // Should not crash, just do nothing
    });
  });

  describe('deleteProject', () => {
    it('resolves only after app.deleteProject finishes', async () => {
      let finishDelete: () => void = () => {};
      mockDeleteProject.mockReturnValueOnce(
        new Promise<void>(resolve => {
          finishDelete = resolve;
        })
      );
      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let settled = false;
      const deleting = result.current.deleteProject().then(() => {
        settled = true;
      });
      expect(mockDeleteProject).toHaveBeenCalledWith('proj_123');
      await Promise.resolve();
      expect(settled).toBe(false);

      finishDelete();
      await deleting;
      expect(settled).toBe(true);
    });

    it('rejects when app.deleteProject fails', async () => {
      mockDeleteProject.mockRejectedValueOnce(new Error('Delete failed'));
      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await expect(result.current.deleteProject()).rejects.toThrow('Delete failed');
    });

    it('should do nothing when no project loaded', async () => {
      vi.mocked(gremlinClient.getProject).mockResolvedValue(null);

      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await result.current.deleteProject();

      // Should not crash
    });
  });

  describe('Operation identity', () => {
    it('keeps the same functions across renders and after the project loads', async () => {
      const { result, rerender } = renderHook(() => useProject({ projectId: 'proj_123' }));
      const initial = result.current;

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
      rerender();

      expect(result.current.createNewChat).toBe(initial.createNewChat);
      expect(result.current.deleteChat).toBe(initial.deleteChat);
      expect(result.current.updateProject).toBe(initial.updateProject);
      expect(result.current.deleteProject).toBe(initial.deleteProject);
    });

    it('a function captured before the project loaded sees the loaded project', async () => {
      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));
      const deleteChatFromFirstRender = result.current.deleteChat;

      await waitFor(() => {
        expect(result.current.project).not.toBeNull();
      });
      await deleteChatFromFirstRender('chat_123');

      expect(gremlinClient.deleteChat).toHaveBeenCalledWith('chat_123');
    });
  });

  describe('Effect cleanup and re-execution', () => {
    it('should reload when projectId changes', async () => {
      const { result, rerender } = renderHook(({ projectId }) => useProject({ projectId }), {
        initialProps: { projectId: 'proj_123' },
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(gremlinClient.getProject).toHaveBeenCalledWith('proj_123');

      // Change projectId
      const newProject = { ...mockProject, id: 'proj_456', name: 'New Project' };
      vi.mocked(gremlinClient.getProject).mockResolvedValue(newProject);
      vi.mocked(gremlinClient.getChats).mockResolvedValue([]);

      rerender({ projectId: 'proj_456' });

      await waitFor(() => {
        expect(gremlinClient.getProject).toHaveBeenCalledWith('proj_456');
      });

      await waitFor(() => {
        expect(result.current.project?.id).toBe('proj_456');
      });
    });
  });
});
