import { useState, useEffect } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useApp } from '../hooks/useApp';
import { useAlert } from '../hooks/useAlert';
import type { Project } from '../types';
import { generateUniqueId } from '../utils/idGenerator';

interface SidebarProps {
  onClose?: () => void;
}

export default function Sidebar({ onClose }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { projects, saveProject } = useApp();
  const { showAlert } = useAlert();

  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [devAvailable, setDevAvailable] = useState(false);

  const baseUrl = import.meta.env.BASE_URL;
  const isDevMode = baseUrl.includes('/dev/');

  // Check if /dev/ is accessible (only in production mode)
  useEffect(() => {
    if (!isDevMode) {
      fetch('/dev/', { method: 'HEAD' })
        .then(res => setDevAvailable(res.ok))
        .catch(() => setDevAvailable(false));
    }
  }, [isDevMode]);

  // Extract selected projectId from current route
  const selectedProjectId = location.pathname.startsWith('/project/')
    ? location.pathname.split('/')[2]
    : null;

  const handleProjectSelect = (projectId: string) => {
    navigate(`/project/${projectId}`);
    onClose?.();
  };

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) {
      await showAlert('Error', 'Project name cannot be empty');
      return;
    }

    const newProject: Project = {
      id: generateUniqueId('project'),
      name: newProjectName.trim(),
      icon: '📁',
      createdAt: new Date(),
      lastUsedAt: new Date(),
      systemPrompt: '',
      preFillResponse: '',
      apiDefinitionId: null, // User must configure
      modelId: null, // User must configure
      webSearchEnabled: false,
      temperature: null, // Use API-level default
      maxOutputTokens: 2048,
      enableReasoning: false,
      reasoningBudgetTokens: 2048,
      // Message metadata defaults
      sendMessageMetadata: false,
      metadataTimestampMode: 'utc',
      metadataIncludeContextWindow: false,
      metadataIncludeCost: false,
    };

    await saveProject(newProject);
    setNewProjectName('');
    setIsCreatingProject(false);
    navigate(`/project/${newProject.id}`);
  };

  return (
    <div className="flex h-full w-full flex-col bg-gray-900 text-white">
      {/* Header */}
      <div className="border-b border-gray-700 p-4">
        <Link to="/" className="block hover:opacity-80" onClick={onClose}>
          <h1 className="text-sm leading-tight font-semibold">
            Gremlin Of The
            <br />
            Friday Afternoon
          </h1>
        </Link>
      </div>

      {/* Projects List */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-2">
          <div className="mb-2 px-2 py-1 text-xs font-medium text-gray-400">PROJECTS</div>
          {projects.length === 0 ? (
            <div className="px-2 py-4 text-sm text-gray-500">No projects yet</div>
          ) : (
            projects.map(project => (
              <div
                key={project.id}
                onClick={() => handleProjectSelect(project.id)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleProjectSelect(project.id);
                  }
                }}
                role="button"
                tabIndex={0}
                className={`mb-1 w-full cursor-pointer rounded-lg px-3 py-2 text-left transition-colors ${
                  selectedProjectId === project.id
                    ? 'bg-gray-700 text-white'
                    : 'text-gray-300 hover:bg-gray-800'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-lg">{project.icon}</span>
                  <span className="truncate text-sm">{project.name}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* New Project Form */}
      {isCreatingProject && (
        <div className="border-t border-gray-700 bg-gray-800 p-3">
          <input
            type="text"
            className="mb-2 w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-white placeholder-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
            placeholder="Project name"
            value={newProjectName}
            onChange={e => setNewProjectName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                handleCreateProject();
              } else if (e.key === 'Escape') {
                setIsCreatingProject(false);
                setNewProjectName('');
              }
            }}
            autoFocus
          />
          <div className="flex gap-2">
            <button
              onClick={() => {
                setIsCreatingProject(false);
                setNewProjectName('');
              }}
              className="flex-1 rounded-lg border border-gray-600 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              onClick={handleCreateProject}
              className="flex-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              Create
            </button>
          </div>
        </div>
      )}

      {/* Footer Actions */}
      <div className="safe-area-inset-bottom border-t border-gray-700 p-2">
        <button
          onClick={() => setIsCreatingProject(true)}
          className="w-full rounded-lg px-3 py-2 text-left text-sm text-gray-300 transition-colors hover:bg-gray-800"
        >
          + New Project
        </button>
        {/* Mode switching links */}
        {isDevMode && (
          <a
            href="/"
            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-gray-300 transition-colors hover:bg-gray-800"
          >
            🏠 Prod Mode
          </a>
        )}
        {!isDevMode && devAvailable && (
          <a
            href="/dev/"
            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-gray-300 transition-colors hover:bg-gray-800"
          >
            🔧 Dev Mode
          </a>
        )}
        <button
          onClick={() => {
            navigate('/attachments');
            onClose?.();
          }}
          className="w-full rounded-lg px-3 py-2 text-left text-sm text-gray-300 transition-colors hover:bg-gray-800"
        >
          📎 Attachments
        </button>
        <button
          onClick={() => {
            navigate('/data');
            onClose?.();
          }}
          className="w-full rounded-lg px-3 py-2 text-left text-sm text-gray-300 transition-colors hover:bg-gray-800"
        >
          💾 Manage Data
        </button>
        <button
          onClick={() => {
            navigate('/settings');
            onClose?.();
          }}
          className="w-full rounded-lg px-3 py-2 text-left text-sm text-gray-300 transition-colors hover:bg-gray-800"
        >
          ⚙️ Configure APIs
        </button>
      </div>
    </div>
  );
}
