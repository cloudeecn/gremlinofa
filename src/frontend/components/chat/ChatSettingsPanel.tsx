import { useCallback, useMemo, useRef, useState } from 'react';
import { gremlinClient } from '../../client';
import { showDestructiveConfirm } from '../../lib/alerts';
import { useOverlay } from '../../hooks/useOverlay';
import { useToolInventory } from '../../hooks/useToolInventory';
import ReasoningEffortSelect from '../project/ReasoningEffortSelect';
import VfsPathPickerModal from '../vfs/VfsPathPickerModal';
import Spinner from '../ui/Spinner';
import InheritableField from './chatSettings/InheritableField';
import PromptFileList from './chatSettings/PromptFileList';
import ResolvedPromptPreview from './chatSettings/ResolvedPromptPreview';
import {
  MINION_VFS_ROOT,
  personaNamespace,
} from '../../../shared/services/agentic/agentSystemPrompt';
import { fromDraft, toDraft, type ChatSettingsDraft } from './chatSettings/chatSettingsDraft';
import type {
  APIDefinition,
  Chat,
  ChatAgentConfig,
  Project,
  Verbosity,
} from '../../../shared/protocol/types';

interface ChatSettingsPanelProps {
  chat: Chat;
  project: Project;
  apiDefinitions: APIDefinition[];
  currentApiDefId: string | null;
  currentModelId: string | null;
  onOpenModelSelector: () => void;
  onSave: (agentConfig: ChatAgentConfig | undefined) => Promise<void>;
  onClose: () => void;
}

