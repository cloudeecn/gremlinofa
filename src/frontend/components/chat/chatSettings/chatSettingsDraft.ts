/**
 * Pure draft <-> persisted-config conversion for the chat settings panel.
 *
 * Its own module so the panel file exports only a component (fast refresh),
 * and because these two functions are the main unit-test surface of the form:
 * every `''`-is-a-value and inherit-vs-override rule lands here.
 */

import type {
  ChatAgentConfig,
  ChatSystemPromptMode,
  ReasoningEffort,
  Verbosity,
} from '../../../../shared/protocol/types';

/**
 * Draft shape: the persisted config with numeric fields held as strings.
 *
 * Numbers live as strings so a half-typed "0." or a cleared field is
 * representable — `number | undefined` would force every keystroke through a
 * parse and turn "" into either 0 or "inherit", both wrong. `fromDraft` does
 * the coercion once, on save.
 */
export interface ChatSettingsDraft {
  systemPromptMode: ChatSystemPromptMode;
  persona: string;
  namespace: string;
  prePersonaMode: 'default' | 'off' | 'custom';
  prePersonaSystemPromptFile: string;
  systemPromptFiles: string[];
  systemPrompt: string;
  enabledTools: string[] | undefined;
  temperature: string | undefined;
  maxOutputTokens: string | undefined;
  enableReasoning: boolean | undefined;
  reasoningBudgetTokens: string | undefined;
  reasoningEffort: ReasoningEffort | undefined;
  hasReasoningEffort: boolean;
  verbosity: Verbosity;
  hasVerbosity: boolean;
  webSearchEnabled: boolean | undefined;
  fileLineNumbers: boolean | undefined;
  nudgeThinking: string | undefined;
  thinkingKeepTurns: string | undefined;
  pruneThinkingBeforeApiCall: boolean | undefined;
}

const asString = (n: number | undefined) => (n === undefined ? undefined : String(n));

export function toDraft(cfg: ChatAgentConfig | undefined): ChatSettingsDraft {
  const files = cfg?.systemPromptFile;
  return {
    systemPromptMode: cfg?.systemPromptMode ?? 'project',
    persona: cfg?.persona ?? '',
    namespace: cfg?.namespace ?? '',
    // `''` is a value, not "inherit" — it disables the pre-persona read. The
    // three-way mode keeps that distinguishable from "use the default path".
    prePersonaMode:
      cfg?.prePersonaSystemPromptFile === undefined
        ? 'default'
        : cfg.prePersonaSystemPromptFile === ''
          ? 'off'
          : 'custom',
    prePersonaSystemPromptFile: cfg?.prePersonaSystemPromptFile || '',
    systemPromptFiles: typeof files === 'string' ? [files] : (files ?? []),
    systemPrompt: cfg?.systemPrompt ?? '',
    enabledTools: cfg?.enabledTools,
    temperature: asString(cfg?.temperature),
    maxOutputTokens: asString(cfg?.maxOutputTokens),
    enableReasoning: cfg?.enableReasoning,
    reasoningBudgetTokens: asString(cfg?.reasoningBudgetTokens),
    reasoningEffort: cfg?.reasoningEffort,
    hasReasoningEffort: cfg?.reasoningEffort !== undefined,
    verbosity: cfg?.verbosity,
    hasVerbosity: cfg?.verbosity !== undefined,
    webSearchEnabled: cfg?.webSearchEnabled,
    fileLineNumbers: cfg?.fileLineNumbers,
    nudgeThinking: cfg?.nudgeThinking,
    thinkingKeepTurns: asString(cfg?.thinkingKeepTurns),
    pruneThinkingBeforeApiCall: cfg?.pruneThinkingBeforeApiCall,
  };
}

/** `''` or unparseable drops the key entirely rather than emitting NaN. */
function asNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function fromDraft(draft: ChatSettingsDraft): ChatAgentConfig | undefined {
  const cfg: ChatAgentConfig = {};

  if (draft.systemPromptMode !== 'project') {
    cfg.systemPromptMode = draft.systemPromptMode;
    if (draft.persona.trim()) cfg.persona = draft.persona.trim();
    if (draft.systemPrompt) cfg.systemPrompt = draft.systemPrompt;
    const files = draft.systemPromptFiles.map(f => f.trim()).filter(Boolean);
    if (files.length === 1) cfg.systemPromptFile = files[0];
    else if (files.length > 1) cfg.systemPromptFile = files;
    // 'default' leaves the key absent; 'off' writes '' — both are meaningful,
    // and only 'custom' carries a path.
    if (draft.prePersonaMode === 'off') cfg.prePersonaSystemPromptFile = '';
    else if (draft.prePersonaMode === 'custom' && draft.prePersonaSystemPromptFile.trim()) {
      cfg.prePersonaSystemPromptFile = draft.prePersonaSystemPromptFile.trim();
    }
  }

  // Namespace is independent of prompt mode: a chat can be sandboxed without
  // changing who the agent is.
  if (draft.namespace.trim()) cfg.namespace = draft.namespace.trim();

  if (draft.enabledTools) cfg.enabledTools = draft.enabledTools;
  const temperature = asNumber(draft.temperature);
  if (temperature !== undefined) cfg.temperature = temperature;
  const maxOutputTokens = asNumber(draft.maxOutputTokens);
  if (maxOutputTokens !== undefined) cfg.maxOutputTokens = maxOutputTokens;
  if (draft.enableReasoning !== undefined) cfg.enableReasoning = draft.enableReasoning;
  const budget = asNumber(draft.reasoningBudgetTokens);
  if (budget !== undefined) cfg.reasoningBudgetTokens = budget;
  if (draft.hasReasoningEffort) cfg.reasoningEffort = draft.reasoningEffort;
  if (draft.hasVerbosity) cfg.verbosity = draft.verbosity;
  if (draft.webSearchEnabled !== undefined) cfg.webSearchEnabled = draft.webSearchEnabled;
  if (draft.fileLineNumbers !== undefined) cfg.fileLineNumbers = draft.fileLineNumbers;
  // '' here disables the nudge even when the API definition enables it, so it
  // must survive as a value rather than collapsing to inherit.
  if (typeof draft.nudgeThinking === 'string') cfg.nudgeThinking = draft.nudgeThinking;
  const keepTurns = asNumber(draft.thinkingKeepTurns);
  if (keepTurns !== undefined) cfg.thinkingKeepTurns = keepTurns;
  if (draft.pruneThinkingBeforeApiCall !== undefined) {
    cfg.pruneThinkingBeforeApiCall = draft.pruneThinkingBeforeApiCall;
  }

  return Object.keys(cfg).length > 0 ? cfg : undefined;
}
