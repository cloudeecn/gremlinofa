import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { hasMemory, clearMemory } from '../../services/memory/memoryStorage';
import { useApp } from '../../hooks/useApp';
import { apiService } from '../../services/api/apiService';
import { useProject } from '../../hooks/useProject';
import type { Project } from '../../types';
import { useAlert } from '../../hooks/useAlert';
import { clearDraft, useDraftPersistence } from '../../hooks/useDraftPersistence';
import ModelSelector from './ModelSelector';

interface ProjectSettingsViewProps {
  projectId: string;
  onMenuPress?: () => void;
}

export default function ProjectSettingsView({ projectId, onMenuPress }: ProjectSettingsViewProps) {
  const navigate = useNavigate();
  const { apiDefinitions } = useApp();
  const { showDestructiveConfirm } = useAlert();

  // Use the project hook
  const { project, updateProject, deleteProject } = useProject({
    projectId,
    apiDefinitions,
  });

  const [systemPrompt, setSystemPrompt] = useState(project?.systemPrompt || '');

  // Draft persistence for system prompt
  useDraftPersistence({
    place: 'project-instructions',
    contextId: projectId,
    value: systemPrompt,
    onChange: setSystemPrompt,
  });
  const [preFillResponse, setPreFillResponse] = useState(project?.preFillResponse || '');
  const [enableReasoning, setEnableReasoning] = useState(project?.enableReasoning || false);
  const [reasoningBudgetTokens, setReasoningBudgetTokens] = useState(
    project?.reasoningBudgetTokens.toString() || '2048'
  );
  const [webSearchEnabled, setWebSearchEnabled] = useState(project?.webSearchEnabled || false);
  const [sendMessageMetadata, setSendMessageMetadata] = useState(
    project?.sendMessageMetadata || false
  );
  const [metadataTimestampMode, setMetadataTimestampMode] = useState<'utc' | 'local' | 'disabled'>(
    project?.metadataTimestampMode || 'disabled'
  );
  const [metadataIncludeContextWindow, setMetadataIncludeContextWindow] = useState(
    project?.metadataIncludeContextWindow || false
  );
  const [metadataIncludeCost, setMetadataIncludeCost] = useState(
    project?.metadataIncludeCost || false
  );
  const [memoryEnabled, setMemoryEnabled] = useState(project?.memoryEnabled || false);
  const [projectHasMemory, setProjectHasMemory] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [temperature, setTemperature] = useState(project?.temperature?.toString() || '');
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    project?.maxOutputTokens.toString() || '2048'
  );
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [selectedApiDefId, setSelectedApiDefId] = useState(project?.apiDefinitionId || null);
  const [selectedModelId, setSelectedModelId] = useState(project?.modelId || null);

  // Update form fields when project loads
  useEffect(() => {
    if (project) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSystemPrompt(project.systemPrompt || '');
      setPreFillResponse(project.preFillResponse || '');
      setEnableReasoning(project.enableReasoning || false);
      setReasoningBudgetTokens(project.reasoningBudgetTokens.toString() || '2048');
      setWebSearchEnabled(project.webSearchEnabled || false);
      setSendMessageMetadata(project.sendMessageMetadata || false);
      setMetadataTimestampMode(project.metadataTimestampMode || 'disabled');
      setMetadataIncludeContextWindow(project.metadataIncludeContextWindow || false);
      setMetadataIncludeCost(project.metadataIncludeCost || false);
      setMemoryEnabled(project.memoryEnabled || false);
      setTemperature(project.temperature?.toString() || '');
      setMaxOutputTokens(project.maxOutputTokens.toString() || '2048');
      setSelectedApiDefId(project.apiDefinitionId || null);
      setSelectedModelId(project.modelId || null);
    }
  }, [project]);

  // Check if project has memory data
  useEffect(() => {
    let mounted = true;
    hasMemory(projectId).then(exists => {
      if (mounted) setProjectHasMemory(exists);
    });
    return () => {
      mounted = false;
    };
  }, [projectId]);

  // Get API definition and model names for display
  const apiDef = selectedApiDefId ? apiDefinitions.find(a => a.id === selectedApiDefId) : null;

  // Detect if current model is an o-series reasoning model
  const isOSeriesModel =
    selectedModelId && selectedApiDefId && apiDef
      ? apiService.isReasoningModel(apiDef.apiType, selectedModelId)
      : false;
  const apiDefName = apiDef?.name || 'No API';
  const modelName = selectedModelId || 'No model';

  const handleSave = async () => {
    if (!project) return;

    const updatedProject: Project = {
      ...project,
      apiDefinitionId: selectedApiDefId,
      modelId: selectedModelId,
      systemPrompt,
      preFillResponse,
      enableReasoning,
      reasoningBudgetTokens: parseInt(reasoningBudgetTokens) || 2048,
      webSearchEnabled,
      sendMessageMetadata,
      metadataTimestampMode,
      memoryEnabled,
      metadataIncludeContextWindow,
      metadataIncludeCost,
      temperature: temperature === '' ? null : parseFloat(temperature),
      maxOutputTokens: parseInt(maxOutputTokens) || 2048,
      lastUsedAt: new Date(),
    };

    await updateProject(updatedProject);
    clearDraft(); // Clear draft when settings are saved
    navigate(`/project/${projectId}`);
  };

  const handleCancel = () => {
    navigate(`/project/${projectId}`);
  };

  const handleModelSelect = (apiDefId: string | null, modelId: string | null) => {
    setSelectedApiDefId(apiDefId);
    setSelectedModelId(modelId);
    setShowModelSelector(false);
  };

  const handleDelete = async () => {
    if (!project) return;

    const confirmed = await showDestructiveConfirm(
      'Delete Project',
      `Are you sure you want to delete "${project.name}"? This will permanently delete all chats in this project. This action cannot be undone.`,
      'Delete'
    );

    if (confirmed) {
      await deleteProject();
      navigate('/');
    }
  };

  if (!project) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-gray-50">
      {/* Header with safe area */}
      <div className="border-b border-gray-200 bg-white">
        <div className="safe-area-inset-top" />
        <div className="flex h-14 items-center px-4">
          {onMenuPress && (
            <button
              onClick={onMenuPress}
              className="flex h-11 w-11 items-center justify-center text-gray-700 hover:text-gray-900 md:hidden"
            >
              <span className="text-2xl">☰</span>
            </button>
          )}
          <div className="flex-1 text-center">
            <h1 className="text-lg font-semibold text-gray-900">Settings - {project.name}</h1>
          </div>
          <button
            onClick={handleCancel}
            className="flex h-11 w-11 items-center justify-center text-gray-600 hover:text-gray-900"
          >
            <span className="text-2xl leading-none">✕</span>
          </button>
        </div>
      </div>

      {/* Model Selector */}
      <ModelSelector
        isOpen={showModelSelector}
        onClose={() => setShowModelSelector(false)}
        currentApiDefinitionId={selectedApiDefId}
        currentModelId={selectedModelId}
        onSelect={handleModelSelect}
        title="Configure Project"
        showResetOption={false}
      />

      {/* Content */}
      <div className="ios-scroll flex-1 overflow-y-auto overscroll-y-contain p-4">
        {/* Model Configuration */}
        <div className="mb-6">
          <label className="mb-2 block text-sm font-semibold text-gray-900">
            Model Configuration
          </label>
          <div
            onClick={() => setShowModelSelector(true)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setShowModelSelector(true);
              }
            }}
            role="button"
            tabIndex={0}
            className="flex w-full cursor-pointer items-center justify-between rounded-lg border border-gray-300 bg-white p-3 transition-colors hover:border-gray-400"
          >
            <span className="text-gray-900">
              {apiDefName} • {modelName}
            </span>
            <span className="text-gray-600">▼</span>
          </div>
        </div>

        {/* System Prompt */}
        <div className="mb-6">
          <label className="mb-2 block text-sm font-semibold text-gray-900">System Prompt</label>
          {isOSeriesModel && (
            <p className="mb-2 text-xs text-yellow-700 italic">
              ⚠️ o-series models don't support system prompts - this will be converted to a user
              message
            </p>
          )}
          <textarea
            value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
            placeholder="Enter system prompt..."
            rows={10}
            className="w-full resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
        </div>

        {/* Pre-fill Response */}
        <div className="mb-6">
          <label className="mb-2 block text-sm font-semibold text-gray-900">
            Pre-fill Response
          </label>
          {isOSeriesModel && (
            <p className="mb-2 text-xs text-yellow-700 italic">
              ⚠️ o-series models don't support pre-fill responses - this will be ignored
            </p>
          )}
          <textarea
            value={preFillResponse}
            onChange={e => setPreFillResponse(e.target.value)}
            placeholder="Optional assistant response prefix"
            rows={2}
            className="w-full resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
        </div>

        {/* Enable Reasoning */}
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <label
              htmlFor="enableReasoning"
              className="cursor-pointer text-sm font-semibold text-gray-900"
            >
              Enable Reasoning
            </label>
            <input
              id="enableReasoning"
              type="checkbox"
              checked={enableReasoning}
              onChange={e => setEnableReasoning(e.target.checked)}
              className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Reasoning Budget Tokens */}
        {enableReasoning && (
          <div className="mb-6">
            <label className="mb-2 block text-sm font-semibold text-gray-900">
              Reasoning Budget Tokens
            </label>
            <input
              type="number"
              value={reasoningBudgetTokens}
              onChange={e => setReasoningBudgetTokens(e.target.value)}
              placeholder="2048"
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
          </div>
        )}

        {/* Web Search */}
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <label
              htmlFor="webSearch"
              className="cursor-pointer text-sm font-semibold text-gray-900"
            >
              Web Search Enabled
            </label>
            <input
              id="webSearch"
              type="checkbox"
              checked={webSearchEnabled}
              onChange={e => setWebSearchEnabled(e.target.checked)}
              className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Memory */}
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <label
                htmlFor="memoryEnabled"
                className="cursor-pointer text-sm font-semibold text-gray-900"
              >
                Enable Memory
              </label>
              <p className="text-xs text-gray-500">
                Claude can remember information across conversations (Anthropic only)
              </p>
            </div>
            <input
              id="memoryEnabled"
              type="checkbox"
              checked={memoryEnabled}
              onChange={e => setMemoryEnabled(e.target.checked)}
              className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
            />
          </div>
          {memoryEnabled && (
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => navigate(`/project/${projectId}/memories`)}
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
              >
                📂 View Memory Files
              </button>
              {projectHasMemory && (
                <button
                  onClick={async () => {
                    const confirmed = await showDestructiveConfirm(
                      'Clear Memory',
                      'Delete all memory files for this project? Claude will forget everything.',
                      'Clear'
                    );
                    if (confirmed) {
                      await clearMemory(projectId);
                      setProjectHasMemory(false);
                    }
                  }}
                  className="rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
                >
                  🗑️ Clear
                </button>
              )}
            </div>
          )}
        </div>

        {/* Send Message Metadata */}
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <label
              htmlFor="sendMetadata"
              className="cursor-pointer text-sm font-semibold text-gray-900"
            >
              Send Message Metadata
            </label>
            <input
              id="sendMetadata"
              type="checkbox"
              checked={sendMessageMetadata}
              onChange={e => setSendMessageMetadata(e.target.checked)}
              className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Metadata Options */}
        {sendMessageMetadata && (
          <div className="mb-6 ml-4 space-y-6 border-l-2 border-gray-200 pl-4">
            {/* Timestamp Mode */}
            <div>
              <label className="mb-2 block text-sm font-semibold text-gray-900">Timestamp</label>
              <div className="flex gap-4">
                <div className="flex items-center gap-2">
                  <input
                    id="timestampUtc"
                    type="radio"
                    checked={metadataTimestampMode === 'utc'}
                    onChange={() => setMetadataTimestampMode('utc')}
                    className="h-5 w-5 cursor-pointer text-blue-600 focus:ring-2 focus:ring-blue-500"
                  />
                  <label htmlFor="timestampUtc" className="cursor-pointer text-sm text-gray-900">
                    UTC
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="timestampLocal"
                    type="radio"
                    checked={metadataTimestampMode === 'local'}
                    onChange={() => setMetadataTimestampMode('local')}
                    className="h-5 w-5 cursor-pointer text-blue-600 focus:ring-2 focus:ring-blue-500"
                  />
                  <label htmlFor="timestampLocal" className="cursor-pointer text-sm text-gray-900">
                    Local
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="timestampDisabled"
                    type="radio"
                    checked={metadataTimestampMode === 'disabled'}
                    onChange={() => setMetadataTimestampMode('disabled')}
                    className="h-5 w-5 cursor-pointer text-blue-600 focus:ring-2 focus:ring-blue-500"
                  />
                  <label
                    htmlFor="timestampDisabled"
                    className="cursor-pointer text-sm text-gray-900"
                  >
                    Disabled
                  </label>
                </div>
              </div>
            </div>

            {/* Context Window */}
            <div>
              <div className="flex items-center justify-between">
                <label
                  htmlFor="includeContextWindow"
                  className="cursor-pointer text-sm font-semibold text-gray-900"
                >
                  Include Context Window Usage
                </label>
                <input
                  id="includeContextWindow"
                  type="checkbox"
                  checked={metadataIncludeContextWindow}
                  onChange={e => setMetadataIncludeContextWindow(e.target.checked)}
                  className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* Cost */}
            <div>
              <div className="flex items-center justify-between">
                <label
                  htmlFor="includeCost"
                  className="cursor-pointer text-sm font-semibold text-gray-900"
                >
                  Include Current Cost
                </label>
                <input
                  id="includeCost"
                  type="checkbox"
                  checked={metadataIncludeCost}
                  onChange={e => setMetadataIncludeCost(e.target.checked)}
                  className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>
        )}

        {/* Advanced Section */}
        <div
          onClick={() => setShowAdvanced(!showAdvanced)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setShowAdvanced(!showAdvanced);
            }
          }}
          role="button"
          tabIndex={0}
          className="mb-4 flex w-full cursor-pointer items-center justify-between rounded-lg border border-gray-200 bg-white p-4 transition-colors hover:border-gray-300"
        >
          <span className="text-base font-semibold text-gray-900">Advanced</span>
          <span className="text-gray-600">{showAdvanced ? '▼' : '▶'}</span>
        </div>

        {showAdvanced && (
          <div className="mb-6 space-y-6">
            {/* Temperature */}
            <div>
              <label className="mb-2 block text-sm font-semibold text-gray-900">
                Temperature (0-1)
              </label>
              <p className="mb-2 text-xs text-yellow-700 italic">
                ⚠️ Temperature is ignored by most reasoning models
              </p>
              <input
                type="number"
                step="0.1"
                min="0"
                max="1"
                value={temperature}
                onChange={e => setTemperature(e.target.value)}
                placeholder="Use model default"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
            </div>

            {/* Max Output Tokens */}
            <div>
              <label className="mb-2 block text-sm font-semibold text-gray-900">
                Max Output Tokens
              </label>
              <input
                type="number"
                value={maxOutputTokens}
                onChange={e => setMaxOutputTokens(e.target.value)}
                placeholder="2048"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
            </div>
          </div>
        )}

        {/* Danger Zone */}
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4">
          <h3 className="mb-3 text-sm font-semibold text-red-900">Danger Zone</h3>
          <button
            onClick={handleDelete}
            className="w-full rounded-lg bg-red-600 px-4 py-3 font-semibold text-white transition-colors hover:bg-red-700"
          >
            🗑️ Delete Project
          </button>
          <p className="mt-2 text-center text-xs text-gray-600 italic">
            This will permanently delete the project and all its chats.
          </p>
        </div>

        {/* Bottom spacer */}
        <div className="h-20" />
      </div>

      {/* Footer with safe area */}
      <div className="border-t border-gray-200 bg-white">
        <div className="flex gap-3 p-4">
          <button
            onClick={handleCancel}
            className="flex-1 rounded-lg border border-gray-300 px-4 py-3 font-semibold text-gray-700 transition-colors hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex-1 rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white transition-colors hover:bg-blue-700"
          >
            Save
          </button>
        </div>
        <div className="safe-area-inset-bottom" />
      </div>
    </div>
  );
}
