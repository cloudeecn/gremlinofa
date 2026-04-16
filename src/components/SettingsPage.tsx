import { useState, useEffect, useCallback } from 'react';
import Spinner from './ui/Spinner';
import { useApp } from '../hooks/useApp';
import { useAlert } from '../hooks/useAlert';
import { useIsMobile } from '../hooks/useIsMobile';
import type { APIDefinition, APIType } from '../types';
import { generateUniqueId } from '../utils/idGenerator';
import {
  isWebGPUAvailable,
  checkWebGPUCapabilities,
  getSupportedBrowsers,
  type WebGPUCapabilities,
} from '../utils/webgpuCapabilities';
import {
  getApiTypeDisplayName,
  getApiTypeDefaultIcon,
  getApiDefinitionIcon,
} from '../utils/apiTypeUtils';

interface SettingsPageProps {
  onMenuPress?: () => void;
}

export default function SettingsPage({ onMenuPress }: SettingsPageProps) {
  const { apiDefinitions, saveAPIDefinition, deleteAPIDefinition, refreshModels } = useApp();
  const { showAlert, showDestructiveConfirm } = useAlert();
  const isMobile = useIsMobile();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [formApiType, setFormApiType] = useState<APIType>('responses_api');
  const [formName, setFormName] = useState('');
  const [formIcon, setFormIcon] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formIsLocal, setFormIsLocal] = useState(false);
  const [formModelsEndpoint, setFormModelsEndpoint] = useState('');
  const [formModelsEndpointDisabled, setFormModelsEndpointDisabled] = useState(false);
  const [formProxyUrl, setFormProxyUrl] = useState('');
  const [formExtraModelIds, setFormExtraModelIds] = useState('');
  const [formPruneThinking, setFormPruneThinking] = useState(false);
  const [formPruneEmptyText, setFormPruneEmptyText] = useState(false);
  const [formIsSubscription, setFormIsSubscription] = useState(false);
  const [formEnforceGenuineAnthropic, setFormEnforceGenuineAnthropic] = useState(false);
  const [formDeFactoThinking, setFormDeFactoThinking] = useState(false);
  const [formNudgeThinking, setFormNudgeThinking] = useState(false);
  const [formMandateCoT, setFormMandateCoT] = useState(false);
  const [formTreatEmptyOutputAsError, setFormTreatEmptyOutputAsError] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // WebGPU capability state
  const [webgpuCapabilities, setWebgpuCapabilities] = useState<WebGPUCapabilities | null>(null);
  const hasWebGPU = isWebGPUAvailable();

  // Check WebGPU capabilities on mount
  useEffect(() => {
    if (hasWebGPU) {
      checkWebGPUCapabilities().then(setWebgpuCapabilities);
    }
  }, [hasWebGPU]);

  const handleCancel = () => {
    setEditingId(null);
    setIsAddingNew(false);
    setFormApiType('responses_api');
    setFormName('');
    setFormIcon('');
    setFormBaseUrl('');
    setFormApiKey('');
    setFormIsLocal(false);
    setFormModelsEndpoint('');
    setFormModelsEndpointDisabled(false);
    setFormProxyUrl('');
    setFormExtraModelIds('');
    setFormPruneThinking(false);
    setFormPruneEmptyText(false);
    setFormDeFactoThinking(false);
    setFormNudgeThinking(false);
    setFormMandateCoT(false);
    setShowAdvanced(false);
  };

  const apiTypes = [
    { id: 'responses_api', name: 'OpenAI - Responses (new)', icon: '⚡' },
    { id: 'chatgpt', name: 'OpenAI - Chat Completions', icon: '💬' },
    { id: 'anthropic', name: 'Anthropic', icon: '✨' },
    { id: 'bedrock', name: 'AWS Bedrock', icon: '☁️' },
    { id: 'google', name: 'Google Gemini', icon: '💎' },
    { id: 'webllm', name: 'WebLLM (Local)', icon: '🏠' },
  ] as const;

  // Check if API type requires an API key
  const requiresApiKey = (apiType: APIType): boolean => {
    return apiType !== 'webllm';
  };

  const handleStartEdit = (def: APIDefinition) => {
    setEditingId(def.id);
    setIsAddingNew(false);
    setFormApiType(def.apiType);
    setFormName(def.name);
    setFormIcon(def.icon || '');
    setFormBaseUrl(def.baseUrl);
    setFormApiKey(def.apiKey);
    setFormIsLocal(def.isLocal || false);
    setFormModelsEndpoint(def.modelsEndpoint || '');
    setFormModelsEndpointDisabled(def.modelsEndpointDisabled || false);
    setFormProxyUrl(def.proxyUrl || '');
    setFormExtraModelIds((def.extraModelIds || []).join('\n'));
    setFormPruneThinking(def.advancedSettings?.pruneThinking || false);
    setFormPruneEmptyText(def.advancedSettings?.pruneEmptyText || false);
    setFormIsSubscription(def.advancedSettings?.isSubscription || false);
    setFormEnforceGenuineAnthropic(def.advancedSettings?.enforceGenuineAnthropic || false);
    setFormDeFactoThinking(def.advancedSettings?.deFactoThinking || false);
    setFormNudgeThinking(def.advancedSettings?.nudgeThinking || false);
    setFormMandateCoT(def.advancedSettings?.mandateCoT || false);
    setFormTreatEmptyOutputAsError(def.advancedSettings?.treatEmptyOutputAsError || false);
    setShowAdvanced(false);
  };

  const handleStartAdvanced = (def: APIDefinition) => {
    setEditingId(def.id);
    setIsAddingNew(false);
    setFormPruneThinking(def.advancedSettings?.pruneThinking || false);
    setFormPruneEmptyText(def.advancedSettings?.pruneEmptyText || false);
    setFormIsSubscription(def.advancedSettings?.isSubscription || false);
    setFormEnforceGenuineAnthropic(def.advancedSettings?.enforceGenuineAnthropic || false);
    setFormDeFactoThinking(def.advancedSettings?.deFactoThinking || false);
    setFormNudgeThinking(def.advancedSettings?.nudgeThinking || false);
    setFormMandateCoT(def.advancedSettings?.mandateCoT || false);
    setFormTreatEmptyOutputAsError(def.advancedSettings?.treatEmptyOutputAsError || false);
    setShowAdvanced(true);
  };

  const handleStartAdd = () => {
    setIsAddingNew(true);
    setEditingId(null);
    setFormApiType('responses_api');
    setFormName('');
    setFormIcon('');
    setFormBaseUrl('');
    setFormApiKey('');
    setFormIsLocal(false);
    setFormModelsEndpoint('');
    setFormModelsEndpointDisabled(false);
    setFormProxyUrl('');
    setFormExtraModelIds('');
    setFormPruneThinking(false);
    setFormPruneEmptyText(false);
    setFormDeFactoThinking(false);
    setFormNudgeThinking(false);
    setFormMandateCoT(false);
    setFormTreatEmptyOutputAsError(false);
    setShowAdvanced(false);
  };

  const handleSave = useCallback(async () => {
    // Validate name is always required
    if (!formName.trim()) {
      await showAlert('Error', 'Name is required');
      return;
    }

    // API key is required for non-WebLLM, non-local types
    if (requiresApiKey(formApiType) && !formIsLocal && !formApiKey.trim()) {
      await showAlert('Error', 'API Key is required for this provider (or mark as Local)');
      return;
    }

    setIsSaving(true);
    try {
      const def: APIDefinition = {
        id: editingId || generateUniqueId(`api_${formApiType}`),
        apiType: formApiType,
        name: formName.trim(),
        icon: formIcon.trim() || undefined,
        baseUrl: formBaseUrl.trim(),
        apiKey: formApiKey.trim(),
        isDefault: editingId ? apiDefinitions.find(d => d.id === editingId)?.isDefault : false,
        isLocal: formIsLocal,
        modelsEndpoint: formModelsEndpoint.trim() || undefined,
        modelsEndpointDisabled: formModelsEndpointDisabled || undefined,
        proxyUrl: formProxyUrl.trim() || undefined,
        extraModelIds: formExtraModelIds.trim()
          ? formExtraModelIds
              .split('\n')
              .map(s => s.trim())
              .filter(Boolean)
          : undefined,
        advancedSettings:
          formPruneThinking ||
          formPruneEmptyText ||
          formDeFactoThinking ||
          formNudgeThinking ||
          formMandateCoT ||
          formTreatEmptyOutputAsError
            ? {
                ...(formPruneThinking && { pruneThinking: true }),
                ...(formPruneEmptyText && { pruneEmptyText: true }),
                ...(formDeFactoThinking && { deFactoThinking: true }),
                ...(formNudgeThinking && { nudgeThinking: true }),
                ...(formMandateCoT && { mandateCoT: true }),
                ...(formTreatEmptyOutputAsError && { treatEmptyOutputAsError: true }),
              }
            : undefined,
        createdAt: editingId
          ? apiDefinitions.find(d => d.id === editingId)?.createdAt || new Date()
          : new Date(),
        updatedAt: new Date(),
      };

      await saveAPIDefinition(def);

      // Always force refresh models when saving (forceRefresh=true)
      // This ensures users get updated model lists immediately
      await refreshModels(def.id, true);

      handleCancel();
    } finally {
      setIsSaving(false);
    }
  }, [
    formName,
    formIcon,
    formApiType,
    formIsLocal,
    formApiKey,
    formModelsEndpoint,
    formModelsEndpointDisabled,
    formProxyUrl,
    formExtraModelIds,
    formPruneThinking,
    formPruneEmptyText,
    formDeFactoThinking,
    formNudgeThinking,
    formMandateCoT,
    formTreatEmptyOutputAsError,
    editingId,
    apiDefinitions,
    formBaseUrl,
    saveAPIDefinition,
    refreshModels,
    showAlert,
  ]);

  const handleSaveAdvanced = useCallback(async () => {
    if (!editingId) return;
    const existing = apiDefinitions.find(d => d.id === editingId);
    if (!existing) return;

    setIsSaving(true);
    try {
      await saveAPIDefinition({
        ...existing,
        advancedSettings:
          formPruneThinking ||
          formPruneEmptyText ||
          formIsSubscription ||
          formEnforceGenuineAnthropic ||
          formDeFactoThinking ||
          formNudgeThinking ||
          formMandateCoT ||
          formTreatEmptyOutputAsError
            ? {
                ...(formPruneThinking && { pruneThinking: true }),
                ...(formPruneEmptyText && { pruneEmptyText: true }),
                ...(formIsSubscription && { isSubscription: true }),
                ...(formEnforceGenuineAnthropic && { enforceGenuineAnthropic: true }),
                ...(formDeFactoThinking && { deFactoThinking: true }),
                ...(formNudgeThinking && { nudgeThinking: true }),
                ...(formMandateCoT && { mandateCoT: true }),
                ...(formTreatEmptyOutputAsError && { treatEmptyOutputAsError: true }),
              }
            : undefined,
        updatedAt: new Date(),
      });
      handleCancel();
    } finally {
      setIsSaving(false);
    }
  }, [
    editingId,
    apiDefinitions,
    formPruneThinking,
    formPruneEmptyText,
    formIsSubscription,
    formEnforceGenuineAnthropic,
    formDeFactoThinking,
    formNudgeThinking,
    formMandateCoT,
    formTreatEmptyOutputAsError,
    saveAPIDefinition,
  ]);

  const handleDelete = async (def: APIDefinition) => {
    const confirmed = await showDestructiveConfirm(
      'Delete API Definition',
      `Delete "${def.name}"?`,
      'Delete'
    );

    if (confirmed) {
      await deleteAPIDefinition(def.id);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-gray-50">
      {/* Header with safe area */}
      <div className="border-b border-gray-200 bg-white">
        <div className="safe-area-inset-top" />
        <div className="flex h-14 items-center px-4">
          {isMobile && onMenuPress && (
            <button
              onClick={onMenuPress}
              className="-ml-2 flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-gray-100"
            >
              <span className="text-2xl text-gray-700">☰</span>
            </button>
          )}
          <h1 className="flex-1 text-center text-lg font-semibold text-gray-900">Settings</h1>
          {/* Spacer for centering on mobile */}
          {isMobile && onMenuPress && <div className="w-11" />}
        </div>
      </div>

      {/* Content */}
      <div className="ios-scroll scroll-safe-bottom flex-1 overflow-y-auto overscroll-y-contain p-4">
        <div className="mx-auto max-w-2xl space-y-8">
          {/* API Definitions Section */}
          <section>
            <h3 className="mb-2 text-lg font-semibold text-gray-900">API Definitions</h3>
            <p className="mb-4 text-sm text-gray-600">
              Configure your API keys for different providers
            </p>

            {/* List of API Definitions */}
            <div className="space-y-3">
              {apiDefinitions.map(def => {
                const hasApiKey = def.apiKey && def.apiKey.trim() !== '';
                const isEditing = editingId === def.id;
                const needsApiKey = requiresApiKey(def.apiType) && !def.isLocal;

                // Determine status badge
                let statusBadgeClass = '';
                let statusText = '';
                if (!needsApiKey) {
                  // WebLLM or isLocal - show Local badge
                  if (def.apiType === 'webllm' && !hasWebGPU) {
                    statusBadgeClass = 'bg-yellow-100 text-yellow-800';
                    statusText = 'No WebGPU';
                  } else {
                    statusBadgeClass = 'bg-blue-100 text-blue-800';
                    statusText = 'Local';
                  }
                } else if (hasApiKey) {
                  statusBadgeClass = 'bg-green-100 text-green-800';
                  statusText = 'Configured';
                } else {
                  statusBadgeClass = 'bg-red-100 text-red-800';
                  statusText = 'Not Set';
                }

                return (
                  <div key={def.id} className="rounded-lg border border-gray-200 bg-white p-4">
                    {!isEditing ? (
                      // Display mode
                      <>
                        <div className="mb-3 flex items-start justify-between">
                          <div className="flex flex-1 items-start">
                            <span className="mr-3 text-2xl">{getApiDefinitionIcon(def)}</span>
                            <div className="flex-1">
                              <div className="mb-1 text-xs tracking-wide text-gray-500 uppercase">
                                {getApiTypeDisplayName(def.apiType)}
                              </div>
                              <div className="mb-1 text-base font-semibold text-gray-900">
                                {def.name}
                              </div>
                              {def.baseUrl ? (
                                <div className="text-xs text-gray-600">{def.baseUrl}</div>
                              ) : (
                                <div className="text-xs text-gray-400 italic">(default)</div>
                              )}
                              {def.proxyUrl && (
                                <div className="text-xs text-indigo-600">
                                  via proxy: {def.proxyUrl}
                                </div>
                              )}
                            </div>
                          </div>
                          <span
                            className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass}`}
                          >
                            {statusText}
                          </span>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleStartEdit(def)}
                            className="rounded border border-blue-600 px-3 py-1.5 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleStartAdvanced(def)}
                            className="rounded border border-gray-400 px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50"
                          >
                            Advanced
                          </button>
                          <button
                            onClick={() => handleDelete(def)}
                            className="rounded border border-red-600 px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    ) : showAdvanced ? (
                      // Advanced settings form
                      <div>
                        <div className="mb-4 text-base font-semibold text-gray-900">
                          Advanced: {getApiDefinitionIcon(def)} {getApiTypeDisplayName(def.apiType)}
                        </div>

                        <label className="mb-2 flex cursor-pointer items-center">
                          <input
                            type="checkbox"
                            checked={formPruneThinking}
                            onChange={e => setFormPruneThinking(e.target.checked)}
                            className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          <span className="text-sm text-gray-700">
                            Prune previous thinking blocks
                          </span>
                        </label>
                        <p className="mb-3 ml-6 text-xs text-gray-500">
                          Strips thinking/reasoning from older messages. Enable if your provider
                          rejects thinking blocks.
                        </p>

                        <label className="mb-2 flex cursor-pointer items-center">
                          <input
                            type="checkbox"
                            checked={formPruneEmptyText}
                            onChange={e => setFormPruneEmptyText(e.target.checked)}
                            className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          <span className="text-sm text-gray-700">Prune empty text blocks</span>
                        </label>
                        <p className="mb-3 ml-6 text-xs text-gray-500">
                          Removes empty text blocks from older messages.
                        </p>

                        <label className="mb-2 flex cursor-pointer items-center">
                          <input
                            type="checkbox"
                            checked={formIsSubscription}
                            onChange={e => setFormIsSubscription(e.target.checked)}
                            className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          <span className="text-sm text-gray-700">Subscription service</span>
                        </label>
                        <p className="mb-3 ml-6 text-xs text-gray-500">
                          Flat-rate subscription — all usage is tracked as $0.
                        </p>

                        <label className="mb-2 flex cursor-pointer items-center">
                          <input
                            type="checkbox"
                            checked={formDeFactoThinking}
                            onChange={e => setFormDeFactoThinking(e.target.checked)}
                            className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          <span className="text-sm text-gray-700">De facto thinking mode</span>
                        </label>
                        <p className="mb-3 ml-6 text-xs text-gray-500">
                          Sends {'{'}thinking: {'{'}type: enabled/disabled{'}'}
                          {'}'} in request body. Used by DeepSeek, Kimi, MiMo, and other providers.
                        </p>

                        <label className="mb-2 flex cursor-pointer items-center">
                          <input
                            type="checkbox"
                            checked={formEnforceGenuineAnthropic}
                            onChange={e => setFormEnforceGenuineAnthropic(e.target.checked)}
                            className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          <span className="text-sm text-gray-700">Enforce genuine Anthropic</span>
                        </label>
                        <p className="mb-3 ml-6 text-xs text-gray-500">
                          Rejects responses with zero cache activity or unsigned thinking blocks —
                          catches API routers silently forwarding to non-Anthropic providers.
                        </p>

                        <label className="mb-2 flex cursor-pointer items-center">
                          <input
                            type="checkbox"
                            checked={formNudgeThinking}
                            onChange={e => setFormNudgeThinking(e.target.checked)}
                            className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          <span className="text-sm text-gray-700">Nudge model to think</span>
                        </label>
                        <p className="mb-3 ml-6 text-xs text-gray-500">
                          Appends a thinking prompt to the last user message. Useful for models that
                          need a nudge to use chain-of-thought.
                        </p>

                        <label className="mb-2 flex cursor-pointer items-center">
                          <input
                            type="checkbox"
                            checked={formMandateCoT}
                            onChange={e => setFormMandateCoT(e.target.checked)}
                            className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          <span className="text-sm text-gray-700">Mandate chain-of-thought</span>
                        </label>
                        <p className="mb-3 ml-6 text-xs text-gray-500">
                          Requires at least one response with reasoning tokens or thinking blocks
                          per agentic run. Triggers minion savepoint rollback on retry.
                        </p>

                        <label className="mb-2 flex cursor-pointer items-center">
                          <input
                            type="checkbox"
                            checked={formTreatEmptyOutputAsError}
                            onChange={e => setFormTreatEmptyOutputAsError(e.target.checked)}
                            className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          <span className="text-sm text-gray-700">Treat empty output as error</span>
                        </label>
                        <p className="mb-4 ml-6 text-xs text-gray-500">
                          Returns an error when a turn produces text that trims to empty and has no
                          tool calls. Catches degenerate responses from unreliable providers.
                        </p>

                        <div className="flex justify-end gap-2">
                          <button
                            onClick={handleCancel}
                            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleSaveAdvanced}
                            disabled={isSaving}
                            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
                          >
                            {isSaving && <Spinner size={14} colorClass="border-white" />}
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      // Inline edit mode
                      <div>
                        <div className="mb-4 text-base font-semibold text-gray-900">
                          Edit: {getApiDefinitionIcon(def)} {getApiTypeDisplayName(def.apiType)}
                        </div>

                        <label className="mb-1.5 block text-sm font-medium text-gray-700">
                          Name *
                        </label>
                        <input
                          type="text"
                          className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                          placeholder="e.g., xAI, OpenRouter, My OpenAI"
                          value={formName}
                          onChange={e => setFormName(e.target.value)}
                        />

                        <label className="mb-1.5 block text-sm font-medium text-gray-700">
                          Icon (Optional)
                        </label>
                        <input
                          type="text"
                          className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                          placeholder={getApiTypeDefaultIcon(def.apiType)}
                          value={formIcon}
                          onChange={e => setFormIcon(e.target.value)}
                          maxLength={2}
                        />

                        <label className="mb-1.5 block text-sm font-medium text-gray-700">
                          Base URL (Optional)
                        </label>
                        <input
                          type="text"
                          className={`w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-500 ${def.apiType === 'anthropic' ? 'mb-1' : 'mb-3'}`}
                          placeholder="Leave empty for provider default"
                          value={formBaseUrl}
                          onChange={e => setFormBaseUrl(e.target.value)}
                        />
                        {def.apiType === 'anthropic' && (
                          <p className="mb-3 text-xs text-gray-500">
                            You can enter{' '}
                            <code className="rounded bg-gray-100 px-1">bedrock:&lt;region&gt;</code>{' '}
                            to use Claude models in Bedrock
                          </p>
                        )}
                        {def.apiType === 'bedrock' && (
                          <p className="mb-3 text-xs text-gray-500">
                            You can enter just a region (e.g.,{' '}
                            <code className="rounded bg-gray-100 px-1">us-west-2</code>) instead of
                            the full URL
                          </p>
                        )}

                        {requiresApiKey(def.apiType) ? (
                          <>
                            {/* Local provider checkbox */}
                            <label className="mb-3 flex cursor-pointer items-center">
                              <input
                                type="checkbox"
                                checked={formIsLocal}
                                onChange={e => setFormIsLocal(e.target.checked)}
                                className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                              />
                              <span className="text-sm text-gray-700">
                                🏠 Local provider (API key optional)
                              </span>
                            </label>

                            <label className="mb-1.5 block text-sm font-medium text-gray-700">
                              API Key {formIsLocal ? '(Optional)' : '*'}
                            </label>
                            <input
                              type="password"
                              className="mb-4 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                              placeholder="Enter your API key"
                              value={formApiKey}
                              onChange={e => setFormApiKey(e.target.value)}
                            />
                          </>
                        ) : hasWebGPU ? (
                          <div className="mb-4 space-y-2">
                            <div className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
                              🏠 Local model - no API key required. Models run entirely on your
                              device using WebGPU.
                            </div>
                            {webgpuCapabilities?.adapterInfo && (
                              <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
                                <span className="font-medium">GPU:</span>{' '}
                                {webgpuCapabilities.adapterInfo.description !== 'Unknown'
                                  ? webgpuCapabilities.adapterInfo.description
                                  : `${webgpuCapabilities.adapterInfo.vendor} ${webgpuCapabilities.adapterInfo.device}`}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="mb-4 rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800">
                            <div className="mb-1 font-medium">⚠️ WebGPU Not Available</div>
                            <p className="mb-2">
                              Local models require WebGPU which isn't supported in your browser.
                            </p>
                            <p className="text-xs">
                              Supported browsers: {getSupportedBrowsers().join(', ')}
                            </p>
                          </div>
                        )}

                        <label className="mb-1.5 block text-sm font-medium text-gray-700">
                          Models Endpoint (Optional)
                        </label>
                        <input
                          type="text"
                          className={`mb-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-500 ${formModelsEndpointDisabled ? 'cursor-not-allowed bg-gray-100 text-gray-400' : ''}`}
                          placeholder="SDK default"
                          value={formModelsEndpoint}
                          onChange={e => setFormModelsEndpoint(e.target.value)}
                          disabled={formModelsEndpointDisabled}
                        />
                        <label className="mb-4 flex items-center gap-2 text-sm text-gray-600">
                          <input
                            type="checkbox"
                            checked={formModelsEndpointDisabled}
                            onChange={e => setFormModelsEndpointDisabled(e.target.checked)}
                            className="rounded border-gray-300"
                          />
                          Models endpoint not supported
                        </label>

                        <label className="mb-1.5 block text-sm font-medium text-gray-700">
                          Extra Model IDs (Optional)
                        </label>
                        <textarea
                          className="mb-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                          placeholder="one-model-id-per-line"
                          rows={3}
                          value={formExtraModelIds}
                          onChange={e => setFormExtraModelIds(e.target.value)}
                        />
                        <p className="mb-4 text-xs text-gray-500">
                          Add model IDs not listed by the provider (one per line)
                        </p>

                        {def.apiType !== 'bedrock' && def.apiType !== 'webllm' && (
                          <>
                            <label className="mb-1.5 block text-sm font-medium text-gray-700">
                              CORS Proxy URL (Optional)
                            </label>
                            <input
                              type="text"
                              className="mb-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                              placeholder="e.g., https://myserver.com/cors-proxy"
                              value={formProxyUrl}
                              onChange={e => setFormProxyUrl(e.target.value)}
                            />
                            <p className="mb-4 text-xs text-gray-500">
                              Routes API traffic through a CORS proxy server
                            </p>
                          </>
                        )}

                        <div className="flex justify-end gap-2">
                          <button
                            onClick={handleCancel}
                            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleSave}
                            disabled={isSaving}
                            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
                          >
                            {isSaving && <Spinner size={14} colorClass="border-white" />}
                            Save
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Add New Form */}
              {isAddingNew && (
                <div className="rounded-lg border border-gray-200 bg-white p-4">
                  {showAdvanced ? (
                    // Advanced settings form
                    <div>
                      <div className="mb-4 flex items-center gap-2">
                        <button
                          onClick={() => setShowAdvanced(false)}
                          className="text-sm text-blue-600 hover:text-blue-800"
                        >
                          ← Back
                        </button>
                        <span className="text-base font-semibold text-gray-900">
                          Advanced Settings
                        </span>
                      </div>

                      <label className="mb-2 flex cursor-pointer items-center">
                        <input
                          type="checkbox"
                          checked={formPruneThinking}
                          onChange={e => setFormPruneThinking(e.target.checked)}
                          className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700">
                          Prune previous thinking blocks
                        </span>
                      </label>
                      <p className="mb-3 ml-6 text-xs text-gray-500">
                        Strips thinking/reasoning from older messages. Enable if your provider
                        rejects thinking blocks.
                      </p>

                      <label className="mb-2 flex cursor-pointer items-center">
                        <input
                          type="checkbox"
                          checked={formPruneEmptyText}
                          onChange={e => setFormPruneEmptyText(e.target.checked)}
                          className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700">Prune empty text blocks</span>
                      </label>
                      <p className="mb-3 ml-6 text-xs text-gray-500">
                        Removes empty text blocks from older messages.
                      </p>

                      <label className="mb-2 flex cursor-pointer items-center">
                        <input
                          type="checkbox"
                          checked={formDeFactoThinking}
                          onChange={e => setFormDeFactoThinking(e.target.checked)}
                          className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700">De facto thinking mode</span>
                      </label>
                      <p className="mb-3 ml-6 text-xs text-gray-500">
                        Sends {'{'}thinking: {'{'}type: enabled/disabled{'}'}
                        {'}'} in request body. Used by DeepSeek, Kimi, MiMo, and other providers.
                      </p>

                      <label className="mb-2 flex cursor-pointer items-center">
                        <input
                          type="checkbox"
                          checked={formNudgeThinking}
                          onChange={e => setFormNudgeThinking(e.target.checked)}
                          className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700">Nudge model to think</span>
                      </label>
                      <p className="mb-3 ml-6 text-xs text-gray-500">
                        Appends a thinking prompt to the last user message. Useful for models that
                        need a nudge to use chain-of-thought.
                      </p>

                      <label className="mb-2 flex cursor-pointer items-center">
                        <input
                          type="checkbox"
                          checked={formMandateCoT}
                          onChange={e => setFormMandateCoT(e.target.checked)}
                          className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700">Mandate chain-of-thought</span>
                      </label>
                      <p className="ml-6 text-xs text-gray-500">
                        Requires at least one response with reasoning tokens or thinking blocks per
                        agentic run. Triggers minion savepoint rollback on retry.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="mb-4 text-base font-semibold text-gray-900">
                        Add New API Definition
                      </div>

                      <label className="mb-1.5 block text-sm font-medium text-gray-700">
                        API Type
                      </label>
                      <div className="mb-3 grid grid-cols-2 gap-2">
                        {apiTypes.map(type => (
                          <button
                            key={type.id}
                            onClick={() => setFormApiType(type.id)}
                            className={`flex items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                              formApiType === type.id
                                ? 'border-blue-600 bg-blue-50 text-blue-900'
                                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                            }`}
                          >
                            <span className="mr-2">{type.icon}</span>
                            {type.name}
                          </button>
                        ))}
                      </div>
                      {formApiType === 'bedrock' && (
                        <p className="mb-3 text-xs text-gray-500">
                          💡 You can also choose "Anthropic" to use Claude models in Bedrock.
                        </p>
                      )}

                      <label className="mb-1.5 block text-sm font-medium text-gray-700">
                        Name *
                      </label>
                      <input
                        type="text"
                        className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                        placeholder="e.g., xAI, OpenRouter, My OpenAI"
                        value={formName}
                        onChange={e => setFormName(e.target.value)}
                      />

                      <label className="mb-1.5 block text-sm font-medium text-gray-700">
                        Icon (Optional)
                      </label>
                      <input
                        type="text"
                        className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                        placeholder={getApiTypeDefaultIcon(formApiType)}
                        value={formIcon}
                        onChange={e => setFormIcon(e.target.value)}
                        maxLength={2}
                      />

                      <label className="mb-1.5 block text-sm font-medium text-gray-700">
                        Base URL (Optional)
                      </label>
                      <input
                        type="text"
                        className={`w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-500 ${formApiType === 'anthropic' ? 'mb-1' : 'mb-3'}`}
                        placeholder="Leave empty for provider default"
                        value={formBaseUrl}
                        onChange={e => setFormBaseUrl(e.target.value)}
                      />
                      {formApiType === 'anthropic' && (
                        <p className="mb-3 text-xs text-gray-500">
                          You can enter{' '}
                          <code className="rounded bg-gray-100 px-1">bedrock:&lt;region&gt;</code>{' '}
                          to use Claude models in Bedrock
                        </p>
                      )}
                      {formApiType === 'bedrock' && (
                        <p className="mb-3 text-xs text-gray-500">
                          You can enter just a region (e.g.,{' '}
                          <code className="rounded bg-gray-100 px-1">us-west-2</code>) instead of
                          the full URL
                        </p>
                      )}

                      {requiresApiKey(formApiType) ? (
                        <>
                          {/* Local provider checkbox */}
                          <label className="mb-3 flex cursor-pointer items-center">
                            <input
                              type="checkbox"
                              checked={formIsLocal}
                              onChange={e => setFormIsLocal(e.target.checked)}
                              className="mr-2 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                            <span className="text-sm text-gray-700">
                              🏠 Local provider (API key optional)
                            </span>
                          </label>

                          <label className="mb-1.5 block text-sm font-medium text-gray-700">
                            API Key {formIsLocal ? '(Optional)' : '*'}
                          </label>
                          <input
                            type="password"
                            className="mb-4 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                            placeholder="Enter your API key"
                            value={formApiKey}
                            onChange={e => setFormApiKey(e.target.value)}
                          />
                        </>
                      ) : hasWebGPU ? (
                        <div className="mb-4 space-y-2">
                          <div className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
                            🏠 Local model - no API key required. Models run entirely on your device
                            using WebGPU.
                          </div>
                          {webgpuCapabilities?.adapterInfo && (
                            <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
                              <span className="font-medium">GPU:</span>{' '}
                              {webgpuCapabilities.adapterInfo.description !== 'Unknown'
                                ? webgpuCapabilities.adapterInfo.description
                                : `${webgpuCapabilities.adapterInfo.vendor} ${webgpuCapabilities.adapterInfo.device}`}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="mb-4 rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800">
                          <div className="mb-1 font-medium">⚠️ WebGPU Not Available</div>
                          <p className="mb-2">
                            Local models require WebGPU which isn't supported in your browser.
                          </p>
                          <p className="text-xs">
                            Supported browsers: {getSupportedBrowsers().join(', ')}
                          </p>
                        </div>
                      )}

                      <label className="mb-1.5 block text-sm font-medium text-gray-700">
                        Models Endpoint (Optional)
                      </label>
                      <input
                        type="text"
                        className={`mb-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-500 ${formModelsEndpointDisabled ? 'cursor-not-allowed bg-gray-100 text-gray-400' : ''}`}
                        placeholder="SDK default"
                        value={formModelsEndpoint}
                        onChange={e => setFormModelsEndpoint(e.target.value)}
                        disabled={formModelsEndpointDisabled}
                      />
                      <label className="mb-4 flex items-center gap-2 text-sm text-gray-600">
                        <input
                          type="checkbox"
                          checked={formModelsEndpointDisabled}
                          onChange={e => setFormModelsEndpointDisabled(e.target.checked)}
                          className="rounded border-gray-300"
                        />
                        Models endpoint not supported
                      </label>

                      <label className="mb-1.5 block text-sm font-medium text-gray-700">
                        Extra Model IDs (Optional)
                      </label>
                      <textarea
                        className="mb-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                        placeholder="one-model-id-per-line"
                        rows={3}
                        value={formExtraModelIds}
                        onChange={e => setFormExtraModelIds(e.target.value)}
                      />
                      <p className="mb-4 text-xs text-gray-500">
                        Add model IDs not listed by the provider (one per line)
                      </p>

                      {formApiType !== 'bedrock' && formApiType !== 'webllm' && (
                        <>
                          <label className="mb-1.5 block text-sm font-medium text-gray-700">
                            CORS Proxy URL (Optional)
                          </label>
                          <input
                            type="text"
                            className="mb-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                            placeholder="e.g., https://myserver.com/cors-proxy"
                            value={formProxyUrl}
                            onChange={e => setFormProxyUrl(e.target.value)}
                          />
                          <p className="mb-4 text-xs text-gray-500">
                            Routes API traffic through a CORS proxy server
                          </p>
                        </>
                      )}

                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => setShowAdvanced(true)}
                          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
                        >
                          Advanced
                        </button>
                        <button
                          onClick={handleCancel}
                          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleSave}
                          disabled={isSaving}
                          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
                        >
                          {isSaving && <Spinner size={14} colorClass="border-white" />}
                          Add
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Add Button */}
              {!isAddingNew && !editingId && (
                <button
                  onClick={handleStartAdd}
                  className="w-full rounded-lg border-2 border-dashed border-blue-600 px-4 py-3 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50"
                >
                  + Add API Definition
                </button>
              )}
            </div>
          </section>

          {/* About Section */}
          <section>
            <h3 className="mb-2 text-lg font-semibold text-gray-900">About</h3>
            <p className="mb-3 text-sm leading-relaxed text-gray-600">
              This is a general-purpose AI chatbot that supports multiple providers. You can add
              multiple API definitions for the same provider with different base URLs (e.g., xAI,
              OpenRouter) to use compatible services.
            </p>
            <p className="text-xs text-gray-400">Version 1.0.0</p>
          </section>
        </div>
      </div>
    </div>
  );
}
