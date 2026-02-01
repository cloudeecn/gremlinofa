import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useApp } from '../../hooks/useApp';
import { useProject } from '../../hooks/useProject';
import { getApiDefinitionIcon } from '../../utils/apiTypeUtils';
import type { Project, APIType, ToolOptions } from '../../types';
import { useAlert } from '../../hooks/useAlert';
import { clearDraft } from '../../hooks/useDraftPersistence';
import Spinner from '../ui/Spinner';
import ModelSelector from './ModelSelector';
import SystemPromptModal from './SystemPromptModal';
import AnthropicReasoningConfig from './AnthropicReasoningConfig';
import OpenAIReasoningConfig from './OpenAIReasoningConfig';
import { toolRegistry } from '../../services/tools/clientSideTools';

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
  const [showSystemPromptModal, setShowSystemPromptModal] = useState(false);
  const [preFillResponse, setPreFillResponse] = useState(project?.preFillResponse || '');
  const [enableReasoning, setEnableReasoning] = useState(project?.enableReasoning || false);
  const [reasoningBudgetTokens, setReasoningBudgetTokens] = useState(
    project?.reasoningBudgetTokens.toString() || '1024'
  );
  const [thinkingKeepTurns, setThinkingKeepTurns] = useState(
    project?.thinkingKeepTurns !== undefined ? project.thinkingKeepTurns.toString() : ''
  );
  const [webSearchEnabled, setWebSearchEnabled] = useState(project?.webSearchEnabled || false);
  const [sendMessageMetadata, setSendMessageMetadata] = useState<boolean | 'template'>(
    project?.sendMessageMetadata || false
  );
  const [metadataTimestampMode, setMetadataTimestampMode] = useState<
    'utc' | 'local' | 'relative' | 'disabled'
  >(project?.metadataTimestampMode || 'disabled');
  const [metadataIncludeModelName, setMetadataIncludeModelName] = useState(
    project?.metadataIncludeModelName || false
  );
  const [metadataIncludeContextWindow, setMetadataIncludeContextWindow] = useState(
    project?.metadataIncludeContextWindow || false
  );
  const [metadataIncludeCost, setMetadataIncludeCost] = useState(
    project?.metadataIncludeCost || false
  );
  const [metadataTemplate, setMetadataTemplate] = useState(
    project?.metadataTemplate || '{{userMessage}}'
  );
  const [metadataNewContext, setMetadataNewContext] = useState(
    project?.metadataNewContext || false
  );
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);
  const tooltipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Unified tool state - replaces individual tool state variables
  const [enabledTools, setEnabledTools] = useState<string[]>(project?.enabledTools ?? []);
  const [toolOptionsState, setToolOptionsState] = useState<Record<string, ToolOptions>>(
    project?.toolOptions ?? {}
  );
  const [reasoningEffort, setReasoningEffort] = useState<
    'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined
  >(project?.reasoningEffort);
  const [reasoningSummary, setReasoningSummary] = useState<
    'auto' | 'concise' | 'detailed' | undefined
  >(project?.reasoningSummary);
  const [disableStream, setDisableStream] = useState(project?.disableStream || false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showDangerZone, setShowDangerZone] = useState(false);
  const [temperature, setTemperature] = useState(project?.temperature?.toString() || '');
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    project?.maxOutputTokens.toString() || '1536'
  );
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [selectedApiDefId, setSelectedApiDefId] = useState(project?.apiDefinitionId || null);
  const [selectedModelId, setSelectedModelId] = useState(project?.modelId || null);
  const [isSaving, setIsSaving] = useState(false);

  // Update form fields when project loads
  useEffect(() => {
    if (project) {
      setSystemPrompt(project.systemPrompt || '');
      setPreFillResponse(project.preFillResponse || '');
      setEnableReasoning(project.enableReasoning || false);
      setReasoningBudgetTokens(project.reasoningBudgetTokens.toString() || '1024');
      setThinkingKeepTurns(
        project.thinkingKeepTurns !== undefined ? project.thinkingKeepTurns.toString() : ''
      );
      setWebSearchEnabled(project.webSearchEnabled || false);
      setSendMessageMetadata(project.sendMessageMetadata || false);
      setMetadataTimestampMode(project.metadataTimestampMode || 'disabled');
      setMetadataIncludeModelName(project.metadataIncludeModelName || false);
      setMetadataIncludeContextWindow(project.metadataIncludeContextWindow || false);
      setMetadataIncludeCost(project.metadataIncludeCost || false);
      setMetadataTemplate(project.metadataTemplate || '{{userMessage}}');
      setMetadataNewContext(project.metadataNewContext || false);
      // Load unified tool state (projects are migrated on load)
      setEnabledTools(project.enabledTools ?? []);
      setToolOptionsState(project.toolOptions ?? {});
      setReasoningEffort(project.reasoningEffort);
      setReasoningSummary(project.reasoningSummary);
      setTemperature(project.temperature?.toString() || '');
      setMaxOutputTokens(project.maxOutputTokens.toString() || '1536');
      setSelectedApiDefId(project.apiDefinitionId || null);
      setSelectedModelId(project.modelId || null);
      setDisableStream(project.disableStream || false);
    }
  }, [project]);

  // Get API definition and model names for display
  const apiDef = selectedApiDefId ? apiDefinitions.find(a => a.id === selectedApiDefId) : null;
  const selectedApiType: APIType | null = apiDef?.apiType ?? null;

  // Check if any non-WebLLM API has credentials configured
  const hasConfiguredApis = apiDefinitions.some(
    def => def.apiType !== 'webllm' && def.apiKey?.trim()
  );

  // Detect if current model is an o-series reasoning model
  const isOSeriesModel =
    (selectedApiType === 'chatgpt' || selectedApiType === 'responses_api') &&
    selectedModelId?.startsWith('o');

  // Check selected API type for conditional UI
  const isAnthropic = selectedApiType === 'anthropic';
  const isWebLLM = selectedApiType === 'webllm';
  const hasModelSelected = !!selectedModelId;

  const modelDisplayText = hasModelSelected
    ? `${apiDef ? getApiDefinitionIcon(apiDef) + ' ' : ''}${apiDef?.name || 'Unknown'} • ${selectedModelId}`
    : 'Select a model to get started';

  // Get all available tools from registry
  const availableTools = useMemo(() => toolRegistry.getAllTools(), []);

  // Helper functions for tool state management
  const isToolEnabled = useCallback(
    (toolName: string) => enabledTools.includes(toolName),
    [enabledTools]
  );

  const toggleTool = useCallback(
    (toolName: string, enabled: boolean) => {
      if (enabled) {
        // Add to enabled list
        setEnabledTools(prev => [...prev.filter(t => t !== toolName), toolName]);

        // Initialize options with defaults from tool definition
        const tool = availableTools.find(t => t.name === toolName);
        if (tool?.optionDefinitions?.length) {
          setToolOptionsState(prev => {
            const defaults: ToolOptions = {};
            for (const opt of tool.optionDefinitions!) {
              defaults[opt.id] = opt.default;
            }
            return { ...prev, [toolName]: { ...defaults, ...prev[toolName] } };
          });
        }
      } else {
        // Remove from enabled list
        setEnabledTools(prev => prev.filter(t => t !== toolName));
      }
    },
    [availableTools]
  );

  const getToolOption = useCallback(
    (toolName: string, optionId: string, defaultValue: boolean) =>
      toolOptionsState[toolName]?.[optionId] ?? defaultValue,
    [toolOptionsState]
  );

  const setToolOption = useCallback((toolName: string, optionId: string, value: boolean) => {
    setToolOptionsState(prev => ({
      ...prev,
      [toolName]: { ...prev[toolName], [optionId]: value },
    }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!project) return;

    setIsSaving(true);
    try {
      const updatedProject: Project = {
        ...project,
        apiDefinitionId: selectedApiDefId,
        modelId: selectedModelId,
        systemPrompt,
        preFillResponse,
        enableReasoning,
        reasoningBudgetTokens: parseInt(reasoningBudgetTokens) || 1024,
        thinkingKeepTurns: thinkingKeepTurns === '' ? undefined : parseInt(thinkingKeepTurns),
        webSearchEnabled,
        sendMessageMetadata,
        metadataTimestampMode,
        metadataIncludeModelName,
        metadataIncludeContextWindow,
        metadataIncludeCost,
        metadataTemplate,
        metadataNewContext,
        // Unified tool format
        enabledTools: enabledTools.length > 0 ? enabledTools : undefined,
        toolOptions: Object.keys(toolOptionsState).length > 0 ? toolOptionsState : undefined,
        // Clear deprecated fields
        memoryEnabled: undefined,
        memoryUseSystemPrompt: undefined,
        jsExecutionEnabled: undefined,
        jsLibEnabled: undefined,
        fsToolEnabled: undefined,
        reasoningEffort,
        reasoningSummary,
        temperature: temperature === '' ? null : parseFloat(temperature),
        maxOutputTokens: parseInt(maxOutputTokens) || 1536,
        disableStream: disableStream || undefined,
        lastUsedAt: new Date(),
      };

      await updateProject(updatedProject);
      clearDraft('system-prompt-modal', projectId); // Clear draft when settings are saved
      navigate(`/project/${projectId}`);
    } finally {
      setIsSaving(false);
    }
  }, [
    project,
    selectedApiDefId,
    selectedModelId,
    systemPrompt,
    preFillResponse,
    enableReasoning,
    reasoningBudgetTokens,
    thinkingKeepTurns,
    webSearchEnabled,
    sendMessageMetadata,
    metadataTimestampMode,
    metadataIncludeModelName,
    metadataIncludeContextWindow,
    metadataIncludeCost,
    metadataTemplate,
    metadataNewContext,
    enabledTools,
    toolOptionsState,
    reasoningEffort,
    reasoningSummary,
    temperature,
    maxOutputTokens,
    disableStream,
    updateProject,
    projectId,
    navigate,
  ]);

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

      {/* System Prompt Modal */}
      <SystemPromptModal
        isOpen={showSystemPromptModal}
        projectId={projectId}
        initialValue={project.systemPrompt || ''}
        onSave={value => {
          setSystemPrompt(value);
          setShowSystemPromptModal(false);
        }}
        onCancel={() => setShowSystemPromptModal(false)}
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
                  className={`min-w-0 flex-1 truncate ${systemPrompt ? 'text-gray-900' : 'text-gray-500'}`}
                >
                  {systemPrompt || 'Configure system prompt...'}
                </span>
                <span className="ml-2 flex-shrink-0 text-gray-600">✏️</span>
              </div>
            </div>

            {/* Temperature - moved here for prominence */}
            <div className="mb-6">
              <label className="mb-2 block text-sm font-semibold text-gray-900">
                Temperature (0-1)
              </label>
              <p className="mb-2 text-xs text-gray-500">
                Lower values (0.3) may help WebLLM. Ignored by most reasoning models.
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

            {/* Unified Reasoning Section */}
            <div className="mb-6 overflow-hidden rounded-lg border border-gray-200">
              {/* Section Header with Enable Toggle */}
              <label className="flex w-full cursor-pointer items-center justify-between bg-gray-50 px-4 py-3">
                <span className="text-sm font-semibold text-gray-900">Reasoning</span>
                <input
                  type="checkbox"
                  checked={enableReasoning}
                  onChange={e => setEnableReasoning(e.target.checked)}
                  className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                />
              </label>
              {/* Section Content */}
              {enableReasoning && (
                <div className="space-y-6 bg-white p-4">
                  {/* Anthropic / Bedrock Claude Subsection */}
                  <div>
                    <h4 className="mb-3 text-xs font-medium tracking-wide text-gray-500 uppercase">
                      Anthropic / Bedrock Claude
                    </h4>
                    <AnthropicReasoningConfig
                      reasoningBudgetTokens={reasoningBudgetTokens}
                      setReasoningBudgetTokens={setReasoningBudgetTokens}
                      thinkingKeepTurns={thinkingKeepTurns}
                      setThinkingKeepTurns={setThinkingKeepTurns}
                      maxOutputTokens={maxOutputTokens}
                    />
                  </div>

                  {/* OpenAI / Nova / DeepSeek Subsection */}
                  <div className="border-t border-gray-100 pt-4">
                    <h4 className="mb-3 text-xs font-medium tracking-wide text-gray-500 uppercase">
                      OpenAI / Bedrock Nova / DeepSeek
                    </h4>
                    <OpenAIReasoningConfig
                      reasoningEffort={reasoningEffort}
                      setReasoningEffort={setReasoningEffort}
                      reasoningSummary={reasoningSummary}
                      setReasoningSummary={setReasoningSummary}
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
                      checked={sendMessageMetadata === false}
                      onChange={() => setSendMessageMetadata(false)}
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
                      checked={sendMessageMetadata === true}
                      onChange={() => setSendMessageMetadata(true)}
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
                      checked={sendMessageMetadata === 'template'}
                      onChange={() => setSendMessageMetadata('template')}
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
                {sendMessageMetadata === true && (
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
                            checked={metadataTimestampMode === 'utc'}
                            onChange={() => setMetadataTimestampMode('utc')}
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
                            checked={metadataTimestampMode === 'local'}
                            onChange={() => setMetadataTimestampMode('local')}
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
                            checked={metadataTimestampMode === 'relative'}
                            onChange={() => setMetadataTimestampMode('relative')}
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
                        checked={metadataIncludeModelName}
                        onChange={e => setMetadataIncludeModelName(e.target.checked)}
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
                        checked={metadataIncludeContextWindow}
                        onChange={e => setMetadataIncludeContextWindow(e.target.checked)}
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
                        checked={metadataIncludeCost}
                        onChange={e => setMetadataIncludeCost(e.target.checked)}
                        className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                )}

                {/* Template Mode Options */}
                {sendMessageMetadata === 'template' && (
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
                        value={metadataTemplate}
                        onChange={e => setMetadataTemplate(e.target.value)}
                        placeholder="{{userMessage}}"
                        rows={4}
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
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
                        checked={metadataNewContext}
                        onChange={e => setMetadataNewContext(e.target.checked)}
                        className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Tools Section - hidden for WebLLM */}
            {!isWebLLM && (
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
                      checked={webSearchEnabled}
                      onChange={e => setWebSearchEnabled(e.target.checked)}
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
                          <div className="mt-2 ml-4 space-y-2 border-l-2 border-gray-200 pl-4">
                            {tool.optionDefinitions.map(opt => (
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
                                  checked={getToolOption(tool.name, opt.id, opt.default)}
                                  onChange={e => setToolOption(tool.name, opt.id, e.target.checked)}
                                  className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                                />
                              </div>
                            ))}
                          </div>
                        )}
                    </div>
                  ))}
                </div>
              </div>
            )}

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
                      value={preFillResponse}
                      onChange={e => setPreFillResponse(e.target.value)}
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
                    {enableReasoning &&
                      parseInt(maxOutputTokens) <= parseInt(reasoningBudgetTokens) && (
                        <p className="mb-2 text-xs text-yellow-700 italic">
                          ⚠️ Max tokens ≤ reasoning budget - will be auto-adjusted to{' '}
                          {(parseInt(reasoningBudgetTokens) || 0) + 500} for Anthropic
                        </p>
                      )}
                    <input
                      type="number"
                      value={maxOutputTokens}
                      onChange={e => setMaxOutputTokens(e.target.value)}
                      placeholder="1536"
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
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
                      checked={disableStream}
                      onChange={e => setDisableStream(e.target.checked)}
                      className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              )}
            </div>
          </>
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
