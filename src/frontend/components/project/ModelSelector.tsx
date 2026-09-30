import { useState, useEffect, useRef } from 'react';
import Modal from '../ui/Modal';
import { useApiDefinitions, useModels } from '../../hooks/useApp';
import { getApiTypeDisplayName, getApiDefinitionIcon } from '../../lib/apiTypeUtils';
import type { Model, APIDefinition } from '../../../shared/protocol/types';
import {
  apiKeyOptional,
  isChatgptSignedIn,
  isSubscriptionApiDefinition,
} from '../../../shared/protocol/apiDefinition';

interface ModelSelectorProps {
  isOpen: boolean;
  onClose: () => void;
  currentApiDefinitionId: string | null;
  currentModelId: string | null;
  parentApiDefinitionId?: string | null;
  parentModelId?: string | null;
  onSelect: (apiDefId: string | null, modelId: string | null) => void;
  title: string;
  showResetOption: boolean;
}

// Get status badge info for an API definition
function getStatusBadge(apiDef: APIDefinition): { className: string; text: string } {
  const hasApiKey = apiDef.apiKey && apiDef.apiKey.trim() !== '';

  if (apiDef.apiType === 'chatgpt-subscription') {
    return isChatgptSignedIn(apiDef)
      ? { className: 'bg-green-100 text-green-800', text: 'Signed in' }
      : { className: 'bg-red-100 text-red-800', text: 'Not signed in' };
  } else if (apiDef.isLocal) {
    return { className: 'bg-blue-100 text-blue-800', text: 'Local' };
  } else if (hasApiKey) {
    return { className: 'bg-green-100 text-green-800', text: 'Configured' };
  } else if (apiDef.apiType === 'claude-agent') {
    // Empty key = host `claude` CLI credentials — configured, not missing.
    return { className: 'bg-blue-100 text-blue-800', text: 'Host CLI' };
  } else {
    return { className: 'bg-red-100 text-red-800', text: 'Not Set' };
  }
}

