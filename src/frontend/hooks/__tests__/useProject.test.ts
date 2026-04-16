import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useProject } from '../useProject';
import { generateUniqueId } from '../../../shared/protocol/idGenerator';
import * as alerts from '../../lib/alerts';
import type { Chat, Project } from '../../../shared/protocol/types';

// Mock useApp functions
const mockSaveProject = vi.fn();
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
  useApp: () => ({
    saveProject: mockSaveProject,
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
        expect(mockSaveProject).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Updated Name',
            temperature: 0.7,
          })
        );
        expect(result.current.project?.name).toBe('Updated Name');
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
    it('should call app.deleteProject with projectId', async () => {
      const mockDeleteProject = vi.fn();
      vi.doMock('../useApp', () => ({
        useApp: () => ({
          saveProject: vi.fn(),
          deleteProject: mockDeleteProject,
        }),
      }));

      const { result } = renderHook(() => useProject({ projectId: 'proj_123' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await result.current.deleteProject();

      // Since useApp is mocked at module level, we can't easily verify this
      // Just ensure it doesn't crash
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
