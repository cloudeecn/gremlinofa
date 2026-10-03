import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppActions } from './useApp';
import { useAlert } from './useAlert';
import type { Project } from '../../shared/protocol/types';
import { generateUniqueId } from '../../shared/protocol/idGenerator';

function buildNewProject(name: string): Project {
  const now = new Date();
  return {
    id: generateUniqueId('project'),
    name,
    icon: '📁',
    createdAt: now,
    lastUsedAt: now,
    systemPrompt: '',
    preFillResponse: '',
    apiDefinitionId: null, // User must configure
    modelId: null, // User must configure
    webSearchEnabled: false,
    temperature: null, // Use API-level default
    maxOutputTokens: 1536,
    enableReasoning: false,
    reasoningBudgetTokens: 1024,
    sendMessageMetadata: false,
    metadataTimestampMode: 'utc',
    metadataIncludeContextWindow: false,
    metadataIncludeCost: false,
  };
}

/**
 * Creates a project with the app defaults and opens it (Sidebar and home page).
 * `createProject` resolves true once the project is saved; an empty name or a
 * failed save alerts and resolves false, so the caller keeps its form open.
 */
export function useCreateProject() {
  const navigate = useNavigate();
  const { saveProject } = useAppActions();
  const { showAlert } = useAlert();
  const [isSaving, setIsSaving] = useState(false);

  const createProject = useCallback(
    async (name: string): Promise<boolean> => {
      const trimmedName = name.trim();
      if (!trimmedName) {
        await showAlert('Error', 'Project name cannot be empty');
        return false;
      }

      setIsSaving(true);
      try {
        const project = buildNewProject(trimmedName);
        await saveProject(project);
        navigate(`/project/${project.id}`);
        return true;
      } catch (error) {
        console.error('[useCreateProject] Error creating project:', error);
        void showAlert(
          'Project not created',
          error instanceof Error ? error.message : 'Failed to create project'
        );
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [saveProject, navigate, showAlert]
  );

  return { createProject, isSaving };
}
