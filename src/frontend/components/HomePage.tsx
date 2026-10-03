import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import Spinner from './ui/Spinner';
import { useApiDefinitions, useAppActions, useProjects, useStorageInfo } from '../hooks/useApp';
import { useCreateProject } from '../hooks/useCreateProject';
import { useImeSafeEnter } from '../hooks/useImeSafeEnter';
import { useIsMobile } from '../hooks/useIsMobile';
import { getApiDefinitionIcon } from '../lib/apiTypeUtils';
import { formatStorageDisplay, shouldShowStorageWarning } from '../lib/formatBytes';
import { getStorageConfig } from '../lib/localStorageBoot';
import { hasUsableApiDefinition } from '../../shared/protocol/apiDefinition';
import type { APIDefinition, Project } from '../../shared/protocol/types';

/** The sidebar lists every project; home shows the latest few until asked. */
const RECENT_PROJECT_LIMIT = 8;

interface HomePageProps {
  onMenuPress?: () => void;
}

/**
 * `/`. Walks a new user through key → project → model, then becomes a list of
 * recent projects. Every step's state comes from live data, so it ticks
 * itself off however the user got there (setup here, the sidebar, an import).
 */
export default function HomePage({ onMenuPress }: HomePageProps) {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const projects = useProjects();
  const apiDefinitions = useApiDefinitions();
  const { storageQuota } = useStorageInfo();
  const { refreshStorageQuota } = useAppActions();
  const [showAllProjects, setShowAllProjects] = useState(false);

  useEffect(() => {
    void refreshStorageQuota();
  }, [refreshStorageQuota]);

  const hasApi = hasUsableApiDefinition(apiDefinitions);
  const hasProject = projects.length > 0;
  const hasModel = projects.some(project => project.apiDefinitionId && project.modelId);
  const isSetupDone = hasApi && hasProject && hasModel;
  // Projects arrive most recently used first
  const projectNeedingModel = projects.find(
    project => !project.apiDefinitionId || !project.modelId
  );

  // Server mode keeps nothing in this browser
  const isServerMode = getStorageConfig().type === 'server';
  const showStorageWarning =
    !isServerMode &&
    !!storageQuota &&
    shouldShowStorageWarning(storageQuota.usage, storageQuota.quota);

  const visibleProjects = showAllProjects ? projects : projects.slice(0, RECENT_PROJECT_LIMIT);
  const hiddenProjectCount = projects.length - visibleProjects.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-gray-50">
      {/* Header with safe area */}
      <div className="border-b border-gray-200 bg-white">
        <div className="safe-area-inset-top" />
        <div className="flex h-14 items-center px-4">
          {isMobile && onMenuPress && (
            <button
              onClick={onMenuPress}
              aria-label="Open menu"
              className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-gray-100"
            >
              <span className="text-2xl text-gray-700">☰</span>
            </button>
          )}
          <h1 className="min-w-0 flex-1 truncate text-center text-lg font-semibold text-gray-900">
            Gremlin Of The Friday Afternoon
          </h1>
          {/* Spacer for centering on mobile */}
          {isMobile && onMenuPress && <div className="w-11 shrink-0" />}
        </div>
      </div>

      <div className="ios-scroll flex-1 overflow-y-auto overscroll-y-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:p-8">
        <div className="mx-auto flex max-w-2xl flex-col gap-6">
          {showStorageWarning && storageQuota && (
            <StorageWarning
              usageText={formatStorageDisplay(storageQuota.usage, storageQuota.quota).text}
              onManageData={() => navigate('/data')}
            />
          )}

          {!isSetupDone && (
            <section
              aria-labelledby="home-setup-heading"
              className="rounded-xl border border-gray-200 bg-white p-5"
            >
              <h2 id="home-setup-heading" className="text-lg font-semibold text-gray-900">
                Three steps to your first chat
              </h2>
              <ol className="mt-4 flex flex-col gap-4">
                <SetupStep
                  number={1}
                  isDone={hasApi}
                  title="Connect a provider"
                  description="Add an API key in Configure APIs. Local endpoints (Ollama, LM Studio) work without one."
                >
                  <StepButton onClick={() => navigate('/settings')}>Configure APIs</StepButton>
                </SetupStep>
                <SetupStep
                  number={2}
                  isDone={hasProject}
                  title="Create a project"
                  description="Projects hold your chats, instructions and default model."
                >
                  <NewProjectForm />
                </SetupStep>
                <SetupStep
                  number={3}
                  isDone={hasModel}
                  title="Pick a default model"
                  description={
                    projectNeedingModel
                      ? `Choose one in the settings of ${projectNeedingModel.name}.`
                      : 'Choose one in the project settings, once you have a project.'
                  }
                >
                  {projectNeedingModel && (
                    <StepButton
                      onClick={() => navigate(`/project/${projectNeedingModel.id}/settings`)}
                    >
                      Open project settings
                    </StepButton>
                  )}
                </SetupStep>
              </ol>
            </section>
          )}

          {hasProject && <NewProjectForm />}

          {hasProject && (
            <section aria-labelledby="home-recent-heading">
              <h2
                id="home-recent-heading"
                className="mb-2 px-1 text-xs font-medium tracking-wide text-gray-500 uppercase"
              >
                Recent projects
              </h2>
              <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
                {visibleProjects.map(project => (
                  <li key={project.id}>
                    <ProjectRow
                      project={project}
                      apiDefinitions={apiDefinitions}
                      onOpen={() => navigate(`/project/${project.id}`)}
                    />
                  </li>
                ))}
              </ul>
              {hiddenProjectCount > 0 && (
                <button
                  onClick={() => setShowAllProjects(true)}
                  className="mt-2 px-1 text-sm font-medium text-blue-600 hover:text-blue-700"
                >
                  Show {hiddenProjectCount} more
                </button>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function SetupStep({
  number,
  isDone,
  title,
  description,
  children,
}: {
  number: number;
  isDone: boolean;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
          isDone ? 'bg-green-600 text-white' : 'border border-gray-300 text-gray-600'
        }`}
      >
        {isDone ? '✓' : number}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <h3 className={`font-medium ${isDone ? 'text-gray-500' : 'text-gray-900'}`}>
          {title}
          {isDone && <span className="sr-only">: done</span>}
        </h3>
        {!isDone && (
          <>
            <p className="mt-0.5 text-sm text-gray-600">{description}</p>
            {children && <div className="mt-3">{children}</div>}
          </>
        )}
      </div>
    </li>
  );
}

function StepButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800"
    >
      {children}
    </button>
  );
}

function ProjectRow({
  project,
  apiDefinitions,
  onOpen,
}: {
  project: Project;
  apiDefinitions: APIDefinition[];
  onOpen: () => void;
}) {
  const apiDef = project.apiDefinitionId
    ? apiDefinitions.find(def => def.id === project.apiDefinitionId)
    : undefined;
  const modelLabel = project.modelId
    ? `${apiDef ? getApiDefinitionIcon(apiDef) + ' ' : ''}${project.modelId}`
    : 'No default model yet';

  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-50"
    >
      <span className="shrink-0 text-2xl">{project.icon || '📁'}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-gray-900">{project.name}</span>
        <span className="block truncate text-xs text-gray-500">{modelLabel}</span>
      </span>
    </button>
  );
}

/** Inline project creation; opens the new project once it's saved. */
function NewProjectForm() {
  const { createProject, isSaving } = useCreateProject();
  const { onCompositionEnd, isImeEnter } = useImeSafeEnter();
  const [name, setName] = useState('');

  // Navigates away on success, which unmounts this form
  const submit = () => {
    if (!isSaving) void createProject(name);
  };

  return (
    <div className="flex gap-2">
      <input
        type="text"
        aria-label="New project name"
        placeholder="New project name"
        value={name}
        onChange={e => setName(e.target.value)}
        onCompositionEnd={onCompositionEnd}
        onKeyDown={e => {
          if (isImeEnter(e)) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
      />
      <button
        onClick={submit}
        disabled={isSaving}
        className="flex shrink-0 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
      >
        {isSaving && <Spinner size={14} colorClass="border-white" />}
        Create
      </button>
    </div>
  );
}

function StorageWarning({
  usageText,
  onManageData,
}: {
  usageText: string;
  onManageData: () => void;
}) {
  return (
    <div className="rounded-xl border border-yellow-300 bg-yellow-50 p-4">
      <p className="text-sm text-yellow-900">
        <span aria-hidden="true">⚠️ </span>
        This browser holds {usageText} of your data, and browsers may clear site data on their own.
        If you rely on it, move to{' '}
        <a
          className="text-blue-700 underline"
          href="https://github.com/cloudeecn/gremlinofa/blob/main/storage-backend/README.md"
          rel="noopener noreferrer"
          target="_blank"
        >
          self-hosted remote storage
        </a>{' '}
        or keep an export around.
      </p>
      <button
        onClick={onManageData}
        className="mt-2 text-sm font-medium text-blue-700 hover:text-blue-800"
      >
        💾 Manage Data
      </button>
    </div>
  );
}
