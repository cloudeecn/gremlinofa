import { useAppActions } from './useApp';
import { useEffect, useState } from 'react';
import { useStableCallback } from './useStableCallback';
import { gremlinClient } from '../client';
import type { Chat, MessageAttachment, Project } from '../../shared/protocol/types';
import { generateUniqueId } from '../../shared/protocol/idGenerator';
import { showAlert } from '../lib/alerts';

export interface UseProjectCallbacks {
  onProjectLoaded?: (projectId: string, project: Project) => void;
  onChatsLoaded?: (projectId: string, chats: Chat[]) => void;
  onChatCreated?: (projectId: string, chat: Chat) => void;
}

export interface UseProjectProps {
  projectId: string;
  callbacks?: UseProjectCallbacks;
  /** Load the project's chat list too (default true). Settings only needs the project. */
  withChats?: boolean;
}

export interface UseProjectReturn {
  project: Project | null;
  chats: Chat[];
  isLoading: boolean;
  isCreatingChat: boolean;

  // Operations. Their identities are stable across renders, so they can be
  // handed to memoized children; each reads the project from the last commit.
  createNewChat: (
    message: string,
    apiDefId?: string | null,
    modelId?: string | null,
    attachments?: MessageAttachment[]
  ) => Promise<Chat | null>;
  deleteChat: (chatId: string) => Promise<void>;
  /**
   * Patch the given fields and adopt the merged project the backend returns.
   * Resolves false (after alerting) when the save failed.
   */
  updateProject: (updates: Partial<Project>) => Promise<boolean>;
  /** Rejects when the backend delete fails. */
  deleteProject: () => Promise<void>;
}

export function useProject({
  projectId,
  callbacks,
  withChats = true,
}: UseProjectProps): UseProjectReturn {
  const app = useAppActions();
  const [project, setProject] = useState<Project | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreatingChat, setIsCreatingChat] = useState(false);

  // Callers pass `callbacks` inline, so its identity changes every render.
  // Stable wrappers keep the load effect keyed on what it actually loads.
  const notifyProjectLoaded = useStableCallback((id: string, loaded: Project) =>
    callbacks?.onProjectLoaded?.(id, loaded)
  );
  const notifyChatsLoaded = useStableCallback((id: string, loaded: Chat[]) =>
    callbacks?.onChatsLoaded?.(id, loaded)
  );

  // Single sequential loading effect to avoid race conditions
  useEffect(() => {
    let isCancelled = false;

    const loadProjectData = async () => {
      console.debug('[useProject] Starting load sequence for:', projectId);
      setIsLoading(true);

      try {
        // 1. Load project
        const loadedProject = await gremlinClient.getProject(projectId);
        if (!loadedProject) {
          throw new Error(`Project not found: ${projectId}`);
        }
        if (isCancelled) return;

        console.debug('[useProject] Project loaded:', loadedProject.name);
        setProject(loadedProject);
        notifyProjectLoaded(projectId, loadedProject);

        if (!withChats) return;

        // 2. Load chats
        const loadedChats = await gremlinClient.getChats(projectId);
        if (isCancelled) return;

        console.debug('[useProject] Chats loaded, count:', loadedChats.length);
        // messageCount backfill happens server-side now (see GremlinServer's
        // listChatsWithMessageCounts). The frontend just displays.
        setChats(loadedChats);
        notifyChatsLoaded(projectId, loadedChats);
      } catch (error) {
        console.error('[useProject] Error loading project data:', error);
        if (!isCancelled) {
          showAlert('Error', 'Failed to load project data');
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    };

    loadProjectData();

    return () => {
      isCancelled = true;
    };
  }, [projectId, withChats, notifyProjectLoaded, notifyChatsLoaded]);

  const createNewChat = useStableCallback(
    async (
      message: string,
      apiDefId?: string | null,
      modelId?: string | null,
      attachments?: MessageAttachment[]
    ): Promise<Chat | null> => {
      if (!project) {
        console.warn('[useProject.createNewChat] No project loaded');
        return null;
      }

      // Validation: Check if API and model are configured
      if (!project.apiDefinitionId || !project.modelId) {
        showAlert(
          'Configuration Required',
          'Please select an API provider and model for this project before starting a chat.'
        );
        return null;
      }

      const messageText = message.trim();
      if (!messageText && !attachments?.length) {
        showAlert('Error', 'Please enter a message to start the chat');
        return null;
      }

      setIsCreatingChat(true);

      try {
        // Create the chat shell. The first user message + agentic loop are
        // started by ProjectView via `gremlinClient.startLoop` *after* this
        // returns — see the "project view starts a chat by calling backend
        // and then attaches" flow. The chat itself has no pending state to
        // resolve; the backend persists the message + drives the loop, and
        // chat-view's `attachChat` picks up the live event stream.
        const newChat: Chat = {
          id: generateUniqueId('chat'),
          projectId: project.id,
          name: messageText.substring(0, 50),
          createdAt: new Date(),
          lastModifiedAt: new Date(),
          apiDefinitionId: apiDefId ?? null,
          modelId: modelId ?? null,
        };

        // Save chat
        await gremlinClient.saveChat(newChat);
        console.debug('[useProject] New chat created:', newChat.id);

        // Update local state
        setChats(prev => [newChat, ...prev]);
        callbacks?.onChatCreated?.(project.id, newChat);

        return newChat;
      } catch (error) {
        console.error('[useProject] Error creating chat:', error);
        showAlert('Error', 'Failed to create chat. Please try again.');
        return null;
      } finally {
        setIsCreatingChat(false);
      }
    }
  );

  const deleteChat = useStableCallback(async (chatId: string) => {
    if (!project) return;

    try {
      await gremlinClient.deleteChat(chatId);
      console.debug('[useProject] Chat deleted:', chatId);

      // Update local state
      setChats(prev => prev.filter(c => c.id !== chatId));
    } catch (error) {
      console.error('[useProject] Error deleting chat:', error);
      showAlert('Error', 'Failed to delete chat');
    }
  });

  const updateProject = useStableCallback(async (updates: Partial<Project>): Promise<boolean> => {
    if (!project) return false;

    try {
      // Patch only the changed fields (+ touch lastUsedAt) so edits made while
      // a loop runs in this project survive its final lastUsedAt bump.
      //
      // Optional fields cleared in the UI arrive as `undefined`. The wire (JSON
      // in server mode) drops undefined-valued keys, so a clear would be silently
      // preserved instead of applied. Route clears through `unset` — the same
      // discipline patchChat callers already follow.
      const unset = (Object.keys(updates) as (keyof Project)[]).filter(
        key => updates[key] === undefined
      );
      const merged = await app.patchProject(project.id, updates, {
        touch: true,
        ...(unset.length ? { unset } : {}),
      });
      console.debug('[useProject] Project updated');
      // The backend's row, not `{ ...project, ...updates }`: `project` is this
      // render's copy, so a second quick update would drop the first
      setProject(merged);
      notifyProjectLoaded(merged.id, merged);
      return true;
    } catch (error) {
      console.error('[useProject] Error updating project:', error);
      void showAlert(
        'Project not saved',
        error instanceof Error ? error.message : 'Failed to update project'
      );
      return false;
    }
  });

  const deleteProject = useStableCallback(async () => {
    if (!project) return;
    await app.deleteProject(projectId);
  });

  return {
    project,
    chats,
    isLoading,
    isCreatingChat,
    createNewChat,
    deleteChat,
    updateProject,
    deleteProject,
  };
}