export default function ChatSettingsPanel({
  chat,
  project,
  apiDefinitions,
  currentApiDefId,
  currentModelId,
  onOpenModelSelector,
  onSave,
  onClose,
}: ChatSettingsPanelProps) {
  const [draft, setDraft] = useState(() => toDraft(chat.agentConfig));
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');
  const [isPickingPrePersona, setIsPickingPrePersona] = useState(false);
  const availableTools = useToolInventory();

  // Persona auto-fills the namespace only until the namespace is touched,
  // mirroring the minion tool's `/minions/<persona>` default. Visible and
  // editable, so it never lies about where the chat's files live.
  const namespaceTouched = useRef(draft.namespace !== '');

  // The config as this panel last knew it: seeded on open, replaced by each
  // successful save. Dirty means "saving would change it", so a temperature
  // typed as "1.0", a persona left behind by switching back to the project
  // prompt, or an empty custom path don't count.
  const [baseline, setBaseline] = useState(chat.agentConfig);
  const isDirty = useMemo(
    () => JSON.stringify(fromDraft(draft)) !== JSON.stringify(fromDraft(toDraft(baseline))),
    [draft, baseline]
  );

  const adapter = useMemo(() => gremlinClient.getVfsAdapter(chat.projectId), [chat.projectId]);
  const effectiveApiDef = apiDefinitions.find(d => d.id === currentApiDefId);
  const isClaudeAgent = effectiveApiDef?.apiType === 'claude-agent';
  const ignoredNote = isClaudeAgent ? 'Ignored by Claude Agent.' : undefined;

  const patch = useCallback(
    (fields: Partial<ChatSettingsDraft>) => setDraft(prev => ({ ...prev, ...fields })),
    []
  );

  const handleClose = useCallback(async () => {
    // Closing wouldn't stop the save, and a failure would land on no one
    if (isSaving) return;
    if (isDirty) {
      const confirmed = await showDestructiveConfirm(
        'Discard changes?',
        'Your chat settings changes have not been saved.',
        'Discard'
      );
      if (!confirmed) return;
    }
    onClose();
  }, [isDirty, isSaving, onClose]);

  // On the overlay stack, so Escape inside a nested picker or the "Discard
  // changes?" confirm closes only that layer. No focus trap: the desktop
  // sidebar stays usable next to the panel.
  const panelRef = useRef<HTMLDivElement>(null);
  useOverlay({ active: true, onEscape: () => void handleClose(), containerRef: panelRef });

  const handleSave = async () => {
    const config = fromDraft(draft);
    setIsSaving(true);
    setSaveStatus('Saving…');
    try {
      await onSave(config);
      setBaseline(config);
      setDraft(toDraft(config));
      setSaveStatus('Saved');
    } catch (error) {
      console.debug('[ChatSettingsPanel] save failed:', error);
      setSaveStatus('Save failed');
    } finally {
      setIsSaving(false);
    }
  };

  const promptModeDisabled = draft.systemPromptMode === 'project';
  const projectTools = project.enabledTools ?? [];
  // A cloned config can carry a tool the registry no longer exposes; showing
  // it keeps the next save from silently dropping it.
  const unknownEnabled = (draft.enabledTools ?? []).filter(
    t => !availableTools.some(a => a.name === t)
  );

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="absolute inset-0 z-40 flex flex-col bg-gray-50 outline-none"
    >
      <div className="border-b border-gray-200 bg-white">
        <div className="safe-area-inset-top" />
        <div className="flex h-14 items-center px-4">
          <button
            onClick={handleClose}
            aria-label="Close chat settings"
            className="-ml-2 flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-gray-100"
          >
            <span className="text-2xl text-gray-700">←</span>
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold text-gray-900">Chat Settings</h1>
            <p className="truncate text-xs text-gray-500">{chat.name}</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="space-y-4 p-4">
          <p className="text-sm text-gray-600">
            Overrides for this chat only. Anything left on <em>Inherit</em> follows the project and
            keeps following it as the project changes.
          </p>

          {/* ---- Model ---------------------------------------------------- */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="mb-1 text-sm font-semibold text-gray-900">Model</h2>
            <p className="mb-2 text-xs text-gray-500">
              Applies immediately — it is not part of Save.
            </p>
            <button
              onClick={onOpenModelSelector}
              className="flex h-11 w-full items-center justify-between rounded-lg border border-gray-300 px-3 text-left text-base hover:bg-gray-50"
            >
              <span className="truncate">
                {(chat.apiDefinitionId !== null || chat.modelId !== null) && '* '}
                {currentModelId || 'No model'}
              </span>
              <span className="text-gray-400">▼</span>
            </button>
          </section>

          {/* ---- System prompt -------------------------------------------- */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold text-gray-900">System Prompt</h2>
            <fieldset className="mb-3">
              <legend className="sr-only">System prompt source</legend>
              {(
                [
                  ['project', "Use the project's prompt", 'This chat adds nothing of its own.'],
                  ['replace', 'Replace it', "The project's prompt is dropped entirely."],
                  ['append', 'Append to it', "The project's prompt comes first."],
                ] as const
              ).map(([mode, label, hint]) => (
                <label key={mode} className="flex items-start gap-2 py-1">
                  <input
                    type="radio"
                    name="systemPromptMode"
                    checked={draft.systemPromptMode === mode}
                    onChange={() => patch({ systemPromptMode: mode })}
                    className="mt-1 h-4 w-4"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-gray-900">{label}</span>
                    <span className="block text-xs text-gray-500">{hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {/* Typed values stay in the draft while disabled, so
                replace → project → replace doesn't lose work. */}
            <div className={promptModeDisabled ? 'pointer-events-none opacity-40' : ''}>
              <div className="border-t border-gray-100 py-3">
                <label
                  htmlFor="cs-persona"
                  className="mb-1 block text-sm font-medium text-gray-900"
                >
                  Persona
                </label>
                <p className="mb-1 text-xs text-gray-500">
                  Reads <code className="font-mono">{MINION_VFS_ROOT}/&lt;name&gt;.md</code> from
                  the root VFS, even when this chat is namespaced.
                </p>
                <input
                  id="cs-persona"
                  type="text"
                  value={draft.persona}
                  disabled={promptModeDisabled}
                  onChange={e => {
                    const persona = e.target.value;
                    patch({
                      persona,
                      ...(namespaceTouched.current
                        ? {}
                        : { namespace: persona.trim() ? personaNamespace(persona.trim()) : '' }),
                    });
                  }}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div className="border-t border-gray-100 py-3">
                <span className="mb-1 block text-sm font-medium text-gray-900">
                  Pre-persona file
                </span>
                <div className="mb-2 flex gap-3 text-sm">
                  {(
                    [
                      ['default', 'Default'],
                      ['off', 'Off'],
                      ['custom', 'Custom'],
                    ] as const
                  ).map(([mode, label]) => (
                    <label key={mode} className="flex items-center gap-1">
                      <input
                        type="radio"
                        name="prePersonaMode"
                        checked={draft.prePersonaMode === mode}
                        disabled={promptModeDisabled}
                        onChange={() => patch({ prePersonaMode: mode })}
                        className="h-4 w-4"
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
                {draft.prePersonaMode === 'custom' && (
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={draft.prePersonaSystemPromptFile}
                      placeholder={`${MINION_VFS_ROOT}/_global.md`}
                      disabled={promptModeDisabled}
                      aria-label="Pre-persona file path"
                      onChange={e => patch({ prePersonaSystemPromptFile: e.target.value })}
                      className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 font-mono text-base focus:border-blue-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setIsPickingPrePersona(true)}
                      aria-label="Browse for pre-persona file"
                      className="flex h-11 w-9 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100"
                    >
                      📁
                    </button>
                  </div>
                )}
                <p className="mt-1 text-xs text-gray-500">
                  Default reads <code className="font-mono">{MINION_VFS_ROOT}/_global.md</code> if
                  it exists. Off skips it. A custom path must exist or the turn fails.
                </p>
              </div>

              <div className="border-t border-gray-100 py-3">
                <span className="mb-1 block text-sm font-medium text-gray-900">Prompt files</span>
                <p className="mb-2 text-xs text-gray-500">
                  Read in order and appended after the persona block, every turn.
                </p>
                <PromptFileList
                  paths={draft.systemPromptFiles}
                  adapter={adapter}
                  onChange={systemPromptFiles => patch({ systemPromptFiles })}
                />
              </div>

              <div className="border-t border-gray-100 py-3">
                <label htmlFor="cs-inline" className="mb-1 block text-sm font-medium text-gray-900">
                  Inline prompt
                </label>
                <textarea
                  id="cs-inline"
                  value={draft.systemPrompt}
                  rows={5}
                  disabled={promptModeDisabled}
                  onChange={e => patch({ systemPrompt: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-base focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>

            <ResolvedPromptPreview chatId={chat.id} overrides={fromDraft(draft)} />
          </section>

          {/* ---- Workspace ------------------------------------------------ */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold text-gray-900">Workspace</h2>
            <InheritableField
              label="VFS namespace"
              hint="Sandboxes every file-touching tool in this chat. Persona and prompt files still read from the root."
              inheritedValue="root"
              isOverridden={draft.namespace !== ''}
              onToggle={override => {
                namespaceTouched.current = true;
                patch({ namespace: override ? personaNamespace(draft.persona || 'default') : '' });
              }}
            >
              <input
                type="text"
                value={draft.namespace}
                aria-label="VFS namespace"
                onChange={e => {
                  namespaceTouched.current = true;
                  patch({ namespace: e.target.value });
                }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-base focus:border-blue-500 focus:outline-none"
              />
            </InheritableField>

            <InheritableField
              label="Tools"
              hint="Narrowing only — the project's set is the ceiling."
              inheritedValue={projectTools.join(', ') || 'none'}
              isOverridden={draft.enabledTools !== undefined}
              onToggle={override =>
                patch({ enabledTools: override ? [...projectTools] : undefined })
              }
            >
              <div className="space-y-1">
                {availableTools
                  .filter(tool => projectTools.includes(tool.name))
                  .map(tool => (
                    <label key={tool.name} className="flex items-center gap-2 py-1 text-sm">
                      <input
                        type="checkbox"
                        checked={draft.enabledTools?.includes(tool.name) ?? false}
                        onChange={e =>
                          patch({
                            enabledTools: e.target.checked
                              ? [...(draft.enabledTools ?? []), tool.name]
                              : (draft.enabledTools ?? []).filter(t => t !== tool.name),
                          })
                        }
                        className="h-5 w-5 rounded text-blue-600"
                      />
                      <span>{tool.name}</span>
                    </label>
                  ))}
                {unknownEnabled.map(name => (
                  <label key={name} className="flex items-center gap-2 py-1 text-sm text-gray-500">
                    <input type="checkbox" checked readOnly className="h-5 w-5 rounded" />
                    <span>{name} (not registered)</span>
                  </label>
                ))}
                <p className="pt-1 text-xs text-gray-500">
                  Tool options come from project settings.
                </p>
              </div>
            </InheritableField>

            <InheritableField
              label="Web search"
              inheritedValue={project.webSearchEnabled ? 'on' : 'off'}
              isOverridden={draft.webSearchEnabled !== undefined}
              onToggle={override =>
                patch({ webSearchEnabled: override ? project.webSearchEnabled : undefined })
              }
            >
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.webSearchEnabled ?? false}
                  onChange={e => patch({ webSearchEnabled: e.target.checked })}
                  className="h-5 w-5 rounded text-blue-600"
                />
                <span>Enable web search</span>
              </label>
            </InheritableField>

            <InheritableField
              label="File line numbers"
              inheritedValue={project.noLineNumbers ? 'hidden' : 'shown'}
              isOverridden={draft.fileLineNumbers !== undefined}
              onToggle={override =>
                patch({ fileLineNumbers: override ? !project.noLineNumbers : undefined })
              }
            >
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.fileLineNumbers ?? false}
                  onChange={e => patch({ fileLineNumbers: e.target.checked })}
                  className="h-5 w-5 rounded text-blue-600"
                />
                <span>Show line numbers in file output</span>
              </label>
            </InheritableField>
          </section>

          {/* ---- Generation ----------------------------------------------- */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold text-gray-900">Generation</h2>

            <InheritableField
              label="Temperature"
              inheritedValue={project.temperature ?? 'provider default'}
              isOverridden={draft.temperature !== undefined}
              note={ignoredNote}
              onToggle={override =>
                patch({ temperature: override ? String(project.temperature ?? 1) : undefined })
              }
            >
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={draft.temperature ?? ''}
                aria-label="Temperature"
                onChange={e => patch({ temperature: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none"
              />
            </InheritableField>

            <InheritableField
              label="Max output tokens"
              inheritedValue={project.maxOutputTokens}
              isOverridden={draft.maxOutputTokens !== undefined}
              note={ignoredNote}
              onToggle={override =>
                patch({ maxOutputTokens: override ? String(project.maxOutputTokens) : undefined })
              }
            >
              <input
                type="number"
                min="1"
                value={draft.maxOutputTokens ?? ''}
                aria-label="Max output tokens"
                onChange={e => patch({ maxOutputTokens: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none"
              />
            </InheritableField>

            <InheritableField
              label="Thinking nudge"
              hint="Appended to the last user message. An empty value disables it."
              inheritedValue="from the API definition"
              isOverridden={draft.nudgeThinking !== undefined}
              onToggle={override => patch({ nudgeThinking: override ? '' : undefined })}
            >
              <input
                type="text"
                value={draft.nudgeThinking ?? ''}
                aria-label="Thinking nudge"
                placeholder="(empty — nudge disabled)"
                onChange={e => patch({ nudgeThinking: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none"
              />
            </InheritableField>
          </section>

          {/* ---- Reasoning ------------------------------------------------ */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold text-gray-900">Reasoning</h2>

            <InheritableField
              label="Enable reasoning"
              inheritedValue={project.enableReasoning ? 'on' : 'off'}
              isOverridden={draft.enableReasoning !== undefined}
              onToggle={override =>
                patch({ enableReasoning: override ? project.enableReasoning : undefined })
              }
            >
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.enableReasoning ?? false}
                  onChange={e => patch({ enableReasoning: e.target.checked })}
                  className="h-5 w-5 rounded text-blue-600"
                />
                <span>Enable extended thinking</span>
              </label>
            </InheritableField>

            <InheritableField
              label="Reasoning effort"
              inheritedValue={project.reasoningEffort ?? '(default)'}
              isOverridden={draft.hasReasoningEffort}
              onToggle={override =>
                patch({ hasReasoningEffort: override, reasoningEffort: project.reasoningEffort })
              }
            >
              <ReasoningEffortSelect
                id="cs-effort"
                label=""
                hint=""
                value={draft.reasoningEffort}
                onChange={reasoningEffort => patch({ reasoningEffort })}
              />
            </InheritableField>

            <InheritableField
              label="Reasoning budget tokens"
              inheritedValue={project.reasoningBudgetTokens}
              isOverridden={draft.reasoningBudgetTokens !== undefined}
              note={ignoredNote}
              onToggle={override =>
                patch({
                  reasoningBudgetTokens: override
                    ? String(project.reasoningBudgetTokens)
                    : undefined,
                })
              }
            >
              <input
                type="number"
                min="0"
                value={draft.reasoningBudgetTokens ?? ''}
                aria-label="Reasoning budget tokens"
                onChange={e => patch({ reasoningBudgetTokens: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none"
              />
            </InheritableField>

            <InheritableField
              label="Thinking keep turns"
              hint="-1 keeps everything; 0 or more keeps that many turns."
              inheritedValue={project.thinkingKeepTurns ?? 'model default'}
              isOverridden={draft.thinkingKeepTurns !== undefined}
              note={ignoredNote}
              onToggle={override =>
                patch({
                  thinkingKeepTurns: override ? String(project.thinkingKeepTurns ?? -1) : undefined,
                })
              }
            >
              <input
                type="number"
                min="-1"
                value={draft.thinkingKeepTurns ?? ''}
                aria-label="Thinking keep turns"
                onChange={e => patch({ thinkingKeepTurns: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none"
              />
            </InheritableField>

            <InheritableField
              label="Prune thinking before the API call"
              inheritedValue={project.pruneThinkingBeforeApiCall ? 'on' : 'off'}
              isOverridden={draft.pruneThinkingBeforeApiCall !== undefined}
              note={ignoredNote}
              onToggle={override =>
                patch({
                  pruneThinkingBeforeApiCall: override
                    ? !!project.pruneThinkingBeforeApiCall
                    : undefined,
                })
              }
            >
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.pruneThinkingBeforeApiCall ?? false}
                  onChange={e => patch({ pruneThinkingBeforeApiCall: e.target.checked })}
                  className="h-5 w-5 rounded text-blue-600"
                />
                <span>Strip older thinking blocks locally</span>
              </label>
            </InheritableField>

            <InheritableField
              label="Verbosity"
              inheritedValue={project.verbosity ?? '(default)'}
              isOverridden={draft.hasVerbosity}
              onToggle={override => patch({ hasVerbosity: override, verbosity: project.verbosity })}
            >
              <select
                value={draft.verbosity ?? ''}
                aria-label="Verbosity"
                onChange={e => patch({ verbosity: (e.target.value || undefined) as Verbosity })}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base focus:border-blue-500 focus:outline-none"
              >
                <option value="">(default)</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </InheritableField>
          </section>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-gray-200 bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <span aria-live="polite" className="text-sm text-gray-500">
          {saveStatus}
        </span>
        <div className="flex items-center gap-2">
          {isSaving && <Spinner size={14} />}
          <button
            onClick={handleClose}
            disabled={isSaving}
            className="h-11 rounded-lg px-4 text-base text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
          >
            Close
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || !isDirty}
            className="h-11 rounded-lg bg-blue-600 px-4 text-base font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>

      {isPickingPrePersona && (
        <VfsPathPickerModal
          isOpen
          adapter={adapter}
          initialPath={draft.prePersonaSystemPromptFile || undefined}
          title="Choose a pre-persona file"
          onCancel={() => setIsPickingPrePersona(false)}
          onSelect={path => {
            patch({ prePersonaSystemPromptFile: path });
            setIsPickingPrePersona(false);
          }}
        />
      )}
    </div>
  );
}
