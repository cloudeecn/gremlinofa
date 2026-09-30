import { useState } from 'react';
import { useApiDefinitions, useAppActions } from '../hooks/useApp';
import { useAlert } from '../hooks/useAlert';
import { useIsMobile } from '../hooks/useIsMobile';
import type { APIDefinition } from '../../shared/protocol/types';
import { isChatgptSignedIn } from '../../shared/protocol/apiDefinition';
import { getApiTypeDisplayName, getApiDefinitionIcon } from '../lib/apiTypeUtils';
import ApiDefinitionForm from './settings/ApiDefinitionForm';

interface SettingsPageProps {
  onMenuPress?: () => void;
}

/** The add-new form, or one definition's edit / advanced form. */
type OpenForm = { kind: 'add' } | { kind: 'edit' | 'advanced'; definitionId: string };

function statusBadge(def: APIDefinition): { className: string; text: string } {
  if (def.apiType === 'chatgpt-subscription') {
    return isChatgptSignedIn(def)
      ? { className: 'bg-green-100 text-green-800', text: 'Signed in' }
      : { className: 'bg-red-100 text-red-800', text: 'Not signed in' };
  }
  if (def.isLocal) return { className: 'bg-blue-100 text-blue-800', text: 'Local' };
  if (def.apiKey && def.apiKey.trim() !== '') {
    return { className: 'bg-green-100 text-green-800', text: 'Configured' };
  }
  // Empty key = host `claude` CLI credentials — configured, not missing.
  if (def.apiType === 'claude-agent')
    return { className: 'bg-blue-100 text-blue-800', text: 'Host CLI' };
  return { className: 'bg-red-100 text-red-800', text: 'Not Set' };
}

export default function SettingsPage({ onMenuPress }: SettingsPageProps) {
  const apiDefinitions = useApiDefinitions();
  const { deleteAPIDefinition } = useAppActions();
  const { showAlert, showDestructiveConfirm } = useAlert();
  const isMobile = useIsMobile();

  const [openForm, setOpenForm] = useState<OpenForm | null>(null);
  const closeForm = () => setOpenForm(null);

  const handleDelete = async (def: APIDefinition) => {
    const confirmed = await showDestructiveConfirm(
      'Delete API Definition',
      `Delete "${def.name}"?`,
      'Delete'
    );

    if (!confirmed) return;
    try {
      await deleteAPIDefinition(def.id);
    } catch (err) {
      void showAlert('Not deleted', err instanceof Error ? err.message : String(err));
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
              aria-label="Open menu"
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
      <div className="ios-scroll flex-1 overflow-y-auto overscroll-y-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-2xl space-y-8">
          {/* API Definitions Section */}
          <section>
            <h3 className="mb-2 text-lg font-semibold text-gray-900">API Definitions</h3>
            <p className="mb-4 text-sm text-gray-600">
              Configure your API keys for different providers
            </p>

            <div className="space-y-3">
              {apiDefinitions.map(def => {
                const formForThis =
                  openForm && openForm.kind !== 'add' && openForm.definitionId === def.id
                    ? openForm
                    : null;
                const badge = statusBadge(def);

                return (
                  <div key={def.id} className="rounded-lg border border-gray-200 bg-white p-4">
                    {formForThis ? (
                      <ApiDefinitionForm
                        definition={def}
                        initialView={formForThis.kind === 'advanced' ? 'advanced' : 'basic'}
                        onClose={closeForm}
                      />
                    ) : (
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
                              {def.apiType === 'chatgpt-subscription' && def.oauth && (
                                <div className="text-xs text-gray-600">
                                  {def.oauth.email ?? 'ChatGPT account'}
                                  {def.oauth.planType ? ` · ${def.oauth.planType} plan` : ''}
                                </div>
                              )}
                            </div>
                          </div>
                          <span
                            className={`rounded-full px-2.5 py-1 text-xs font-medium ${badge.className}`}
                          >
                            {badge.text}
                          </span>
                        </div>
                        {def.apiType === 'chatgpt-subscription' && (
                          <div className="mb-3 rounded-lg border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-900">
                            {def.advancedSettings?.isSubscription
                              ? 'Usage bills your ChatGPT plan and is tracked as $0. Turn off "Subscription service" under Advanced to see what it would have cost at API-list prices.'
                              : 'Usage bills your ChatGPT plan, but costs are shown at API-list prices so you can see what you would have spent. Turn on "Subscription service" under Advanced to track $0 instead.'}
                          </div>
                        )}
                        <div className="flex gap-2">
                          <button
                            onClick={() => setOpenForm({ kind: 'edit', definitionId: def.id })}
                            className="rounded border border-blue-600 px-3 py-1.5 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => setOpenForm({ kind: 'advanced', definitionId: def.id })}
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
                    )}
                  </div>
                );
              })}

              {openForm?.kind === 'add' && (
                <div className="rounded-lg border border-gray-200 bg-white p-4">
                  <ApiDefinitionForm onClose={closeForm} />
                </div>
              )}

              {!openForm && (
                <button
                  onClick={() => setOpenForm({ kind: 'add' })}
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
