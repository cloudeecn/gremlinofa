/**
 * Chat-level agent-config resolution.
 *
 * The middle layer of the precedence chain `project → chat.agentConfig →
 * runtime loop options`. Pure and I/O-free, so the whole precedence table is
 * unit-testable without storage or a VFS — the same shape as
 * `resolveNoLineNumbers` in `formatFileContent.ts`.
 *
 * **Not overridable at chat level**, deliberately — transport and provider
 * knobs rather than agent identity. Do not re-derive this list; extend it here
 * with a reason if it ever changes:
 *   `preFillResponse`, `disableStream`, `extendedContext`,
 *   `useAnthropicOneHourCache`, `noLineNumbers`, `cacheRoutingScope`,
 *   `reasoningSummary`, `flexTierEnabled`, `toolOptions`.
 *
 * `toolOptions` stays project-level even though `enabledTools` does not: both
 * `getSystemPrompts` and the tool-definition builder filter by the enabled-name
 * list, so a narrowed override already narrows the injected prompts and the
 * exposed schema without a second override surface.
 */

import type {
  APIDefinition,
  ChatAgentConfig,
  Project,
  ReasoningEffort,
  Verbosity,
} from '../../protocol/types';
import { NUDGE_THINKING_DEFAULT } from '../../services/api/apiService';

export interface ResolvedAgentSettings {
  temperature: number | undefined;
  maxTokens: number;
  webSearchEnabled: boolean;
  enabledTools: string[];
  enableReasoning: boolean;
  reasoningBudgetTokens: number;
  reasoningEffort: ReasoningEffort | undefined;
  verbosity: Verbosity;
  thinkingKeepTurns: number | undefined;
  pruneThinkingKeepTurns: number | undefined;
  nudgeThinking: string | undefined;
  /** Positive polarity (true = show). Undefined defers to `project.noLineNumbers`. */
  fileLineNumbers: boolean | undefined;
  /** VFS namespace for every VFS-touching tool. undefined = root. */
  namespace: string | undefined;
}

export function resolveChatAgentSettings(
  project: Project,
  apiDef: APIDefinition,
  agent: ChatAgentConfig | undefined
): ResolvedAgentSettings {
  const projectTools = project.enabledTools ?? [];
  // Narrowing only: the project stays the ceiling, so a stale cloned config
  // cannot re-enable a tool the user has since switched off project-wide.
  // Same rule `buildMinionTools` applies to minion tool sets.
  const enabledTools = agent?.enabledTools
    ? projectTools.filter(t => agent.enabledTools?.includes(t))
    : projectTools;

  const thinkingKeepTurns = agent?.thinkingKeepTurns ?? project.thinkingKeepTurns;
  const pruneThinking = agent?.pruneThinkingBeforeApiCall ?? project.pruneThinkingBeforeApiCall;

  return {
    temperature: agent?.temperature ?? project.temperature ?? undefined,
    maxTokens: agent?.maxOutputTokens ?? project.maxOutputTokens,
    webSearchEnabled: agent?.webSearchEnabled ?? project.webSearchEnabled,
    enabledTools,
    enableReasoning: agent?.enableReasoning ?? project.enableReasoning,
    reasoningBudgetTokens: agent?.reasoningBudgetTokens ?? project.reasoningBudgetTokens,
    reasoningEffort: agent?.reasoningEffort ?? project.reasoningEffort,
    verbosity: agent?.verbosity ?? project.verbosity,
    thinkingKeepTurns,
    pruneThinkingKeepTurns:
      pruneThinking && thinkingKeepTurns !== undefined && thinkingKeepTurns >= 0
        ? thinkingKeepTurns
        : undefined,
    // '' is a value here, not "inherit": it disables the nudge even when the
    // API definition enables it.
    nudgeThinking:
      typeof agent?.nudgeThinking === 'string'
        ? agent.nudgeThinking
        : apiDef.advancedSettings?.nudgeThinking
          ? NUDGE_THINKING_DEFAULT
          : undefined,
    fileLineNumbers: agent?.fileLineNumbers,
    // Projects have no namespace, so '' and absent both mean the root VFS.
    namespace: agent?.namespace || undefined,
  };
}
