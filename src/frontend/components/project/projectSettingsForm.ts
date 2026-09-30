/**
 * Project <-> form conversion and the form reducer for ProjectSettingsView.
 *
 * Its own module so the view file exports only a component (fast refresh),
 * and so "open settings, change nothing, save" is testable as a round trip
 * without rendering the page.
 */

import type {
  Project,
  ToolOptionDefinition,
  ToolOptions,
  ToolOptionValue,
  Verbosity,
} from '../../../shared/protocol/types';
import { initializeToolOptions } from '../../../shared/protocol/types';

/**
 * Every project field the settings page edits, keyed by its `Project` name.
 *
 * Numeric fields hold the typed text, so a cleared or half-typed input is
 * representable; `formToProjectPatch` parses them once, on save.
 */
export interface ProjectSettingsForm {
  apiDefinitionId: string | null;
  modelId: string | null;
  systemPrompt: string;
  preFillResponse: string;
  temperature: string;
  maxOutputTokens: string;
  enableReasoning: boolean;
  reasoningBudgetTokens: string;
  thinkingKeepTurns: string;
  pruneThinkingBeforeApiCall: boolean;
  reasoningEffort: Project['reasoningEffort'];
  reasoningSummary: Project['reasoningSummary'];
  verbosity: Verbosity;
  webSearchEnabled: boolean;
  sendMessageMetadata: boolean | 'template';
  metadataTimestampMode: NonNullable<Project['metadataTimestampMode']>;
  metadataIncludeModelName: boolean;
  metadataIncludeContextWindow: boolean;
  metadataIncludeCost: boolean;
  metadataTemplate: string;
  metadataNewContext: boolean;
  enabledTools: string[];
  toolOptions: Record<string, ToolOptions>;
  disableStream: boolean;
  extendedContext: boolean;
  useAnthropicOneHourCache: boolean;
  noLineNumbers: boolean;
  cacheRoutingScope: 'project' | 'chat';
  flexTierEnabled: boolean;
  remoteVfsUrl: string;
  remoteVfsPassword: string;
}

/** The fields a settings save writes; the type also pins every form key to a `Project` field. */
export type ProjectSettingsPatch = Pick<Project, keyof ProjectSettingsForm>;

const DEFAULT_REASONING_BUDGET_TOKENS = 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 1536;

export function projectToForm(project: Project): ProjectSettingsForm {
  return {
    apiDefinitionId: project.apiDefinitionId || null,
    modelId: project.modelId || null,
    systemPrompt: project.systemPrompt || '',
    preFillResponse: project.preFillResponse || '',
    temperature: project.temperature == null ? '' : String(project.temperature),
    maxOutputTokens: String(project.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS),
    enableReasoning: project.enableReasoning || false,
    reasoningBudgetTokens: String(project.reasoningBudgetTokens ?? DEFAULT_REASONING_BUDGET_TOKENS),
    thinkingKeepTurns:
      project.thinkingKeepTurns === undefined ? '' : String(project.thinkingKeepTurns),
    pruneThinkingBeforeApiCall: project.pruneThinkingBeforeApiCall ?? false,
    reasoningEffort: project.reasoningEffort,
    reasoningSummary: project.reasoningSummary,
    verbosity: project.verbosity,
    webSearchEnabled: project.webSearchEnabled || false,
    sendMessageMetadata: project.sendMessageMetadata || false,
    metadataTimestampMode: project.metadataTimestampMode || 'disabled',
    metadataIncludeModelName: project.metadataIncludeModelName || false,
    metadataIncludeContextWindow: project.metadataIncludeContextWindow || false,
    metadataIncludeCost: project.metadataIncludeCost || false,
    metadataTemplate: project.metadataTemplate || '{{userMessage}}',
    metadataNewContext: project.metadataNewContext || false,
    enabledTools: project.enabledTools ?? [],
    toolOptions: project.toolOptions ?? {},
    disableStream: project.disableStream || false,
    extendedContext: project.extendedContext || false,
    useAnthropicOneHourCache: project.useAnthropicOneHourCache || false,
    noLineNumbers: project.noLineNumbers || false,
    cacheRoutingScope: project.cacheRoutingScope ?? 'project',
    flexTierEnabled: project.flexTierEnabled || false,
    remoteVfsUrl: project.remoteVfsUrl || '',
    remoteVfsPassword: project.remoteVfsPassword || '',
  };
}

function parseIntOr(text: string, fallback: number): number {
  const parsed = parseInt(text, 10);
  return isNaN(parsed) ? fallback : parsed;
}

/**
 * Opt-in flags and empty collections are written as `undefined`, which
 * `updateProject` turns into an unset, so an untouched project keeps them
 * absent instead of gaining `false` / `[]` keys.
 *
 * `serverMode`: the server backend owns the VFS, so a remote VFS set earlier
 * in worker mode is cleared rather than carried along.
 */
