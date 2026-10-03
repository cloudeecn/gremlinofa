import { useReducer, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useApiDefinitions } from '../../hooks/useApp';
import { useProject } from '../../hooks/useProject';
import { getApiDefinitionIcon } from '../../lib/apiTypeUtils';
import { hasUsableApiDefinition } from '../../../shared/protocol/apiDefinition';
import { getStorageConfig } from '../../lib/localStorageBoot';
import type {
  APIType,
  ModelReference,
  ToolOptionValue,
  Verbosity,
} from '../../../shared/protocol/types';
import {
  isBooleanOption,
  isNumberOption,
  isTextOption,
  isLongtextOption,
  isModelOption,
  isModelListOption,
  isSelectOption,
  isModelReference,
  isModelReferenceArray,
} from '../../../shared/protocol/types';
import { useAlert } from '../../hooks/useAlert';
import { clearDraft } from '../../hooks/useDraftPersistence';
import Spinner from '../ui/Spinner';
import NumberInput from '../ui/NumberInput';
import ModelSelector from './ModelSelector';
import SystemPromptModal from './SystemPromptModal';
import LongtextOptionEditor from './LongtextOptionEditor';
import AnthropicReasoningConfig from './AnthropicReasoningConfig';
import OpenAIReasoningConfig from './OpenAIReasoningConfig';
import { useToolInventory } from '../../hooks/useToolInventory';
import ReasoningEffortSelect from './ReasoningEffortSelect';
import {
  formToProjectPatch,
  initProjectSettingsState,
  projectSettingsReducer,
  type ProjectSettingsForm,
} from './projectSettingsForm';

interface ProjectSettingsViewProps {
  projectId: string;
  onMenuPress?: () => void;
}

