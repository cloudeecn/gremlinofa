import { useState, useEffect, useCallback } from 'react';
import Spinner from './ui/Spinner';
import { useApp } from '../hooks/useApp';
import { useAlert } from '../hooks/useAlert';
import { useIsMobile } from '../hooks/useIsMobile';
import type { APIDefinition } from '../types';
import { APIType } from '../types';
import { generateUniqueId } from '../utils/idGenerator';
import {
  isWebGPUAvailable,
  checkWebGPUCapabilities,
  getSupportedBrowsers,
  type WebGPUCapabilities,
} from '../utils/webgpuCapabilities';

interface SettingsPageProps {
  onMenuPress?: () => void;
}

export default function SettingsPage({ onMenuPress }: SettingsPageProps) {
  const { apiDefinitions, saveAPIDefinition, deleteAPIDefinition, refreshModels } = useApp();
  const { showAlert, showDestructiveConfirm } = useAlert();
  const isMobile = useIsMobile();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [formApiType, setFormApiType] = useState<APIType>(APIType.CHATGPT);
  const [formName, setFormName] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formIsLocal, setFormIsLocal] = useState(false);
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
    setFormApiType(APIType.CHATGPT);
    setFormName('');
    setFormBaseUrl('');
    setFormApiKey('');
    setFormIsLocal(false);
  };

  const apiTypes = [
    { id: APIType.RESPONSES_API, name: 'OpenAI Responses', icon: '🔮' },
    { id: APIType.CHATGPT, name: 'ChatGPT', icon: '🤖' },
    { id: APIType.ANTHROPIC, name: 'Anthropic', icon: '🧠' },
    { id: APIType.WEBLLM, name: 'WebLLM (Local)', icon: '🏠' },
  ];

  // Check if API type requires an API key
  const requiresApiKey = (apiType: APIType): boolean => {
    return apiType !== APIType.WEBLLM;
  };

  const getApiTypeInfo = (apiType: APIType) => {
    return apiTypes.find(t => t.id === apiType) || apiTypes[0];
  };

  const handleStartEdit = (def: APIDefinition) => {
    setEditingId(def.id);
    setIsAddingNew(false);
    setFormApiType(def.apiType);
    setFormName(def.name);
    setFormBaseUrl(def.baseUrl);
    setFormApiKey(def.apiKey);
    setFormIsLocal(def.isLocal || false);
  };

  const handleStartAdd = () => {
    setIsAddingNew(true);
    setEditingId(null);
    setFormApiType(APIType.CHATGPT);
    setFormName('');
    setFormBaseUrl('');
    setFormApiKey('');
    setFormIsLocal(false);
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
      const existingDef = editingId ? apiDefinitions.find(d => d.id === editingId) : null;
      const hadNoApiKey = existingDef
        ? !existingDef.apiKey || existingDef.apiKey.trim() === ''
        : true;
      const nowHasApiKey = formApiKey.trim() !== '';

      const def: APIDefinition = {
        id: editingId || generateUniqueId(`api_${formApiType}`),
        apiType: formApiType,
        name: formName.trim(),
        baseUrl: formBaseUrl.trim(),
        apiKey: formApiKey.trim(),
        isDefault: editingId ? apiDefinitions.find(d => d.id === editingId)?.isDefault : false,
        isLocal: formIsLocal,
        createdAt: editingId
          ? apiDefinitions.find(d => d.id === editingId)?.createdAt || new Date()
          : new Date(),
        updatedAt: new Date(),
      };

      await saveAPIDefinition(def);

      // Auto-refresh models if API key was just added
      if (hadNoApiKey && nowHasApiKey) {
        await refreshModels(def.id);
      }

      handleCancel();
    } finally {
      setIsSaving(false);
    }
  }, [
    formName,
    formApiType,
    formIsLocal,
    formApiKey,
    editingId,
    apiDefinitions,
    formBaseUrl,
    saveAPIDefinition,
    refreshModels,
    showAlert,
  ]);

  const handleDelete = async (def: APIDefinition) => {
    if (def.isDefault) {
      await showAlert(
        'Cannot Delete',
        'Default API definitions cannot be deleted. You can edit them instead.'
      );
      return;
    }

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
                const apiTypeInfo = getApiTypeInfo(def.apiType);
                const hasApiKey = def.apiKey && def.apiKey.trim() !== '';
                const isEditing = editingId === def.id;
                const needsApiKey = requiresApiKey(def.apiType) && !def.isLocal;

                // Determine status badge
                let statusBadgeClass = '';
                let statusText = '';
                if (!needsApiKey) {
                  // WebLLM or isLocal - show Local badge
                  if (def.apiType === APIType.WEBLLM && !hasWebGPU) {
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
                            <span className="mr-3 text-2xl">{apiTypeInfo.icon}</span>
                            <div className="flex-1">
                              <div className="mb-1 text-xs tracking-wide text-gray-500 uppercase">
                                {apiTypeInfo.name}
                              </div>
                              <div className="mb-1 text-base font-semibold text-gray-900">
                                {def.name}
                              </div>
                              {def.baseUrl ? (
                                <div className="text-xs text-gray-600">{def.baseUrl}</div>
                              ) : (
                                <div className="text-xs text-gray-400 italic">(default)</div>
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
                          {!def.isDefault && (
                            <button
                              onClick={() => handleDelete(def)}
                              className="rounded border border-red-600 px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </>
                    ) : (
                      // Inline edit mode
                      <div>
                        <div className="mb-4 text-base font-semibold text-gray-900">
                          Edit: {apiTypeInfo.icon} {apiTypeInfo.name}
                        </div>

                        <label className="mb-1.5 block text-sm font-medium text-gray-700">
                          Name *
                        </label>
                        <input
                          type="text"
                          className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                          placeholder="e.g., xAI, OpenRouter, My OpenAI"
                          value={formName}
                          onChange={e => setFormName(e.target.value)}
                        />

                        <label className="mb-1.5 block text-sm font-medium text-gray-700">
                          Base URL (Optional)
                        </label>
                        <input
                          type="text"
                          className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                          placeholder="Leave empty for provider default"
                          value={formBaseUrl}
                          onChange={e => setFormBaseUrl(e.target.value)}
                        />

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
                              className="mb-4 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
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
                  <div className="mb-4 text-base font-semibold text-gray-900">
                    Add New API Definition
                  </div>

                  <label className="mb-1.5 block text-sm font-medium text-gray-700">API Type</label>
                  <div className="mb-3 grid grid-cols-2 gap-2">
                    {apiTypes.map(apiType => (
                      <button
                        key={apiType.id}
                        onClick={() => setFormApiType(apiType.id)}
                        className={`flex items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                          formApiType === apiType.id
                            ? 'border-blue-600 bg-blue-50 text-blue-900'
                            : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        <span className="mr-2">{apiType.icon}</span>
                        {apiType.name}
                      </button>
                    ))}
                  </div>

                  <label className="mb-1.5 block text-sm font-medium text-gray-700">Name *</label>
                  <input
                    type="text"
                    className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                    placeholder="e.g., xAI, OpenRouter, My OpenAI"
                    value={formName}
                    onChange={e => setFormName(e.target.value)}
                  />

                  <label className="mb-1.5 block text-sm font-medium text-gray-700">
                    Base URL (Optional)
                  </label>
                  <input
                    type="text"
                    className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                    placeholder="Leave empty for provider default"
                    value={formBaseUrl}
                    onChange={e => setFormBaseUrl(e.target.value)}
                  />

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
                        className="mb-4 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
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
                      Add
                    </button>
                  </div>
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
