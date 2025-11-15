import React, { useState, useEffect } from 'react';
import Modal from '../ui/Modal';
import { useApp } from '../../hooks/useApp';
import { apiService } from '../../services/api/apiService';
import { getModelInfo, formatSize } from '../../services/api/webllmModelInfo';
import {
  isWebGPUAvailable,
  checkWebGPUCapabilities,
  checkModelCompatibility,
  getSupportedBrowsers,
  type WebGPUCapabilities,
} from '../../utils/webgpuCapabilities';
import type { Model } from '../../types';
import { APIType } from '../../types';

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

export default function ModelSelector({
  isOpen,
  onClose,
  currentApiDefinitionId,
  currentModelId,
  parentApiDefinitionId: _parentApiDefinitionId,
  parentModelId: _parentModelId,
  onSelect,
  title,
  showResetOption,
}: ModelSelectorProps) {
  const { apiDefinitions, models } = useApp();
  const [selectedApiDefId, setSelectedApiDefId] = useState<string | null>(currentApiDefinitionId);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(currentModelId);

  // WebGPU capability state for VRAM warnings
  const [webgpuCapabilities, setWebgpuCapabilities] = useState<WebGPUCapabilities | null>(null);
  const hasWebGPU = isWebGPUAvailable();

  // Check WebGPU capabilities when modal opens
  useEffect(() => {
    if (isOpen && hasWebGPU) {
      checkWebGPUCapabilities().then(setWebgpuCapabilities);
    }
  }, [isOpen, hasWebGPU]);

  // Reset state when modal opens
  React.useEffect(() => {
    if (isOpen) {
      setSelectedApiDefId(currentApiDefinitionId);
      setSelectedModelId(currentModelId);
    }
  }, [isOpen, currentApiDefinitionId, currentModelId]);

  const handleSelectApi = (apiDefId: string) => {
    // When API changes, clear model selection
    setSelectedApiDefId(apiDefId);
    setSelectedModelId(null);
  };

  const handleSelectModel = (modelId: string) => {
    setSelectedModelId(modelId);
  };

  const handleApply = () => {
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

  // Check if selected API has an API key configured
  const selectedApiDef = selectedApiDefId
    ? apiDefinitions.find(def => def.id === selectedApiDefId)
    : null;
  const hasApiKey = selectedApiDef?.apiKey && selectedApiDef.apiKey.trim() !== '';

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl" position="bottom">
      <div className="flex max-h-[75vh] flex-col rounded-t-2xl bg-white md:max-h-[90vh] md:rounded-2xl">
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

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {/* API Selection */}
          <div className="border-b border-gray-100 p-4">
            <h3 className="mb-3 text-base font-semibold text-gray-900">API Provider</h3>
            <div className="space-y-2">
              {apiDefinitions.map(apiDef => (
                <button
                  key={apiDef.id}
                  onClick={() => handleSelectApi(apiDef.id)}
                  className={`w-full rounded-lg border p-3 text-left transition-colors ${
                    selectedApiDefId === apiDef.id
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 bg-white hover:border-gray-300'
                  }`}
                >
                  <div className="font-medium text-gray-900">{apiDef.name}</div>
                  <div className="mt-0.5 text-xs text-gray-600">{apiDef.apiType.toUpperCase()}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Model Selection */}
          <div className="p-4">
            <h3 className="mb-3 text-base font-semibold text-gray-900">
              Model {!selectedApiDefId && '(Select API first)'}
            </h3>
            {!selectedApiDefId ? (
              <p className="p-3 text-sm text-gray-500 italic">
                Please select an API provider above to view available models.
              </p>
            ) : availableModels.length === 0 ? (
              !hasApiKey ? (
                <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
                  <p className="mb-2 text-sm text-yellow-900">
                    ⚠️ Please configure an API key for this API provider in Settings before
                    selecting models.
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
                {/* WebGPU not available warning for WebLLM providers */}
                {selectedApiDef?.apiType === APIType.WEBLLM && !hasWebGPU && (
                  <div className="mb-3 rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800">
                    <div className="mb-1 font-medium">⚠️ WebGPU Not Available</div>
                    <p className="mb-2 text-xs">
                      Local models require WebGPU which isn't supported in your browser.
                    </p>
                    <p className="text-xs">
                      Supported browsers: {getSupportedBrowsers().join(', ')}
                    </p>
                  </div>
                )}
                {availableModels.map(model => {
                  // Get pricing info using apiService
                  const pricingDisplay = apiService.formatModelInfoForDisplay(
                    model.apiType,
                    model.id
                  );

                  // For WebLLM models, get additional size info and compatibility
                  const isWebLLM = model.apiType === APIType.WEBLLM;
                  const webllmInfo = isWebLLM ? getModelInfo(model.id) : null;
                  const compatibility =
                    isWebLLM && webllmInfo
                      ? checkModelCompatibility(webllmInfo.vramRequired, webgpuCapabilities)
                      : null;

                  // Determine if model should be disabled (WebGPU not available or incompatible)
                  const isDisabled =
                    isWebLLM && (!hasWebGPU || compatibility?.compatible === false);

                  return (
                    <button
                      key={model.id}
                      onClick={() => !isDisabled && handleSelectModel(model.id)}
                      disabled={isDisabled}
                      className={`w-full rounded-lg border p-3 text-left transition-colors ${
                        isDisabled
                          ? 'cursor-not-allowed border-gray-200 bg-gray-50 opacity-60'
                          : selectedModelId === model.id
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-200 bg-white hover:border-gray-300'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div
                          className={`font-medium ${isDisabled ? 'text-gray-500' : 'text-gray-900'}`}
                        >
                          {model.name}
                        </div>
                        {isWebLLM && webllmInfo && (
                          <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                            {formatSize(webllmInfo.vramRequired)} VRAM
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-gray-600">
                        Context: {model.contextWindow.toLocaleString()} tokens
                      </div>
                      <div
                        className={`mt-1 text-xs font-medium ${isDisabled ? 'text-gray-500' : 'text-green-700'}`}
                      >
                        {isWebLLM ? '🧊' : '💰'} {pricingDisplay}
                      </div>
                      {/* VRAM compatibility warning */}
                      {compatibility?.warning && (
                        <div
                          className={`mt-2 text-xs ${compatibility.compatible ? 'text-yellow-700' : 'text-red-600'}`}
                        >
                          ⚠️ {compatibility.warning}
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
                className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700"
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
                className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700"
              >
                Apply
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