export default function ProjectSettingsView({ projectId, onMenuPress }: ProjectSettingsViewProps) {
  const navigate = useNavigate();
  const apiDefinitions = useApiDefinitions();
  const { showAlert, showDestructiveConfirm } = useAlert();

  const { project, updateProject, deleteProject } = useProject({ projectId, withChats: false });

  // Every edited project field lives in one form object (see projectSettingsForm.ts).
  const [{ seededFrom, form }, dispatch] = useReducer(
    projectSettingsReducer,
    project,
    initProjectSettingsState
  );
  // Re-seed whenever a new project instance arrives. Tracking the last-seeded
  // project during render is React's recommended alternative to a
  // setState-in-effect.
  if (seededFrom !== project) {
    dispatch({ type: 'seed', project });
  }
  const patch = (fields: Partial<ProjectSettingsForm>) => dispatch({ type: 'patch', fields });

  const [showSystemPromptModal, setShowSystemPromptModal] = useState(false);
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);
  const tooltipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showRemoteVfs, setShowRemoteVfs] = useState(false);
  const [remoteVfsTestStatus, setRemoteVfsTestStatus] = useState<
    'idle' | 'testing' | 'ok' | 'error'
  >('idle');
  const [showDangerZone, setShowDangerZone] = useState(false);
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Tool option editor modal state
  const [longtextModal, setLongtextModal] = useState<{
    toolName: string;
    optionId: string;
    title: string;
    placeholder?: string;
  } | null>(null);
  const [modelOptionModal, setModelOptionModal] = useState<{
    toolName: string;
    optionId: string;
    title: string;
  } | null>(null);
  const [modelListAddModal, setModelListAddModal] = useState<{
    toolName: string;
    optionId: string;
    title: string;
  } | null>(null);

  const availableTools = useToolInventory();

  if (!project || !form) return null;

  // Get API definition and model names for display
  const apiDef = form.apiDefinitionId
    ? apiDefinitions.find(a => a.id === form.apiDefinitionId)
    : null;
  const selectedApiType: APIType | null = apiDef?.apiType ?? null;
  const flexSupported = !!apiDef?.advancedSettings?.flexTierSupported;

  // Check if any API has credentials configured (or is marked as local)
  const hasConfiguredApis = hasUsableApiDefinition(apiDefinitions);

  // Detect if current model is an o-series reasoning model
  const isOSeriesModel =
    (selectedApiType === 'chatgpt' || selectedApiType === 'responses_api') &&
    form.modelId?.startsWith('o');

  // Check selected API type for conditional UI
  const isAnthropic = selectedApiType === 'anthropic';
  const isOpenAICompatible = selectedApiType === 'chatgpt' || selectedApiType === 'responses_api';
  const hasModelSelected = !!form.modelId;

  const modelDisplayText = hasModelSelected
    ? `${apiDef ? getApiDefinitionIcon(apiDef) + ' ' : ''}${apiDef?.name || 'Unknown'} • ${form.modelId}`
    : 'Select a model to get started';

  const isToolEnabled = (toolName: string) => form.enabledTools.includes(toolName);

  const toggleTool = (toolName: string, enabled: boolean) =>
    dispatch({
      type: 'toggleTool',
      toolName,
      enabled,
      optionDefinitions: availableTools.find(t => t.name === toolName)?.optionDefinitions,
    });

  const getToolOptionValue = <T extends ToolOptionValue>(
    toolName: string,
    optionId: string,
    defaultValue: T
  ): T => (form.toolOptions[toolName]?.[optionId] as T) ?? defaultValue;

  const setToolOptionValue = (toolName: string, optionId: string, value: ToolOptionValue) =>
    dispatch({ type: 'setToolOption', toolName, optionId, value });

  const getModelDisplayText = (modelRef: ModelReference | undefined): string => {
    if (!modelRef) return 'Not configured';
    const def = apiDefinitions.find(d => d.id === modelRef.apiDefinitionId);
    const icon = def ? getApiDefinitionIcon(def) : '';
    const name = def?.name || 'Unknown';
    return `${icon} ${name} • ${modelRef.modelId}`;
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const saved = await updateProject({
        ...formToProjectPatch(form, { serverMode: getStorageConfig().type === 'server' }),
        // Deprecated (E2E encryption was removed); every save clears it.
        remoteVfsEncrypt: undefined,
      });
      // A failed save stays here with every edit; updateProject has said why
      if (!saved) return;
      clearDraft('system-prompt-modal', projectId); // Clear draft when settings are saved
      navigate(`/project/${projectId}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    navigate(`/project/${projectId}`);
  };

  const handleModelSelect = (apiDefId: string | null, modelId: string | null) => {
    patch({ apiDefinitionId: apiDefId, modelId });
    setShowModelSelector(false);
  };

  const handleDelete = async () => {
    const confirmed = await showDestructiveConfirm(
      'Delete Project',
      `Are you sure you want to delete "${project.name}"? This will permanently delete all chats in this project. This action cannot be undone.`,
      'Delete'
    );

    if (!confirmed) return;

    try {
      await deleteProject();
    } catch (error) {
      console.error('[ProjectSettingsView] Failed to delete project:', error);
      showAlert('Error', 'Failed to delete project');
      return;
    }
    navigate('/');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-gray-50">
      {/* Header with safe area */}
      <div className="border-b border-gray-200 bg-white">
        <div className="safe-area-inset-top" />
        <div className="flex h-14 items-center px-4">
          {onMenuPress && (
            <button
              onClick={onMenuPress}
              aria-label="Open menu"
              className="flex h-11 w-11 items-center justify-center text-gray-700 hover:text-gray-900 md:hidden"
            >
              <span className="text-2xl">☰</span>
            </button>
          )}
          <div className="min-w-0 flex-1 text-center">
            <h1 className="truncate text-lg font-semibold text-gray-900">
              Settings - {project.name}
            </h1>
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
        currentApiDefinitionId={form.apiDefinitionId}
        currentModelId={form.modelId}
        onSelect={handleModelSelect}
        title="Configure Project"
        showResetOption={false}
      />

      {/* System Prompt Modal */}
      <SystemPromptModal
        key={project.id}
        isOpen={showSystemPromptModal}
        contextId={project.id}
        initialValue={project.systemPrompt || ''}
        onSave={async value => {
          // Into the form only; the page's Save writes it
          patch({ systemPrompt: value });
          setShowSystemPromptModal(false);
          return true;
        }}
        onCancel={() => setShowSystemPromptModal(false)}
      />

      {/* Longtext Tool Option Editor Modal */}
      {longtextModal && (
        <LongtextOptionEditor
          key={`${projectId}|${longtextModal.toolName}|${longtextModal.optionId}`}
          isOpen={true}
          title={longtextModal.title}
          value={
            (typeof form.toolOptions[longtextModal.toolName]?.[longtextModal.optionId] === 'string'
              ? form.toolOptions[longtextModal.toolName]?.[longtextModal.optionId]
              : '') as string
          }
          placeholder={longtextModal.placeholder}
          projectId={projectId}
          toolName={longtextModal.toolName}
          optionId={longtextModal.optionId}
          onSave={value => {
            setToolOptionValue(longtextModal.toolName, longtextModal.optionId, value);
            setLongtextModal(null);
          }}
          onCancel={() => setLongtextModal(null)}
        />
      )}

      {/* Model Tool Option Selector Modal */}
      {modelOptionModal && (
        <ModelSelector
          isOpen={true}
          onClose={() => setModelOptionModal(null)}
          currentApiDefinitionId={
            isModelReference(
              form.toolOptions[modelOptionModal.toolName]?.[modelOptionModal.optionId]
            )
              ? (
                  form.toolOptions[modelOptionModal.toolName]?.[
                    modelOptionModal.optionId
                  ] as ModelReference
                ).apiDefinitionId
              : form.apiDefinitionId
          }
          currentModelId={
            isModelReference(
              form.toolOptions[modelOptionModal.toolName]?.[modelOptionModal.optionId]
            )
              ? (
                  form.toolOptions[modelOptionModal.toolName]?.[
                    modelOptionModal.optionId
                  ] as ModelReference
                ).modelId
              : null
          }
          onSelect={(apiDefId, modelId) => {
            if (apiDefId && modelId) {
              setToolOptionValue(modelOptionModal.toolName, modelOptionModal.optionId, {
                apiDefinitionId: apiDefId,
                modelId: modelId,
              });
            }
            setModelOptionModal(null);
          }}
          title={modelOptionModal.title}
          showResetOption={false}
        />
      )}

      {/* Model List Add Modal */}
      {modelListAddModal && (
        <ModelSelector
          isOpen={true}
          onClose={() => setModelListAddModal(null)}
          currentApiDefinitionId={form.apiDefinitionId}
          currentModelId={null}
          onSelect={(apiDefId, modelId) => {
            if (apiDefId && modelId) {
              const currentList =
                form.toolOptions[modelListAddModal.toolName]?.[modelListAddModal.optionId];
              const list: ModelReference[] = isModelReferenceArray(currentList) ? currentList : [];
              // Duplicate check
              const alreadyExists = list.some(
                ref => ref.apiDefinitionId === apiDefId && ref.modelId === modelId
              );
              if (!alreadyExists) {
                setToolOptionValue(modelListAddModal.toolName, modelListAddModal.optionId, [
                  ...list,
                  { apiDefinitionId: apiDefId, modelId },
                ]);
              }
            }
            setModelListAddModal(null);
          }}
          title={modelListAddModal.title}
          showResetOption={false}
        />
      )}

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
            <span className={hasModelSelected ? 'text-gray-900' : 'text-gray-500'}>
              {modelDisplayText}
            </span>
            <span className="text-gray-600">▼</span>
          </div>
          {!hasConfiguredApis && (
            <Link
              to="/settings"
              className="mt-2 block text-sm text-blue-600 hover:text-blue-700 hover:underline"
            >
              ⚙️ Configure API keys to unlock more providers
            </Link>
          )}
        </div>

        {hasModelSelected && (
          <>
            {/* Project Instructions (System Prompt) */}
            <div className="mb-6">
              <label className="mb-2 block text-sm font-semibold text-gray-900">
                Project Instructions
              </label>
              {isOSeriesModel && (
                <p className="mb-2 text-xs text-yellow-700 italic">
                  ⚠️ o-series models don't support system prompts - this will be converted to a user
                  message
                </p>
              )}
              <div
                onClick={() => setShowSystemPromptModal(true)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setShowSystemPromptModal(true);
                  }
                }}
                role="button"
                tabIndex={0}
                className="flex w-full cursor-pointer items-center justify-between rounded-lg border border-gray-300 bg-white p-3 transition-colors hover:border-gray-400"
              >
                <span
                  className={`min-w-0 flex-1 truncate ${form.systemPrompt ? 'text-gray-900' : 'text-gray-500'}`}
                >
                  {form.systemPrompt || 'Configure system prompt...'}
                </span>
                <span className="ml-2 flex-shrink-0 text-gray-600">✏️</span>
              </div>
            </div>

            {/* Temperature - moved here for prominence */}
            <div className="mb-6">
              <label className="mb-2 block text-sm font-semibold text-gray-900">
                Temperature (0-1)
              </label>
              <p className="mb-2 text-xs text-gray-500">Ignored by most reasoning models.</p>
              <input
                type="number"
                step="0.1"
                min="0"
                max="1"
                value={form.temperature}
                onChange={e => patch({ temperature: e.target.value })}
                placeholder="Use model default"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
            </div>

            {/* Unified Reasoning Section */}
            <div className="mb-6 overflow-hidden rounded-lg border border-gray-200">
              {/* Section Header with Enable Toggle */}
              <label className="flex w-full cursor-pointer items-center justify-between bg-gray-50 px-4 py-3">
                <span className="text-sm font-semibold text-gray-900">Reasoning</span>
                <input
                  type="checkbox"
                  checked={form.enableReasoning}
                  onChange={e => patch({ enableReasoning: e.target.checked })}
                  className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                />
              </label>
              {/* Section Content */}
              {form.enableReasoning && (
                <div className="space-y-6 bg-white p-4">
                  {/* Shared: Reasoning Effort (used by OpenAI/Nova directly, maps to output effort for Anthropic adaptive) */}
                  <ReasoningEffortSelect
                    value={form.reasoningEffort}
                    onChange={value => patch({ reasoningEffort: value })}
                  />

                  {/* Anthropic / Bedrock Claude Subsection */}
                  <div className="border-t border-gray-100 pt-4">
                    <h4 className="mb-3 text-xs font-medium tracking-wide text-gray-500 uppercase">
                      Anthropic / Bedrock Claude
                    </h4>
                    <AnthropicReasoningConfig
                      reasoningBudgetTokens={form.reasoningBudgetTokens}
                      setReasoningBudgetTokens={value => patch({ reasoningBudgetTokens: value })}
                      thinkingKeepTurns={form.thinkingKeepTurns}
                      setThinkingKeepTurns={value => patch({ thinkingKeepTurns: value })}
                      pruneThinkingBeforeApiCall={form.pruneThinkingBeforeApiCall}
                      setPruneThinkingBeforeApiCall={value =>
                        patch({ pruneThinkingBeforeApiCall: value })
                      }
                      maxOutputTokens={form.maxOutputTokens}
                    />
                  </div>

                  {/* Reasoning Summary — shared across providers */}
                  <div className="border-t border-gray-100 pt-4">
                    <h4 className="mb-3 text-xs font-medium tracking-wide text-gray-500 uppercase">
                      Reasoning Summary
                    </h4>
                    <OpenAIReasoningConfig
                      reasoningSummary={form.reasoningSummary}
                      setReasoningSummary={value => patch({ reasoningSummary: value })}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Message Format Section */}
            <div className="mb-6 overflow-hidden rounded-lg border border-gray-200">
              {/* Section Header */}
              <div className="bg-gray-50 px-4 py-3">
                <span className="text-sm font-semibold text-gray-900">Message Format</span>
              </div>
              {/* Section Content */}
              <div className="space-y-4 bg-white p-4">
                {/* Radio Options */}
                <div className="flex flex-wrap gap-4">
                  <div className="flex items-center gap-2">
                    <input
                      id="metadataModeDisabled"
                      type="radio"
                      checked={form.sendMessageMetadata === false}
                      onChange={() => patch({ sendMessageMetadata: false })}
                      className="h-5 w-5 cursor-pointer text-blue-600 focus:ring-2 focus:ring-blue-500"
                    />
                    <label
                      htmlFor="metadataModeDisabled"
                      className="cursor-pointer text-sm text-gray-900"
                    >
                      User message
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      id="metadataModeEnabled"
                      type="radio"
                      checked={form.sendMessageMetadata === true}
                      onChange={() => patch({ sendMessageMetadata: true })}
                      className="h-5 w-5 cursor-pointer text-blue-600 focus:ring-2 focus:ring-blue-500"
                    />
                    <label
                      htmlFor="metadataModeEnabled"
                      className="cursor-pointer text-sm text-gray-900"
                    >
                      With metadata
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      id="metadataModeTemplate"
                      type="radio"
                      checked={form.sendMessageMetadata === 'template'}
                      onChange={() => patch({ sendMessageMetadata: 'template' })}
                      className="h-5 w-5 cursor-pointer text-blue-600 focus:ring-2 focus:ring-blue-500"
                    />
                    <label
                      htmlFor="metadataModeTemplate"
                      className="cursor-pointer text-sm text-gray-900"
                    >
                      Use template
                    </label>
                  </div>
                </div>

                {/* With Metadata Options */}
                {form.sendMessageMetadata === true && (
                  <div className="space-y-4 border-t border-gray-100 pt-4">
                    {/* Timestamp Mode */}
                    <div>
                      <label className="mb-2 block text-sm font-medium text-gray-900">
                        Timestamp
                      </label>
                      <div className="flex flex-wrap gap-4">
                        <div className="flex items-center gap-2">
                          <input
                            id="timestampUtc"
                            type="radio"
                            checked={form.metadataTimestampMode === 'utc'}
                            onChange={() => patch({ metadataTimestampMode: 'utc' })}
                            className="h-5 w-5 cursor-pointer text-blue-600 focus:ring-2 focus:ring-blue-500"
                          />
                          <label
                            htmlFor="timestampUtc"
                            className="cursor-pointer text-sm text-gray-900"
                          >
                            UTC
                          </label>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            id="timestampLocal"
                            type="radio"
                            checked={form.metadataTimestampMode === 'local'}
                            onChange={() => patch({ metadataTimestampMode: 'local' })}
                            className="h-5 w-5 cursor-pointer text-blue-600 focus:ring-2 focus:ring-blue-500"
                          />
                          <label
                            htmlFor="timestampLocal"
                            className="cursor-pointer text-sm text-gray-900"
                          >
                            Local
                          </label>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            id="timestampRelative"
                            type="radio"
                            checked={form.metadataTimestampMode === 'relative'}
                            onChange={() => patch({ metadataTimestampMode: 'relative' })}
                            className="h-5 w-5 cursor-pointer text-blue-600 focus:ring-2 focus:ring-blue-500"
                          />
                          <label
                            htmlFor="timestampRelative"
                            className="cursor-pointer text-sm text-gray-900"
                          >
                            Relative
                          </label>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            id="timestampDisabled"
                            type="radio"
                            checked={form.metadataTimestampMode === 'disabled'}
                            onChange={() => patch({ metadataTimestampMode: 'disabled' })}
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

                    {/* Model Name */}
                    <div className="flex items-center justify-between">
                      <label
                        htmlFor="includeModelName"
                        className="cursor-pointer text-sm font-medium text-gray-900"
                      >
                        Include Model Name
                      </label>
                      <input
                        id="includeModelName"
                        type="checkbox"
                        checked={form.metadataIncludeModelName}
                        onChange={e => patch({ metadataIncludeModelName: e.target.checked })}
                        className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                      />
                    </div>

                    {/* Context Window */}
                    <div className="flex items-center justify-between">
                      <label
                        htmlFor="includeContextWindow"
                        className="cursor-pointer text-sm font-medium text-gray-900"
                      >
                        Include Context Window Usage
                      </label>
                      <input
                        id="includeContextWindow"
                        type="checkbox"
                        checked={form.metadataIncludeContextWindow}
                        onChange={e => patch({ metadataIncludeContextWindow: e.target.checked })}
                        className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                      />
                    </div>

                    {/* Cost */}
                    <div className="flex items-center justify-between">
                      <label
                        htmlFor="includeCost"
                        className="cursor-pointer text-sm font-medium text-gray-900"
                      >
                        Include Current Cost
                      </label>
                      <input
                        id="includeCost"
                        type="checkbox"
                        checked={form.metadataIncludeCost}
                        onChange={e => patch({ metadataIncludeCost: e.target.checked })}
                        className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                )}

                {/* Template Mode Options */}
                {form.sendMessageMetadata === 'template' && (
                  <div className="space-y-4 border-t border-gray-100 pt-4">
                    {/* Available Variables */}
                    <div>
                      <label className="mb-2 block text-sm font-medium text-gray-900">
                        Available Variables
                      </label>
                      <div className="relative flex flex-wrap gap-2">
                        {[
                          { name: 'userMessage', desc: 'The message you type in the chat input' },
                          {
                            name: 'timestamp',
                            desc: 'Local time (e.g., Wed, Jan 8, 2026, 11:22 PM PST)',
                          },
                          {
                            name: 'timestampUtc',
                            desc: 'UTC time (e.g., Thu, Jan 9, 2026, 7:22 AM UTC)',
                          },
                          {
                            name: 'timestampRelative',
                            desc: "Seconds since chat started (e.g., '45 seconds since chat start')",
                          },
                          {
                            name: 'modelName',
                            desc: 'Current model ID (e.g., claude-sonnet-4-20250514)',
                          },
                          {
                            name: 'contextWindowUsage',
                            desc: "Tokens used in context (e.g., '12500 tokens')",
                          },
                          { name: 'currentCost', desc: "Accumulated cost (e.g., '$0.023')" },
                        ].map(v => (
                          <button
                            key={v.name}
                            type="button"
                            onClick={() => {
                              if (tooltipTimeoutRef.current) {
                                clearTimeout(tooltipTimeoutRef.current);
                              }
                              setActiveTooltip(activeTooltip === v.name ? null : v.name);
                              if (activeTooltip !== v.name) {
                                tooltipTimeoutRef.current = setTimeout(
                                  () => setActiveTooltip(null),
                                  3000
                                );
                              }
                            }}
                            className={`rounded-md px-2 py-1 font-mono text-xs transition-colors ${
                              activeTooltip === v.name
                                ? 'bg-blue-100 text-blue-800'
                                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                            }`}
                          >
                            {`{{${v.name}}}`}
                          </button>
                        ))}
                        {/* Tooltip */}
                        {activeTooltip && (
                          <div className="absolute top-full right-0 left-0 z-10 mt-2 rounded-lg border border-gray-200 bg-white p-2 text-sm text-gray-700 shadow-lg">
                            {
                              [
                                {
                                  name: 'userMessage',
                                  desc: 'The message you type in the chat input',
                                },
                                {
                                  name: 'timestamp',
                                  desc: 'Local time (e.g., Wed, Jan 8, 2026, 11:22 PM PST)',
                                },
                                {
                                  name: 'timestampUtc',
                                  desc: 'UTC time (e.g., Thu, Jan 9, 2026, 7:22 AM UTC)',
                                },
                                {
                                  name: 'timestampRelative',
                                  desc: "Seconds since chat started (e.g., '45 seconds since chat start')",
                                },
                                {
                                  name: 'modelName',
                                  desc: 'Current model ID (e.g., claude-sonnet-4-20250514)',
                                },
                                {
                                  name: 'contextWindowUsage',
                                  desc: "Tokens used in context (e.g., '12500 tokens')",
                                },
                                { name: 'currentCost', desc: "Accumulated cost (e.g., '$0.023')" },
                              ].find(v => v.name === activeTooltip)?.desc
                            }
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Template Textarea */}
                    <div>
                      <label className="mb-2 block text-sm font-medium text-gray-900">
                        Template
                      </label>
                      <textarea
                        value={form.metadataTemplate}
                        onChange={e => patch({ metadataTemplate: e.target.value })}
                        placeholder="{{userMessage}}"
                        rows={4}
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
                      />
                    </div>

                    {/* New Context Option */}
                    <div className="flex items-center justify-between">
                      <div>
                        <label
                          htmlFor="newContext"
                          className="cursor-pointer text-sm font-medium text-gray-900"
                        >
                          Start new context per message
                        </label>
                        <p className="text-xs text-gray-500">
                          Each message ignores chat history (keeps system prompt)
                        </p>
                      </div>
                      <input
                        id="newContext"
                        type="checkbox"
                        checked={form.metadataNewContext}
                        onChange={e => patch({ metadataNewContext: e.target.checked })}
                        className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="mb-6 overflow-hidden rounded-lg border border-gray-200">
              {/* Section Header */}
              <div className="bg-gray-50 px-4 py-3">
                <span className="text-sm font-semibold text-gray-900">Tools</span>
              </div>
              {/* Section Content */}
              <div className="space-y-4 bg-white p-4">
                {/* Server-side Tools */}
                <p className="text-xs font-medium tracking-wide text-gray-500 uppercase">
                  Server-side
                </p>

                {/* Web Search */}
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="webSearch"
                    className="cursor-pointer text-sm font-medium text-gray-900"
                  >
                    Web Search
                  </label>
                  <input
                    id="webSearch"
                    type="checkbox"
                    checked={form.webSearchEnabled}
                    onChange={e => patch({ webSearchEnabled: e.target.checked })}
                    className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                {/* Client-side Tools - dynamically rendered from registry */}
                <p className="mt-2 text-xs font-medium tracking-wide text-gray-500 uppercase">
                  Client-side
                </p>

                {availableTools.map(tool => (
                  <div key={tool.name}>
                    {/* Tool toggle */}
                    <div className="flex items-center justify-between">
                      <div>
                        <label
                          htmlFor={`tool-${tool.name}`}
                          className="cursor-pointer text-sm font-medium text-gray-900"
                        >
                          {tool.displayName || tool.name}
                        </label>
                        {tool.displaySubtitle && (
                          <p className="text-xs text-gray-500">{tool.displaySubtitle}</p>
                        )}
                      </div>
                      <input
                        id={`tool-${tool.name}`}
                        type="checkbox"
                        checked={isToolEnabled(tool.name)}
                        onChange={e => toggleTool(tool.name, e.target.checked)}
                        className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                      />
                    </div>

                    {/* Tool options - nested under tool toggle when enabled */}
                    {isToolEnabled(tool.name) &&
                      tool.optionDefinitions &&
                      tool.optionDefinitions.length > 0 && (
                        <div className="mt-2 ml-4 space-y-3 border-l-2 border-gray-200 pl-4">
                          {tool.optionDefinitions.map(opt => {
                            // visibleWhen: skip if sibling option doesn't match
                            if (opt.visibleWhen) {
                              const { optionId, value } = opt.visibleWhen;
                              const siblingDef = tool.optionDefinitions?.find(
                                o => o.id === optionId
                              );
                              const siblingDefault =
                                siblingDef && 'default' in siblingDef
                                  ? siblingDef.default
                                  : undefined;
                              const current = getToolOptionValue(
                                tool.name,
                                optionId,
                                siblingDefault as ToolOptionValue
                              );
                              const matches = Array.isArray(value)
                                ? (value as ReadonlyArray<unknown>).includes(current)
                                : current === value;
                              if (!matches) return null;
                            }

                            // Boolean option - checkbox
                            if (isBooleanOption(opt)) {
                              return (
                                <div key={opt.id} className="flex items-center justify-between">
                                  <div>
                                    <label
                                      htmlFor={`tool-${tool.name}-${opt.id}`}
                                      className="cursor-pointer text-sm font-medium text-gray-900"
                                    >
                                      {opt.label}
                                    </label>
                                    {opt.subtitle && (
                                      <p className="text-xs text-gray-500">{opt.subtitle}</p>
                                    )}
                                  </div>
                                  <input
                                    id={`tool-${tool.name}-${opt.id}`}
                                    type="checkbox"
                                    checked={Boolean(
                                      getToolOptionValue(tool.name, opt.id, opt.default)
                                    )}
                                    onChange={e =>
                                      setToolOptionValue(tool.name, opt.id, e.target.checked)
                                    }
                                    className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                                  />
                                </div>
                              );
                            }

                            // Select option - segmented button group
                            if (isSelectOption(opt)) {
                              const raw = getToolOptionValue(tool.name, opt.id, opt.default);
                              const selectedValue = typeof raw === 'string' ? raw : opt.default;
                              return (
                                <div key={opt.id}>
                                  <div className="mb-1">
                                    <span className="text-sm font-medium text-gray-900">
                                      {opt.label}
                                    </span>
                                    {opt.subtitle && (
                                      <p className="text-xs text-gray-500">{opt.subtitle}</p>
                                    )}
                                  </div>
                                  <div className="flex flex-wrap gap-1">
                                    {opt.choices.map(choice => (
                                      <button
                                        key={choice.value}
                                        type="button"
                                        onClick={() =>
                                          setToolOptionValue(tool.name, opt.id, choice.value)
                                        }
                                        className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                                          selectedValue === choice.value
                                            ? 'border-blue-500 bg-blue-50 text-blue-700'
                                            : 'border-gray-300 bg-white text-gray-600 hover:border-gray-400'
                                        }`}
                                      >
                                        {choice.label}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              );
                            }

                            // Number option - inline number input
                            if (isNumberOption(opt)) {
                              const raw = getToolOptionValue(tool.name, opt.id, opt.default);
                              const numValue = typeof raw === 'number' ? raw : opt.default;
                              return (
                                <div key={opt.id} className="flex items-center justify-between">
                                  <div>
                                    <label
                                      htmlFor={`tool-${tool.name}-${opt.id}`}
                                      className="cursor-pointer text-sm font-medium text-gray-900"
                                    >
                                      {opt.label}
                                    </label>
                                    {opt.subtitle && (
                                      <p className="text-xs text-gray-500">{opt.subtitle}</p>
                                    )}
                                  </div>
                                  <NumberInput
                                    id={`tool-${tool.name}-${opt.id}`}
                                    value={numValue}
                                    min={opt.min}
                                    max={opt.max}
                                    integer
                                    onChange={next => setToolOptionValue(tool.name, opt.id, next)}
                                    className="w-20 rounded border border-gray-300 px-2 py-1 text-base text-gray-900 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                                  />
                                </div>
                              );
                            }

                            // Longtext option - preview with edit button
                            if (isLongtextOption(opt)) {
                              const value = getToolOptionValue(tool.name, opt.id, opt.default);
                              const textValue = typeof value === 'string' ? value : '';
                              return (
                                <div key={opt.id}>
                                  <div className="mb-1">
                                    <span className="text-sm font-medium text-gray-900">
                                      {opt.label}
                                    </span>
                                    {opt.subtitle && (
                                      <p className="text-xs text-gray-500">{opt.subtitle}</p>
                                    )}
                                  </div>
                                  <div
                                    onClick={() =>
                                      setLongtextModal({
                                        toolName: tool.name,
                                        optionId: opt.id,
                                        title: opt.label,
                                        placeholder: opt.placeholder,
                                      })
                                    }
                                    onKeyDown={e => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        setLongtextModal({
                                          toolName: tool.name,
                                          optionId: opt.id,
                                          title: opt.label,
                                          placeholder: opt.placeholder,
                                        });
                                      }
                                    }}
                                    role="button"
                                    tabIndex={0}
                                    className="flex w-full cursor-pointer items-center justify-between rounded-lg border border-gray-300 bg-white p-2 text-sm transition-colors hover:border-gray-400"
                                  >
                                    <span
                                      className={`min-w-0 flex-1 truncate ${textValue ? 'text-gray-900' : 'text-gray-500'}`}
                                    >
                                      {textValue || opt.placeholder || 'Not configured...'}
                                    </span>
                                    <span className="ml-2 flex-shrink-0 text-gray-600">✏️</span>
                                  </div>
                                </div>
                              );
                            }

                            // Model option - model selector button
                            if (isModelOption(opt)) {
                              const value = form.toolOptions[tool.name]?.[opt.id];
                              const modelRef = isModelReference(value) ? value : undefined;
                              return (
                                <div key={opt.id}>
                                  <div className="mb-1">
                                    <span className="text-sm font-medium text-gray-900">
                                      {opt.label}
                                    </span>
                                    {opt.subtitle && (
                                      <p className="text-xs text-gray-500">{opt.subtitle}</p>
                                    )}
                                  </div>
                                  <div
                                    onClick={() =>
                                      setModelOptionModal({
                                        toolName: tool.name,
                                        optionId: opt.id,
                                        title: opt.label,
                                      })
                                    }
                                    onKeyDown={e => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        setModelOptionModal({
                                          toolName: tool.name,
                                          optionId: opt.id,
                                          title: opt.label,
                                        });
                                      }
                                    }}
                                    role="button"
                                    tabIndex={0}
                                    className="flex w-full cursor-pointer items-center justify-between rounded-lg border border-gray-300 bg-white p-2 text-sm transition-colors hover:border-gray-400"
                                  >
                                    <span
                                      className={`min-w-0 flex-1 truncate ${modelRef ? 'text-gray-900' : 'text-gray-500'}`}
                                    >
                                      {getModelDisplayText(modelRef)}
                                    </span>
                                    <span className="ml-2 flex-shrink-0 text-gray-600">▼</span>
                                  </div>
                                </div>
                              );
                            }

                            // Model list option - list with add/remove
                            if (isModelListOption(opt)) {
                              const value = form.toolOptions[tool.name]?.[opt.id];
                              const modelList: ModelReference[] = isModelReferenceArray(value)
                                ? value
                                : [];
                              return (
                                <div key={opt.id}>
                                  <div className="mb-1">
                                    <span className="text-sm font-medium text-gray-900">
                                      {opt.label}
                                    </span>
                                    {opt.subtitle && (
                                      <p className="text-xs text-gray-500">{opt.subtitle}</p>
                                    )}
                                  </div>
                                  {/* Model rows */}
                                  <div className="space-y-1">
                                    {modelList.map((ref, idx) => (
                                      <div
                                        key={`${ref.apiDefinitionId}:${ref.modelId}`}
                                        className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-2 text-sm"
                                      >
                                        <span className="min-w-0 flex-1 truncate text-gray-900">
                                          {getModelDisplayText(ref)}
                                        </span>
                                        <button
                                          onClick={() => {
                                            const updated = modelList.filter((_, i) => i !== idx);
                                            setToolOptionValue(tool.name, opt.id, updated);
                                          }}
                                          className="ml-2 flex-shrink-0 text-gray-400 hover:text-red-500"
                                        >
                                          ✕
                                        </button>
                                      </div>
                                    ))}
                                    {/* Add button */}
                                    <button
                                      onClick={() =>
                                        setModelListAddModal({
                                          toolName: tool.name,
                                          optionId: opt.id,
                                          title: `Add ${opt.label}`,
                                        })
                                      }
                                      className="flex w-full items-center justify-center rounded-lg border-2 border-dashed border-gray-300 p-2 text-sm text-gray-500 transition-colors hover:border-gray-400 hover:text-gray-700"
                                    >
                                      ＋ Add Model
                                    </button>
                                  </div>
                                </div>
                              );
                            }

                            // Text option - inline text input
                            if (isTextOption(opt)) {
                              const value = getToolOptionValue(tool.name, opt.id, opt.default);
                              const textValue = typeof value === 'string' ? value : '';
                              return (
                                <div key={opt.id}>
                                  <div className="mb-1">
                                    <label
                                      htmlFor={`tool-${tool.name}-${opt.id}`}
                                      className="text-sm font-medium text-gray-900"
                                    >
                                      {opt.label}
                                    </label>
                                    {opt.subtitle && (
                                      <p className="text-xs text-gray-500">{opt.subtitle}</p>
                                    )}
                                  </div>
                                  <input
                                    id={`tool-${tool.name}-${opt.id}`}
                                    type="text"
                                    value={textValue}
                                    onChange={e =>
                                      setToolOptionValue(tool.name, opt.id, e.target.value)
                                    }
                                    placeholder={opt.placeholder}
                                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
                                  />
                                </div>
                              );
                            }

                            return null;
                          })}
                        </div>
                      )}
                  </div>
                ))}
              </div>
            </div>

            {/* Advanced Section */}
            <div className="mb-6 overflow-hidden rounded-lg border border-gray-200">
              {/* Section Header */}
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
                className="flex cursor-pointer items-center justify-between bg-gray-50 px-4 py-3 transition-colors hover:bg-gray-100"
              >
                <span className="text-sm font-semibold text-gray-900">Advanced</span>
                <span className="text-gray-600">{showAdvanced ? '▼' : '▶'}</span>
              </div>
              {/* Section Content */}
              {showAdvanced && (
                <div className="space-y-4 bg-white p-4">
                  {/* Pre-fill Response */}
                  <div>
                    <label className="mb-2 block text-sm font-medium text-gray-900">
                      Pre-fill Response
                    </label>
                    <p className="mb-2 text-xs text-gray-500">
                      Start assistant replies with this text. Only Anthropic supports this reliably.
                    </p>
                    <textarea
                      value={form.preFillResponse}
                      onChange={e => patch({ preFillResponse: e.target.value })}
                      placeholder="Optional pre-fill text..."
                      rows={2}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    />
                  </div>

                  {/* Max Output Tokens */}
                  <div>
                    <label className="mb-2 block text-sm font-medium text-gray-900">
                      Max Output Tokens
                    </label>
                    {form.enableReasoning &&
                      parseInt(form.maxOutputTokens) <= parseInt(form.reasoningBudgetTokens) && (
                        <p className="mb-2 text-xs text-yellow-700 italic">
                          ⚠️ Max tokens ≤ reasoning budget - will be auto-adjusted to{' '}
                          {(parseInt(form.reasoningBudgetTokens) || 0) + 500} for Anthropic
                        </p>
                      )}
                    <input
                      type="number"
                      value={form.maxOutputTokens}
                      onChange={e => patch({ maxOutputTokens: e.target.value })}
                      placeholder="1536"
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    />
                  </div>

                  {/* Disable Streaming */}
                  <div className="flex items-center justify-between">
                    <div>
                      <label
                        htmlFor="disableStream"
                        className="cursor-pointer text-sm font-medium text-gray-900"
                      >
                        Disable Streaming
                      </label>
                      <p className="text-xs text-gray-500">
                        Use non-streaming API calls (response appears all at once)
                      </p>
                      {isAnthropic && (
                        <p className="text-xs text-yellow-700 italic">
                          ⚠️ Non-streaming mode not implemented for Anthropic
                        </p>
                      )}
                    </div>
                    <input
                      id="disableStream"
                      type="checkbox"
                      checked={form.disableStream}
                      onChange={e => patch({ disableStream: e.target.checked })}
                      className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  {/* Extended Context (1M) */}
                  <div>
                    <div className="flex items-center justify-between">
                      <div>
                        <label
                          htmlFor="extendedContext"
                          className="cursor-pointer text-sm font-medium text-gray-900"
                        >
                          Extended Context (1M tokens)
                        </label>
                        <p className="text-xs text-gray-500">
                          Only applies to models that support it (Opus 4.6, Sonnet 4.5, Sonnet 4)
                        </p>
                      </div>
                      <input
                        id="extendedContext"
                        type="checkbox"
                        checked={form.extendedContext}
                        onChange={e => patch({ extendedContext: e.target.checked })}
                        className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    {form.extendedContext && (
                      <p className="mt-1 text-xs text-yellow-700 italic">
                        ⚠️ When input exceeds 200K tokens, all tokens are charged at premium rates
                        (2x input, 1.5x output)
                      </p>
                    )}
                  </div>

                  {/* No Line Numbers */}
                  <div className="flex items-center justify-between">
                    <div>
                      <label
                        htmlFor="noLineNumbers"
                        className="cursor-pointer text-sm font-medium text-gray-900"
                      >
                        No Line Numbers
                      </label>
                      <p className="text-xs text-gray-500">
                        Strip line number prefixes from filesystem and memory tool output
                      </p>
                    </div>
                    <input
                      id="noLineNumbers"
                      type="checkbox"
                      checked={form.noLineNumbers}
                      onChange={e => patch({ noLineNumbers: e.target.checked })}
                      className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  {/* 1-Hour Anthropic Cache TTL */}
                  <div className="flex items-center justify-between">
                    <div>
                      <label
                        htmlFor="useAnthropicOneHourCache"
                        className="cursor-pointer text-sm font-medium text-gray-900"
                      >
                        1-Hour Cache TTL
                      </label>
                      <p className="text-xs text-gray-500">
                        Anthropic only. Writes cost 2× input (vs 1.25× for 5m default); reads
                        unchanged. Helps when chats sit idle &gt;5 min between turns.
                      </p>
                    </div>
                    <input
                      id="useAnthropicOneHourCache"
                      type="checkbox"
                      checked={form.useAnthropicOneHourCache}
                      onChange={e => patch({ useAnthropicOneHourCache: e.target.checked })}
                      className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  {/* Cache Routing Scope */}
                  <div>
                    <div className="mb-2">
                      <span className="text-sm font-medium text-gray-900">Cache Routing Scope</span>
                      <p className="text-xs text-gray-500">
                        Opaque ID sent as <code>prompt_cache_key</code> (OpenAI) or{' '}
                        <code>metadata.user_id</code> (Anthropic). Steers the provider's shard so
                        the same prefix lands on the same backend. On the ChatGPT subscription
                        provider it also rides as the <code>session_id</code> /{' '}
                        <code>conversation_id</code> headers, which is what that backend actually
                        keys its prompt cache on — <span className="font-medium">Per chat</span>{' '}
                        matches how the Codex CLI does it.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <label className="flex cursor-pointer items-start gap-2">
                        <input
                          type="radio"
                          name="cacheRoutingScope"
                          value="project"
                          checked={form.cacheRoutingScope === 'project'}
                          onChange={() => patch({ cacheRoutingScope: 'project' })}
                          className="mt-0.5 h-4 w-4 cursor-pointer text-blue-600 focus:ring-2 focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700">
                          <span className="font-medium">Project</span> (default) — every chat in
                          this project shares one routing bucket. Best cache hit rate.
                        </span>
                      </label>
                      <label className="flex cursor-pointer items-start gap-2">
                        <input
                          type="radio"
                          name="cacheRoutingScope"
                          value="chat"
                          checked={form.cacheRoutingScope === 'chat'}
                          onChange={() => patch({ cacheRoutingScope: 'chat' })}
                          className="mt-0.5 h-4 w-4 cursor-pointer text-blue-600 focus:ring-2 focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700">
                          <span className="font-medium">Per chat</span> — isolates each chat and
                          each minion sub-chat. Use if parallel chats fight for the same cache slot.
                        </span>
                      </label>
                    </div>
                  </div>

                  {/* Flex / batch tier */}
                  <div>
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        checked={form.flexTierEnabled}
                        onChange={e => patch({ flexTierEnabled: e.target.checked })}
                        className="mt-0.5 h-4 w-4 text-blue-600 focus:ring-2 focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-700">
                        <span className="font-medium">
                          Use flex / batch tier on supported providers
                        </span>{' '}
                        — opt into the discounted, lower-priority tier. Evaluated per call against
                        the active provider, so minions on a flex-supporting provider get the
                        discount even when the main provider doesn't. Cost is reported at 0.5×.
                        {!flexSupported && (
                          <span className="mt-1 block text-xs text-gray-500">
                            This project's current provider does not have "Supports flex tier"
                            enabled, so the flag is a no-op for direct calls here. Minions using a
                            different provider can still use it.
                          </span>
                        )}
                      </span>
                    </label>
                  </div>

                  {/* Verbosity (OpenAI only) */}
                  <div>
                    <label className="mb-2 block text-sm font-medium text-gray-900">
                      Verbosity
                    </label>
                    <select
                      value={form.verbosity ?? ''}
                      onChange={e =>
                        patch({
                          verbosity:
                            e.target.value === '' ? undefined : (e.target.value as Verbosity),
                        })
                      }
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    >
                      <option value="">(default)</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                    <p className="mt-1 text-xs text-gray-500">
                      OpenAI only. Constrains answer length independently of max output tokens and
                      reasoning effort. Sent only to GPT-5-era models — if it seems ignored, refresh
                      the model list in Settings so cached models pick up the capability flag.
                      {!isOpenAICompatible && (
                        <span className="mt-1 block">
                          This project's current provider is not an OpenAI API, so the setting is a
                          no-op for direct calls here. Minions on an OpenAI provider still honor it.
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* Remote VFS Section — hidden when connected to a server backend */}
        {getStorageConfig().type !== 'server' && (
          <div className="mt-6 overflow-hidden rounded-lg border border-gray-200">
            <div
              onClick={() => setShowRemoteVfs(!showRemoteVfs)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setShowRemoteVfs(!showRemoteVfs);
                }
              }}
              role="button"
              tabIndex={0}
              className="flex cursor-pointer items-center justify-between bg-gray-50 px-4 py-3 transition-colors hover:bg-gray-100"
            >
              <span className="text-sm font-semibold text-gray-900">Remote VFS</span>
              <span className="text-gray-600">{showRemoteVfs ? '▼' : '▶'}</span>
            </div>
            {showRemoteVfs && (
              <div className="space-y-4 bg-white p-4">
                <p className="text-xs text-gray-500">
                  Store files on a remote VFS backend instead of encrypted local storage.
                </p>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Server URL</label>
                  <input
                    type="url"
                    value={form.remoteVfsUrl}
                    onChange={e => patch({ remoteVfsUrl: e.target.value })}
                    placeholder="https://vfs.example.com"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Password</label>
                  <input
                    type="password"
                    value={form.remoteVfsPassword}
                    onChange={e => patch({ remoteVfsPassword: e.target.value })}
                    placeholder="Server password (empty = dev mode)"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    if (!form.remoteVfsUrl.trim()) return;
                    setRemoteVfsTestStatus('testing');
                    try {
                      const url = form.remoteVfsUrl.replace(/\/+$/, '') + '/health';
                      const res = await fetch(url);
                      if (res.ok) {
                        const body = await res.json();
                        setRemoteVfsTestStatus(body.status === 'ok' ? 'ok' : 'error');
                      } else {
                        setRemoteVfsTestStatus('error');
                      }
                    } catch {
                      setRemoteVfsTestStatus('error');
                    }
                  }}
                  disabled={!form.remoteVfsUrl.trim() || remoteVfsTestStatus === 'testing'}
                  className="rounded-md bg-gray-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-50"
                >
                  {remoteVfsTestStatus === 'testing'
                    ? 'Testing...'
                    : remoteVfsTestStatus === 'ok'
                      ? 'Connected'
                      : remoteVfsTestStatus === 'error'
                        ? 'Failed — Retry'
                        : 'Test Connection'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Danger Zone Section */}
        <div className="mt-6 overflow-hidden rounded-lg border border-red-200">
          {/* Section Header */}
          <div
            onClick={() => setShowDangerZone(!showDangerZone)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setShowDangerZone(!showDangerZone);
              }
            }}
            role="button"
            tabIndex={0}
            className="flex cursor-pointer items-center justify-between bg-red-50 px-4 py-3 transition-colors hover:bg-red-100"
          >
            <span className="text-sm font-semibold text-red-900">Danger Zone</span>
            <span className="text-red-600">{showDangerZone ? '▼' : '▶'}</span>
          </div>
          {/* Section Content */}
          {showDangerZone && (
            <div className="bg-red-50 p-4">
              <button
                onClick={handleDelete}
                className="w-full rounded-lg bg-red-600 px-4 py-3 font-semibold text-white transition-colors hover:bg-red-700"
              >
                🗑️ Delete Project
              </button>
              <p className="mt-2 text-center text-xs text-red-700">
                This will permanently delete the project and all its chats.
              </p>
            </div>
          )}
        </div>

        {/* Bottom spacer */}
        <div className="h-20" />
      </div>

      {/* Footer with safe area */}
      <div className="border-t border-gray-200 bg-white">
        <div className="flex gap-3 p-4">
          <button
            onClick={handleCancel}
            disabled={isSaving}
            className="flex-1 rounded-lg border border-gray-300 px-4 py-3 font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
          >
            {isSaving && <Spinner size={16} colorClass="border-white" />}
            Save
          </button>
        </div>
        <div className="safe-area-inset-bottom" />
      </div>
    </div>
  );
}