export function formToProjectPatch(
  form: ProjectSettingsForm,
  { serverMode = false }: { serverMode?: boolean } = {}
): ProjectSettingsPatch {
  const temperature = parseFloat(form.temperature);
  const keepTurns = parseInt(form.thinkingKeepTurns, 10);
  return {
    apiDefinitionId: form.apiDefinitionId,
    modelId: form.modelId,
    systemPrompt: form.systemPrompt,
    preFillResponse: form.preFillResponse,
    temperature: isNaN(temperature) ? null : temperature,
    maxOutputTokens: parseIntOr(form.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
    enableReasoning: form.enableReasoning,
    reasoningBudgetTokens: parseIntOr(form.reasoningBudgetTokens, DEFAULT_REASONING_BUDGET_TOKENS),
    thinkingKeepTurns: isNaN(keepTurns) ? undefined : keepTurns,
    pruneThinkingBeforeApiCall: form.pruneThinkingBeforeApiCall || undefined,
    reasoningEffort: form.reasoningEffort,
    reasoningSummary: form.reasoningSummary,
    verbosity: form.verbosity,
    webSearchEnabled: form.webSearchEnabled,
    sendMessageMetadata: form.sendMessageMetadata,
    metadataTimestampMode: form.metadataTimestampMode,
    metadataIncludeModelName: form.metadataIncludeModelName,
    metadataIncludeContextWindow: form.metadataIncludeContextWindow,
    metadataIncludeCost: form.metadataIncludeCost,
    metadataTemplate: form.metadataTemplate,
    metadataNewContext: form.metadataNewContext,
    enabledTools: form.enabledTools.length > 0 ? form.enabledTools : undefined,
    toolOptions: Object.keys(form.toolOptions).length > 0 ? form.toolOptions : undefined,
    disableStream: form.disableStream || undefined,
    extendedContext: form.extendedContext || undefined,
    useAnthropicOneHourCache: form.useAnthropicOneHourCache || undefined,
    noLineNumbers: form.noLineNumbers || undefined,
    cacheRoutingScope: form.cacheRoutingScope === 'chat' ? 'chat' : undefined,
    flexTierEnabled: form.flexTierEnabled || undefined,
    remoteVfsUrl: serverMode ? undefined : form.remoteVfsUrl.trim() || undefined,
    remoteVfsPassword: serverMode ? undefined : form.remoteVfsPassword || undefined,
  };
}

export interface ProjectSettingsState {
  /** The project instance the form was last seeded from. */
  seededFrom: Project | null;
  /** `null` until a project has loaded. */
  form: ProjectSettingsForm | null;
}

type FormAction =
  | { type: 'patch'; fields: Partial<ProjectSettingsForm> }
  | {
      type: 'toggleTool';
      toolName: string;
      enabled: boolean;
      optionDefinitions?: ToolOptionDefinition[];
    }
  | { type: 'setToolOption'; toolName: string; optionId: string; value: ToolOptionValue };

/** `seed` replaces the form with a newly arrived project instance. */
export type ProjectSettingsAction = { type: 'seed'; project: Project | null } | FormAction;

export function initProjectSettingsState(project: Project | null): ProjectSettingsState {
  return { seededFrom: project, form: project ? projectToForm(project) : null };
}

function updateForm(form: ProjectSettingsForm, action: FormAction): ProjectSettingsForm {
  switch (action.type) {
    case 'patch':
      return { ...form, ...action.fields };
    case 'toggleTool': {
      const { toolName } = action;
      const others = form.enabledTools.filter(t => t !== toolName);
      if (!action.enabled) return { ...form, enabledTools: others };
      // Options the tool hasn't stored yet get their defaults now, so the
      // nested option controls show real values; a model option defaults to
      // the project's model as currently selected in this form.
      const toolOptions = action.optionDefinitions?.length
        ? {
            ...form.toolOptions,
            [toolName]: initializeToolOptions(
              form.toolOptions[toolName],
              action.optionDefinitions,
              { apiDefinitionId: form.apiDefinitionId, modelId: form.modelId }
            ),
          }
        : form.toolOptions;
      return { ...form, enabledTools: [...others, toolName], toolOptions };
    }
    case 'setToolOption': {
      const { toolName, optionId, value } = action;
      return {
        ...form,
        toolOptions: {
          ...form.toolOptions,
          [toolName]: { ...form.toolOptions[toolName], [optionId]: value },
        },
      };
    }
  }
}

export function projectSettingsReducer(
  state: ProjectSettingsState,
  action: ProjectSettingsAction
): ProjectSettingsState {
  if (action.type === 'seed') {
    // A project never goes back to null once loaded; keep the form if it did.
    return action.project
      ? initProjectSettingsState(action.project)
      : { seededFrom: null, form: state.form };
  }
  if (!state.form) return state;
  return { ...state, form: updateForm(state.form, action) };
}