// Inner component that gets remounted when modal opens
function ModelSelectorContent({
  onClose,
  currentApiDefinitionId,
  currentModelId,
  parentApiDefinitionId,
  onSelect,
  title,
  showResetOption,
}: Omit<ModelSelectorProps, 'isOpen' | 'parentModelId'> & {
  parentApiDefinitionId: string | null;
}) {
  const apiDefinitions = useApiDefinitions();
  const models = useModels();

  // Initial selection: use current, fall back to parent
  const initialApiDefId = currentApiDefinitionId ?? parentApiDefinitionId;
  const initialModelId = currentApiDefinitionId ? currentModelId : null;

  const [selectedApiDefId, setSelectedApiDefId] = useState<string | null>(initialApiDefId);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(initialModelId);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };

    if (isDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isDropdownOpen]);

  const handleSelectApi = (apiDefId: string) => {
    // When API changes, clear model selection
    setSelectedApiDefId(apiDefId);
    setSelectedModelId(null);
    setIsDropdownOpen(false);
  };

  const handleSelectModel = (modelId: string) => {
    setSelectedModelId(modelId);
  };

  // Applying a provider without a model pairs it with the old model id (a new
  // chat then fails with "model not found") and, in project settings, hides
  // every section. "Remove" is the way back to the parent's model.
  const handleApply = () => {
    if (!selectedModelId) return;
    onSelect(selectedApiDefId, selectedModelId);
    onClose();
  };

  const handleRemove = () => {
    // Reset to parent defaults (for Chat)
    onSelect(null, null);
    onClose();
  };

  const handleCancel = () => {
    onClose();
  };

  // Get available models for selected API
  const availableModels: Model[] = selectedApiDefId ? models.get(selectedApiDefId) || [] : [];

  // Check if selected API has an API key configured or can run keyless
  const selectedApiDef = selectedApiDefId
    ? apiDefinitions.find(def => def.id === selectedApiDefId)
    : null;
  const hasApiKey = selectedApiDef?.apiKey && selectedApiDef.apiKey.trim() !== '';
  const keyOptional = selectedApiDef ? apiKeyOptional(selectedApiDef) : false;

  return (
    <div className="flex max-h-[75dvh] flex-col rounded-t-2xl bg-white md:max-h-[90dvh] md:rounded-2xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 p-4">
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        <button
          onClick={onClose}
          className="flex h-11 w-11 items-center justify-center text-gray-600 transition-colors hover:text-gray-900"
        >
          <span className="text-2xl leading-none">✕</span>
        </button>
      </div>

      {/* API Selection - Static (not scrolling) */}
      <div className="flex-shrink-0 border-b border-gray-100 p-4">
        <h3 className="mb-3 text-base font-semibold text-gray-900">API Provider</h3>
        <div ref={dropdownRef} className="relative">
          {/* Dropdown trigger button */}
          <button
            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
            className="flex w-full items-center justify-between rounded-lg border border-gray-300 bg-white p-3 text-left transition-colors hover:border-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
          >
            {selectedApiDef ? (
              <div className="flex flex-1 items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xl">{getApiDefinitionIcon(selectedApiDef)}</span>
                  <div>
                    <div className="font-medium text-gray-900">{selectedApiDef.name}</div>
                    <div className="text-xs text-gray-600">
                      {getApiTypeDisplayName(selectedApiDef.apiType)}
                    </div>
                  </div>
                </div>
                <span
                  className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${getStatusBadge(selectedApiDef).className}`}
                >
                  {getStatusBadge(selectedApiDef).text}
                </span>
              </div>
            ) : (
              <span className="text-gray-500">Select an API provider...</span>
            )}
            <svg
              className={`ml-2 h-5 w-5 text-gray-400 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>

          {/* Dropdown options */}
          {isDropdownOpen && (
            <div className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg">
              {apiDefinitions.map(apiDef => {
                const badge = getStatusBadge(apiDef);
                const isSelected = selectedApiDefId === apiDef.id;

                return (
                  <button
                    key={apiDef.id}
                    onClick={() => handleSelectApi(apiDef.id)}
                    className={`flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors ${
                      isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{getApiDefinitionIcon(apiDef)}</span>
                      <div>
                        <div
                          className={`font-medium ${isSelected ? 'text-blue-700' : 'text-gray-900'}`}
                        >
                          {apiDef.name}
                        </div>
                        <div className="text-xs text-gray-600">
                          {getApiTypeDisplayName(apiDef.apiType)}
                        </div>
                      </div>
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
                    >
                      {badge.text}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Model Selection - Scrollable */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div>
          <h3 className="mb-3 text-base font-semibold text-gray-900">
            Model {!selectedApiDefId && '(Select API first)'}
          </h3>
          {!selectedApiDefId ? (
            <p className="p-3 text-sm text-gray-500 italic">
              Please select an API provider above to view available models.
            </p>
          ) : availableModels.length === 0 ? (
            !hasApiKey && !keyOptional ? (
              <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
                <p className="mb-2 text-sm text-yellow-900">
                  ⚠️ Please configure an API key for this API provider in Settings before selecting
                  models.
                </p>
                <p className="text-xs text-yellow-800 italic">
                  Tap the gear icon (⚙️) in the sidebar to open Settings.
                </p>
              </div>
            ) : (
              <p className="p-3 text-sm text-gray-500 italic">
                No models available for this API provider.
              </p>
            )
          ) : (
            <div className="space-y-2">
              {availableModels.map(model => {
                // Get pricing info using apiService
                const priceDisplaySegments = [];
                if (model.inputPrice) {
                  priceDisplaySegments.push(`In: $${model.inputPrice}`);
                }
                if (model.outputPrice) {
                  priceDisplaySegments.push(`Out: $${model.outputPrice}`);
                }
                if (model.cacheReadPrice) {
                  priceDisplaySegments.push(`CacheR: $${model.cacheReadPrice}`);
                }
                if (model.cacheWritePrice) {
                  priceDisplaySegments.push(`CacheW: $${model.cacheWritePrice}`);
                }
                const priceDisplay = priceDisplaySegments.join('/');

                // Format context window compactly (e.g., "128k")
                const contextK = model.contextWindow
                  ? Math.round(model.contextWindow / 1000)
                  : null;
                const contextDisplay = contextK ? `ctx: ${contextK}k` : null;

                // Check if model has unreliable pricing data
                const isUnreliable =
                  model.matchedMode === 'unreliable' || model.matchedMode === 'default';

                return (
                  <button
                    key={model.id}
                    onClick={() => handleSelectModel(model.id)}
                    className={`w-full rounded-lg border p-3 text-left transition-colors ${
                      selectedModelId === model.id
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 bg-white hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-medium text-gray-900">{model.name}</div>
                      <div className="ml-2 flex items-center gap-2">
                        {contextDisplay && (
                          <span className="text-xs text-gray-500">{contextDisplay}</span>
                        )}
                        {model.region && model.region.length > 0 && (
                          <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
                            {model.region.map(r => r.toUpperCase()).join(', ')}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="truncate font-mono text-xs text-gray-400">{model.id}</div>
                    <div className="mt-1 text-xs font-medium text-green-700">
                      {isSubscriptionApiDefinition(selectedApiDef)
                        ? '📋 Subscription'
                        : `💰 ${priceDisplay}`}
                    </div>
                    {/* Unreliable pricing warning */}
                    {isUnreliable && !isSubscriptionApiDefinition(selectedApiDef) && (
                      <div className="mt-1 text-xs text-yellow-600">
                        ⚠️ Cost calculation may be inaccurate for this model
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex gap-3 rounded-b-2xl border-t border-gray-200 bg-white p-4">
        {showResetOption ? (
          <>
            <button
              onClick={handleRemove}
              className="rounded-lg border border-red-600 px-4 py-2 font-medium text-red-600 transition-colors hover:bg-red-50"
            >
              Remove
            </button>
            <div className="flex-1" />
            <button
              onClick={handleCancel}
              className="rounded-lg border border-gray-300 px-4 py-2 font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={!selectedModelId}
              className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              Apply
            </button>
          </>
        ) : (
          <>
            <div className="flex-1" />
            <button
              onClick={handleCancel}
              className="rounded-lg border border-gray-300 px-4 py-2 font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={!selectedModelId}
              className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              Apply
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function ModelSelector({
  isOpen,
  onClose,
  currentApiDefinitionId,
  currentModelId,
  parentApiDefinitionId,
  parentModelId: _parentModelId,
  onSelect,
  title,
  showResetOption,
}: ModelSelectorProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl" position="bottom">
      {/* Only render content when open - unmounts on close, remounts fresh on open */}
      {isOpen && (
        <ModelSelectorContent
          onClose={onClose}
          currentApiDefinitionId={currentApiDefinitionId}
          currentModelId={currentModelId}
          parentApiDefinitionId={parentApiDefinitionId ?? null}
          onSelect={onSelect}
          title={title}
          showResetOption={showResetOption}
        />
      )}
    </Modal>
  );
}
