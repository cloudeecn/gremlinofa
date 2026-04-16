import { useApp } from './useApp';
import { useEffect, useState } from 'react';
import { gremlinClient } from '../client';
import type { APIDefinition, Chat, MessageAttachment, Project } from '../../shared/protocol/types';
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
  apiDefinitions?: APIDefinition[];
}

export interface UseProjectReturn {
  project: Project | null;
  chats: Chat[];
  isLoading: boolean;
  isCreatingChat: boolean;

  // Operations
  createNewChat: (
    message: string,
    apiDefId?: string | null,
    modelId?: string | null,
    attachments?: MessageAttachment[]
  ) => Promise<Chat | null>;
  deleteChat: (chatId: string) => Promise<void>;
  updateProject: (updates: Partial<Project>) => Promise<void>;
  deleteProject: () => Promise<void>;
}

export function useProject({ projectId, callbacks }: UseProjectProps): UseProjectReturn {
  const app = useApp();
  const [project, setProject] = useState<Project | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreatingChat, setIsCreatingChat] = useState(false);

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
        callbacks?.onProjectLoaded?.(projectId, loadedProject);

        // 2. Load chats
        const loadedChats = await gremlinClient.getChats(projectId);
        if (isCancelled) return;

        console.debug('[useProject] Chats loaded, count:', loadedChats.length);
        // messageCount backfill happens server-side now (see GremlinServer's
        // listChatsWithMessageCounts). The frontend just displays.
        setChats(loadedChats);
        callbacks?.onChatsLoaded?.(projectId, loadedChats);
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
  }, [projectId]);

  const createNewChat = async (
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
  };

  const deleteChat = async (chatId: string) => {
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
  };

  const updateProject = async (updates: Partial<Project>) => {
    if (!project) return;

    const updatedProject = {
      ...project,
      ...updates,
      lastUsedAt: new Date(),
    };

    try {
      await app.saveProject(updatedProject);
      console.debug('[useProject] Project updated');
      setProject(updatedProject);
      callbacks?.onProjectLoaded?.(project.id, updatedProject);
    } catch (error) {
      console.error('[useProject] Error updating project:', error);
      showAlert('Error', 'Failed to update project');
    }
  };

  const deleteProject = async () => {
    if (!project) return;
    app.deleteProject(projectId);
  };

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
