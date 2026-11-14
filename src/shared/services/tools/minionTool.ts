/**
 * Minion Tool
 *
 * Allows the primary chat LLM to delegate tasks to a sub-agent LLM.
 * Each minion runs its own agentic loop with scoped-down tools and
 * returns results to the caller. A minion chat created with `remote: true`
 * goes to a human operator on the Touch Grass backend instead, for its whole
 * life (see `executeRemoteMinion`).
 *
 * Key features:
 * - Real-time streaming via generator yields (groups_delta events)
 * - Scoped tool access (minion can't spawn other minions)
 * - Separate minion chat storage for debugging/visibility
 * - Return tool support for explicit result signaling
 * - Builds renderingGroups with ToolInfoRenderBlock for nested display
 */

import type {
  ClientSideTool,
  Message,
  MinionChat,
  MinionOutputFormat,
  ModelReference,
  ReasoningEffort,
  RenderingBlockGroup,
  SystemPromptContext,
  ToolContext,
  ToolInputSchema,
  ToolOptions,
  ToolResult,
  ToolResultBlock,
  ToolStreamEvent,
  Verbosity,
} from '../../protocol/types';
import type {
  TokenTotals,
  ToolInfoRenderBlock,
  ToolResultRenderBlock,
} from '../../protocol/types/content';
import type { ActiveLoop, LoopId } from '../../protocol/protocol';
import { isModelReference, isModelReferenceArray, isRemoteMinionChat } from '../../protocol/types';
import { splitInjectedFileBlocks } from '../../protocol/carriedInjection';
import {
  generateChecksummedId,
  generateUniqueId,
  validateIdChecksum,
} from '../../protocol/idGenerator';
import type { UnifiedStorage } from '../storage/unifiedStorage';
import {
  runAgenticLoop,
  createToolResultRenderBlock,
  type AgenticLoopOptions,
  type AgenticLoopEvent,
} from '../agentic/agenticLoopGenerator';
import { createTokenTotals, addTokens, hasTokenUsage } from '../../engine/lib/tokenTotals';
import { NORMAL_STOP_REASONS } from '../../engine/lib/apiHelpers';
import { formatFileWithLineNumbers } from '../../engine/lib/formatFileContent';
import type { InjectedFile, InjectionMode } from '../api/fileInjectionHelper';
import {
  buildInlineContent,
  buildInlineSection,
  buildMockToolCallPair,
  effectiveInjectionMode,
  hasCustomFraming,
  wrapInjectedFile,
} from '../api/fileInjectionHelper';
import { NUDGE_THINKING_DEFAULT } from '../api/apiService';
import { JsVMContext } from './jsvm/JsVMContext';
import type { HookInputMessage } from '../agentic/dummyHookRuntime';
import {
  makeEmitterState,
  nextStreamingOpsDelta,
  streamingResetDelta,
  finalizeMessageDelta,
} from './toolGroupsDelta';
import { shouldForkSession } from '../../engine/lib/claudeAgentSessionSharing';
import {
  findAssistantAnchorAtOrBefore,
  rewindPatchFromAnchor,
  type ClaudeAgentRewindAnchor,
  type ClaudeAgentStampedMessage,
} from '../../engine/lib/claudeAgentRewind';
import {
  AgentPromptError,
  type AgentPromptSpec,
  DEFAULT_PRE_PERSONA_FILE,
  MINION_VFS_ROOT,
  personaNamespace,
  resolveAgentSystemPrompt,
} from '../agentic/agentSystemPrompt';
import {
  TouchGrassClient,
  TouchGrassError,
  isSessionGone,
  isTouchGrassAbort,
  normalizeTouchGrassEndpoint,
  validateTouchGrassEndpoint,
  waitForAnswer,
  postMessageWithRetry,
  retryCancelInBackground,
  withRetry,
  type CancelOutcome,
  type PendingRequestRef,
  type PostedMessage,
  type RemoteInjectedFile,
  type WaitOutcome,
} from './touchGrassClient';

/** Truncate error messages to avoid wasting parent LLM context tokens */
export function truncateError(message: string, limit = 200): string {
  if (message.length <= limit) return message;
  return message.slice(0, limit) + '...';
}

/** Format a ModelReference as "apiDefinitionId:modelId" for schema enum values */
export function formatModelString(ref: ModelReference): string {
  return `${ref.apiDefinitionId}:${ref.modelId}`;
}

/** Parse "apiDefinitionId:modelId" back to a ModelReference. First colon only — modelId can contain colons (Bedrock ARNs). */
export function parseModelString(str: string): ModelReference | undefined {
  const idx = str.indexOf(':');
  if (idx === -1) return undefined;
  return { apiDefinitionId: str.substring(0, idx), modelId: str.substring(idx + 1) };
}

/**
 * Resolve which model a minion run will use, by precedence:
 *   input.model (requested by the LLM) > model stored on the minion chat
 *   (continuation) > the project's default model option.
 *
 * Pure precedence only — no validation. `executeMinion` validates an explicitly
 * requested `input.model` (format / membership) before relying on this, while
 * the parallel-throttle grouping uses it best-effort to find the upstream API
 * definition. Keep this the single source of the precedence ladder so the two
 * callers can't drift.
 */
export function resolveMinionModelRef(
  input: { model?: unknown },
  minionChat: { apiDefinitionId?: string; modelId?: string } | null | undefined,
  toolOptions: ToolOptions | undefined
): ModelReference | undefined {
  if (typeof input.model === 'string') {
    const parsed = parseModelString(input.model);
    if (parsed) return parsed;
  }
  if (minionChat?.apiDefinitionId && minionChat.modelId) {
    return { apiDefinitionId: minionChat.apiDefinitionId, modelId: minionChat.modelId };
  }
  const defaultRef = toolOptions?.model;
  if (defaultRef && isModelReference(defaultRef)) {
    return defaultRef;
  }
  return undefined;
}

/** Strip a namespace prefix from a path for minion-facing display */
export function stripNsPrefix(path: string, prefix?: string): string {
  if (!prefix) return path;
  if (path === prefix) return '/';
  if (path.startsWith(prefix + '/')) return path.slice(prefix.length);
  return path;
}

/** Stashed content from a rolled-back message for re-use during retry */
interface StashedRetryContent {
  modelFamily?: string;
  fullContent?: unknown;
  renderingContent?: RenderingBlockGroup[];
  injectedFiles?: Array<{ path: string; content: string; preamble?: string; postamble?: string }>;
  injectedFilesAfter?: Array<{
    path: string;
    content: string;
    preamble?: string;
    postamble?: string;
  }>;
  injectionMode?: string;
}

/**
 * File text for the collapsible UI bars: the caller's custom preamble/postamble
 * when they supplied one, otherwise the full default framing — `=== path ===`
 * header plus the "Here's the content of…" intro. That is verbatim what the
 * minion reads in inline mode, so the bar shows the file the way the model got
 * it. Failed reads keep their bare error message.
 */
function buildInjectedFileDisplay(file: InjectedFile & { error?: boolean }, label = ''): string {
  return file.error ? file.content : buildInlineSection(file, label);
}

/** ToolInfoRenderBlock entry for an injected file, with the framing baked in */
function toInfoFileEntry(file: InjectedFile & { error?: boolean }, label = '') {
  return { path: file.path, content: buildInjectedFileDisplay(file, label), error: file.error };
}

/** The same entry as a rendering block */
function toInjectedFileBlock(file: InjectedFile & { error?: boolean }, label = '') {
  return { type: 'injected_file' as const, ...toInfoFileEntry(file, label) };
}

/** Strip the read-time-only `error` flag before an entry is stored on a message */
function toStoredInjectedFile(file: {
  path: string;
  content: string;
  preamble?: string;
  postamble?: string;
}) {
  return {
    path: file.path,
    content: file.content,
    ...(file.preamble !== undefined && { preamble: file.preamble }),
    ...(file.postamble !== undefined && { postamble: file.postamble }),
  };
}

/** Object form of an `injectFiles` entry with optional custom framing */
export interface InjectFileSpec {
  path: string;
  /** Text placed before the content, replacing the default `=== path ===` framing */
  preamble?: string;
  /** Text placed after the content, replacing the default framing */
  postamble?: string;
}

/**
 * Extract text from a tool_result message's fullContent.
 * buildToolResultMessage sets content.content = '' — the actual payload is in fullContent.
 */
function extractToolResultText(fullContent: unknown): string | undefined {
  if (!Array.isArray(fullContent) || fullContent.length === 0) return undefined;

  const first = fullContent[0];
  if (!first || typeof first !== 'object') return undefined;

  // Anthropic: { type: 'tool_result', content: string }
  if ('type' in first && first.type === 'tool_result' && 'content' in first) {
    return typeof first.content === 'string' ? first.content : undefined;
  }

  // Responses API: { type: 'function_call_output', output: string }
  if ('type' in first && first.type === 'function_call_output' && 'output' in first) {
    return typeof first.output === 'string' ? first.output : undefined;
  }

  // OpenAI Chat Completions: { type: 'tool_result', tool_call_id, content }
  // (same shape as Anthropic above — already handled)

  // Bedrock: { toolResult: { content: [{ text: string }] } }
  if ('toolResult' in first && first.toolResult && typeof first.toolResult === 'object') {
    const tr = first.toolResult as { content?: Array<{ text?: string }> };
    if (
      Array.isArray(tr.content) &&
      tr.content.length > 0 &&
      typeof tr.content[0].text === 'string'
    ) {
      return tr.content[0].text;
    }
  }

  return undefined;
}

// Maximum iterations for minion agentic loop (same as main loop)
const MAX_ITERATIONS = 50;

// Maximum auto-enforce retries when minion doesn't call the return tool
const AUTO_ENFORCE_MAX_RETRIES = 2;

// Default hard cap on minion nesting depth (depth 1 = a top-level chat's
// minion). Overridable per project via the `maxNestingDepth` tool option.
const DEFAULT_MAX_NESTING_DEPTH = 3;

// Sentinel savepoint value meaning "before any messages" (enables first-run retry)
export const SAVEPOINT_START = '_start';

/**
 * Resolve a minion call's persona, namespace and the four inputs
 * `resolveAgentSystemPrompt` needs.
 *
 * Extracted so `deriveChatAgentConfigFromMinion` can be tested against the
 * real thing rather than a transcription of it: a clone reproduces the
 * minion's prompt exactly when these inputs and the ones derived for the chat
 * layer agree, and `cloneMinionChat.equivalence.test.ts` asserts precisely
 * that. Pure — no VFS reads happen here.
 */
export function resolveMinionPromptInputs(
  minionInput: Pick<
    MinionInput,
    'persona' | 'prePersonaSystemPromptFile' | 'systemPrompt' | 'systemPromptFile'
  >,
  minionChat: Pick<
    MinionChat,
    'persona' | 'prePersonaSystemPromptFile' | 'systemPrompt' | 'systemPromptFile'
  >,
  minionToolOptions: ToolOptions
): {
  nsMode: string;
  persona: string;
  shouldNamespace: boolean;
  usePersonaFile: boolean;
  namespace: string | undefined;
  spec: Omit<AgentPromptSpec, 'createVfsAdapter'>;
} {
  const nsMode = (minionToolOptions.namespacedMinion as string | undefined) ?? 'off';
  const persona = minionInput.persona ?? minionChat.persona ?? 'default';
  // 'persona' mode namespaces only non-default personas; 'all' namespaces everyone.
  const shouldNamespace = nsMode !== 'off' && (nsMode === 'all' || persona !== 'default');
  // A persona file, when one is read, replaces the tool-level configured prompt.
  const usePersonaFile = shouldNamespace && persona !== 'default';

  // Pre-persona prompt path: input -> persisted -> default. `typeof` cascade so
  // '' explicitly disables the read instead of falling through to the default.
  const prePersonaOverride =
    typeof minionInput.prePersonaSystemPromptFile === 'string'
      ? minionInput.prePersonaSystemPromptFile
      : minionChat.prePersonaSystemPromptFile;

  return {
    nsMode,
    persona,
    shouldNamespace,
    usePersonaFile,
    namespace: shouldNamespace ? personaNamespace(persona) : undefined,
    spec: {
      persona: usePersonaFile ? persona : undefined,
      // Only namespaced minions read a pre-persona file at all.
      prePersonaFile: shouldNamespace ? prePersonaOverride : '',
      inlineSegments: [
        usePersonaFile
          ? undefined
          : typeof minionToolOptions.systemPrompt === 'string'
            ? minionToolOptions.systemPrompt
            : '',
        minionInput.systemPrompt ?? minionChat.systemPrompt,
      ],
      promptFiles: minionInput.systemPromptFile ?? minionChat.systemPromptFile,
    },
  };
}

/**
 * Map a resolver failure back to the minion's recovery text. These strings are
 * the LLM's instructions for fixing the call, so they are reproduced verbatim —
 * treat them as a behavioural contract, not as log messages.
 */
export function minionPromptErrorText(err: AgentPromptError): string {
  switch (err.kind) {
    case 'pre_persona_read_failed':
      return `Error: Failed to read prePersonaSystemPromptFile: ${err.path}. ${err.detail} Pass a corrected path, '' to disable, or '${DEFAULT_PRE_PERSONA_FILE}' to restore the default. Resend to reattempt.`;
    case 'persona_not_found':
      return `Error: Persona file ${err.path} not found. Create the file or use a different persona. Resend to reattempt.`;
    case 'prompt_file_read_failed':
      return `Error: Failed to read system prompt file: ${err.path}. ${err.detail}`;
  }
}

/** Input parameters for minion tool */
interface MinionInput {
  /** Action: 'message' (default) sends a new message, 'retry' rolls back to savepoint and re-executes */
  action?: 'message' | 'retry';
  /**
   * Optional: existing minion chat ID to continue a conversation, or
   * `<continueToken>@<minionChatId>` to continue it from an earlier result.
   * Read it through `parseMinionChatRef`.
   */
  minionChatId?: string;
  /**
   * Task/message to send to the minion. Required for 'message' action unless
   * `injectFiles` / `injectFilesAfter` carry the whole task; optional for 'retry'.
   */
  message?: string;
  /** Enable web search for the minion */
  enableWeb?: boolean;
  /** Scoped tools for the minion (intersected with project tools) */
  enabledTools?: string[];
  /** Persona name (matches /minions/<name>.md). Only used when namespacedMinion is enabled. */
  persona?: string;
  /** Model to use (formatted as "apiDefinitionId:modelId"). Only when namespacedMinion + models configured. */
  model?: string;
  /** Display name shown in the UI for this minion call. If omitted, persona name is used. */
  displayName?: string;
  /** VFS files to inject as context: paths, or objects with custom preamble/postamble framing. */
  injectFiles?: Array<string | InjectFileSpec>;
  /** Same as injectFiles, but the content lands after the message instead of before it. */
  injectFilesAfter?: Array<string | InjectFileSpec>;
  /**
   * Delegate to a remote human operator instead of an LLM sub-agent. Only
   * decides routing for a new chat; LLMs sometimes send it as a string, so
   * read it through `readRemoteFlag`.
   */
  remote?: boolean | 'true' | 'false';
  /**
   * Remote chats only: post the message as a note the human can't reply to,
   * and return at once. Read it through `readAsyncFlag`.
   */
  async?: boolean | 'true' | 'false';
  /**
   * New remote chats only: the Touch Grass user token whose inbox gets the
   * conversation. Sticks to the chat (`MinionChat.remoteToken`). Read it
   * through `readRemoteToken`.
   */
  remoteToken?: string;
  /**
   * Shape of this call's result; persists on the minion chat. Ignored by
   * returnMode 'both' results. Read it through `readOutputFormat`.
   */
  outputFormat?: MinionOutputFormat;
  /** Hook file name (without .js) in /hooks/ to verify minion output before savepoint advances */
  verifyHook?: string;
  /** Override reasoning on/off for this minion call */
  enableReasoning?: boolean;
  /** Override reasoning budget tokens. 0 = adaptive mode on supported models. */
  reasoningBudgetTokens?: number;
  /** Override reasoning effort level */
  reasoningEffort?: string;
  /** Override OpenAI response verbosity (low/medium/high). OpenAI GPT-5-era models only. */
  verbosity?: string;
  /** Override temperature for this minion call */
  temperature?: number;
  /** Override max output tokens for this minion call */
  maxOutputTokens?: number;
  /** Override how injected files are sent to the minion */
  fileInjectionMode?: string;
  /** Override line-number display (positive; true = show). Applies to injected files and the minion's own filesystem/memory reads. */
  fileLineNumbers?: boolean;
  /** Additional system prompt text, appended after persona/configured prompt */
  systemPrompt?: string;
  /** VFS file path(s) to system prompt file(s). String or array of strings; contents appended after systemPrompt in order. */
  systemPromptFile?: string | string[];
  /** Override the pre-persona ("global") prompt file path for namespaced personas (default /minions/_global.md). Empty string disables it. Persists on the minion chat. */
  prePersonaSystemPromptFile?: string;
  /** Override nudge text appended to the last user message for this minion call. Empty string disables. */
  nudgeThinking?: string;
  /** Override how many recent user turns of thinking blocks to keep. -1 = all, 0+ = exact count. */
  thinkingKeepTurns?: number;
  /** Override: when true (and thinkingKeepTurns is set to 0+), prune older thinking blocks client-side before the API call. */
  pruneThinkingBeforeApiCall?: boolean;
  /** Grant the spawned minion permission to spawn its own sub-minions (per-call nesting; default off). Bounded by the project `allowNesting` option + depth cap. */
  allowNesting?: boolean;
  /** Persona set the spawned minion may delegate to. Must be a subset of what THIS minion may delegate to. Omit to grant the full set this minion holds. */
  availablePersonas?: string[];
}

/** What a rollback hands a re-send: the first dropped message's content and text */
interface RollbackResult {
  stashedRetryContent: StashedRetryContent | undefined;
  recoveredMessage: string | undefined;
}

/**
 * A rollback worked out in memory by `planRollback` and written by
 * `applyRollback`, so a call that fails before its message is saved leaves the
 * chat as it found it.
 */
export interface RollbackPlan extends RollbackResult {
  /** The message the chat rolls back to (kept), or SAVEPOINT_START to keep none */
  pointId: string;
  /** Messages up to and including `pointId` */
  kept: Message<unknown>[];
  /** Messages after `pointId`; never empty */
  dropped: Message<unknown>[];
}

/**
 * Verify-feedback note markers (the `verifyFeedback` tool option). The note is
 * appended to a retried user message's model-visible content, so recovery has
 * to strip it back off — otherwise a second rejection would compare the
 * orchestrator's original message against "original + stale note" and miss the
 * true-retry match, and stale notes would stack in the rendered mirror.
 */
const VERIFY_FEEDBACK_NOTE_PREFIX = '[Previous attempt was rejected by verification: ';

function buildVerifyFeedbackNote(reason: string): string {
  return `${VERIFY_FEEDBACK_NOTE_PREFIX}${reason}]`;
}

/** Strip a trailing verify-feedback note (ours always ends the message). */
export function stripVerifyFeedbackNote(text: string): string {
  const idx = text.lastIndexOf(`\n\n${VERIFY_FEEDBACK_NOTE_PREFIX}`);
  if (idx === -1 || !text.endsWith(']')) return text;
  return text.slice(0, idx);
}

/** Rendering group holding a verify-feedback note (filtered on stash reuse). */
function isVerifyFeedbackNoteGroup(group: RenderingBlockGroup): boolean {
  if (group.isToolGenerated !== true || group.category !== 'text') return false;
  const only = group.blocks.length === 1 ? group.blocks[0] : undefined;
  return only?.type === 'text' && only.text.startsWith(VERIFY_FEEDBACK_NOTE_PREFIX);
}

/**
 * Decide whether a post-rollback send is a true retry of the recovered
 * original message, and hand back the stash only in that case. A different
 * message must build fresh content: reusing the old fullContent would send
 * the rolled-back text to the model (fullContent is canon for API providers),
 * and reusing renderingContent would render the old text in the chat mirror.
 */
export function resolveRetryStash(
  rollback: RollbackResult,
  message: string | undefined
): { isTrueRetry: boolean; stash: StashedRetryContent | undefined } {
  const isTrueRetry =
    rollback.recoveredMessage !== undefined && message === rollback.recoveredMessage;
  return { isTrueRetry, stash: isTrueRetry ? rollback.stashedRetryContent : undefined };
}

/**
 * True when the call injects at least one file. An inject-only call (no
 * `message`) is a complete task: the file content becomes the message.
 */
export function hasInjectSpecs(input: {
  injectFiles?: unknown[];
  injectFilesAfter?: unknown[];
}): boolean {
  return Boolean(input.injectFiles?.length || input.injectFilesAfter?.length);
}

/** True when a retry stash carries injected files that a re-send can rebuild. */
function stashHasInjectedFiles(stash: StashedRetryContent | undefined): boolean {
  return Boolean(stash?.injectedFiles?.length || stash?.injectedFilesAfter?.length);
}

/**
 * The text of a user message's own text group ('' for an inject-only message),
 * or undefined when it has none.
 */
function userTextOf(groups: RenderingBlockGroup[] | undefined): string | undefined {
  const textGroup = groups?.find(g => g.category === 'text' && !g.isToolGenerated);
  if (!textGroup) return undefined;
  return textGroup.blocks
    .map(b => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Plan a rollback of a minion chat to `pointId` (a message id, or
 * SAVEPOINT_START for none): slice off the messages after it, stash content
 * from the first dropped message for re-use, and recover the original message
 * text. Pure — storage and the chat totals are untouched until
 * `applyRollback`.
 *
 * `remote` marks a human chat, whose stored `content` is the inline text
 * (files framed around the message) while the human got the message and the
 * files apart: the original message is recovered from the text group instead.
 *
 * Returns undefined when `pointId` is not in the chat or nothing follows it.
 */
export function planRollback(
  existingMessages: Message<unknown>[],
  pointId: string,
  remote: boolean
): RollbackPlan | undefined {
  let keptCount = 0;
  if (pointId !== SAVEPOINT_START) {
    const pointIdx = existingMessages.findIndex(m => m.id === pointId);
    if (pointIdx === -1) return undefined;
    keptCount = pointIdx + 1;
  }
  const kept = existingMessages.slice(0, keptCount);
  const dropped = existingMessages.slice(keptCount);
  if (dropped.length === 0) return undefined;

  // Stash content from the first rolled-back message for potential re-use in Phase 3.
  // Tool_result messages have fullContent (the API payload) — user messages have renderingContent
  // (injected file bars, text groups). Both paths preserve rendering fidelity on retry.
  let stashedRetryContent: StashedRetryContent | undefined;
  const stashedFirst = dropped[0].content;
  if (stashedFirst.fullContent) {
    stashedRetryContent = {
      modelFamily: stashedFirst.modelFamily as string | undefined,
      fullContent: stashedFirst.fullContent,
      renderingContent: stashedFirst.renderingContent as RenderingBlockGroup[] | undefined,
      injectedFiles: stashedFirst.injectedFiles,
      injectedFilesAfter: stashedFirst.injectedFilesAfter,
      injectionMode: stashedFirst.injectionMode,
    };
  } else if (stashedFirst.renderingContent) {
    stashedRetryContent = {
      modelFamily: undefined,
      fullContent: undefined,
      renderingContent: stashedFirst.renderingContent as RenderingBlockGroup[],
      injectedFiles: stashedFirst.injectedFiles,
      injectedFilesAfter: stashedFirst.injectedFilesAfter,
      injectionMode: stashedFirst.injectionMode,
    };
  }

  // Recover original message text from the first rolled-back message,
  // minus any verify-feedback note a previous retry appended to it.
  let recoveredMessage: string | undefined;
  const firstAfter = dropped[0];
  const textContent = firstAfter.content.content as string;
  // Messages from before the remote path stored file bars have no text group
  // and fall through to `content`.
  const remoteText = remote ? userTextOf(stashedRetryContent?.renderingContent) : undefined;
  if (remoteText !== undefined) {
    recoveredMessage = remoteText;
  } else if (textContent) {
    recoveredMessage = stripVerifyFeedbackNote(textContent);
  } else if (stashHasInjectedFiles(stashedRetryContent)) {
    // Inject-only message in a structured mode: the text is legitimately empty
    // and the files live in the stash, so the original is '' (recovered), not
    // unrecoverable.
    recoveredMessage = '';
  } else {
    recoveredMessage = extractToolResultText(firstAfter.content.fullContent) ?? undefined;
  }

  return { pointId, kept, dropped, stashedRetryContent, recoveredMessage };
}

/** Enough of a message id's random part to tell one chat's messages apart. */
const ROLLBACK_TOKEN_LENGTH = 8;

/**
 * The continue token for the chat state right after `messageId`: the start of
 * the id's random part (after the last `_`). `<token>@<minionChatId>`
 * continues the chat from that message.
 */
export function continueTokenFor(messageId: string): string {
  return messageId.slice(messageId.lastIndexOf('_') + 1).slice(0, ROLLBACK_TOKEN_LENGTH);
}

/**
 * The id of the one message `token` marks, or undefined when no message or
 * several do. It is matched against the chat as stored now, so a token from a
 * branch a rollback dropped fails cleanly instead of landing somewhere else.
 */
export function resolveContinueToken(
  token: string,
  messages: Array<{ id: string }>
): string | undefined {
  if (!token) return undefined;
  const matches = messages.filter(m => continueTokenFor(m.id) === token);
  return matches.length === 1 ? matches[0].id : undefined;
}

/**
 * Token for the chat's stored tail, the message a plain continue appends
 * after. Read back from storage because a failed run leaves whatever it saved.
 * Best effort: a failing read drops the token, not the error result.
 */
async function storedTailContinueToken(
  storage: UnifiedStorage,
  minionChatId: string
): Promise<string | undefined> {
  try {
    const tail = (await storage.getMinionMessages(minionChatId)).at(-1);
    return tail && continueTokenFor(tail.id);
  } catch (err) {
    console.debug('[minionTool] no continue token for the failed run of %s:', minionChatId, err);
    return undefined;
  }
}

/**
 * Walk back through stored minion messages to find the most recent assistant
 * message at-or-before `savepoint` that carries a `claudeAgentMessageUuid`.
 * Used to compute the `resumeSessionAt` target when a minion turn fails and the
 * SDK session has to rewind on the next (retry / autoRollback) call. Returns
 * the anchor uuid together with the stamped owning session id (absent on
 * messages written before the stamp existed — the client's send-time fallback
 * resolves those).
 */
export function findPriorAssistantClaudeAgentUuid(
  messages: (ClaudeAgentStampedMessage & { id: string })[],
  savepoint: string | undefined
): ClaudeAgentRewindAnchor | undefined {
  if (!savepoint || savepoint === SAVEPOINT_START) {
    return undefined;
  }
  const savepointIdx = messages.findIndex(m => m.id === savepoint);
  if (savepointIdx < 0) return undefined;
  return findAssistantAnchorAtOrBefore(messages, savepointIdx);
}

/**
 * Write a resolved anchor onto the minion chat row. Mutates in place because
 * every caller saves the row itself after further bookkeeping.
 */
function applyRewindPatch(
  minionChat: MinionChat,
  anchor: ClaudeAgentRewindAnchor | undefined
): void {
  const patch = rewindPatchFromAnchor(anchor);
  minionChat.claudeAgentResumeAt = patch.claudeAgentResumeAt;
  // An unstamped anchor omits the session so the row keeps the one it has;
  // no anchor at all clears it, dropping to a fresh session on the next send.
  if ('claudeAgentSessionId' in patch) {
    minionChat.claudeAgentSessionId = patch.claudeAgentSessionId;
  }
}

/**
 * On a claude-agent minion turn failure, keep the SDK session in sync with the
 * stored-message rollback the caller is about to do: rewind the session to the
 * last assistant turn at-or-before `savepoint` (the last successful turn), or
 * drop the session entirely when there's no prior assistant — a failed first
 * turn, where a fresh session is the clean retry. No-op for non-claude-agent
 * minions, whose whole history lives in the rolled-back stored messages.
 * Shares its anchor arithmetic with the parent chat via
 * `engine/lib/claudeAgentRewind` — the two used to mirror each other by hand.
 */
export async function applyClaudeAgentRewindOnFailure(
  storage: UnifiedStorage,
  minionChat: MinionChat,
  isClaudeAgent: boolean,
  existingMessages: Message<unknown>[],
  newMessages: Message<unknown>[],
  reason: string
): Promise<void> {
  if (!isClaudeAgent) return;
  const anchor = findPriorAssistantClaudeAgentUuid(
    [...existingMessages, ...newMessages],
    minionChat.savepoint
  );
  applyRewindPatch(minionChat, anchor);
  console.debug(
    '[minionTool] claude-agent %s: resumeAt=%s sessionId=%s (savepoint=%s)',
    reason,
    anchor?.uuid ?? '(none — dropped session)',
    minionChat.claudeAgentSessionId ?? '(none)',
    minionChat.savepoint
  );
  await storage.saveMinionChat(minionChat);
}

/**
 * Rollback of a claude-agent minion chat, from the overlay "View Chat" UI
 * (`deleteMessageAndAfter` in GremlinServer) or the tool's own `applyRollback`
 * (retry, autoRollback, a continue token): rewind the SDK session to the last
 * assistant turn at-or-before the kept tail so the next minion send resumes
 * from a state that matches the trimmed message history.
 * `firstDeletedMessageId` is the first message being removed; everything
 * before it is kept. Mirrors `applyClaudeAgentRewindOnFailure`, but the rewind
 * boundary is the rollback cutoff rather than the savepoint — the same "resume
 * up to and including the kept assistant" semantics the parent chat uses in
 * `computeClaudeAgentRewindKeeping`. No-op for non-claude-agent minions, whose
 * whole history lives in the rolled-back stored messages.
 */
export async function applyClaudeAgentRewindOnRollback(
  storage: UnifiedStorage,
  minionChat: MinionChat,
  messages: Message<unknown>[],
  firstDeletedMessageId: string
): Promise<void> {
  if (!minionChat.claudeAgentSessionId) return;
  const cutoffIdx = messages.findIndex(m => m.id === firstDeletedMessageId);
  if (cutoffIdx === -1) return;
  const keptTailId = cutoffIdx > 0 ? messages[cutoffIdx - 1].id : undefined;
  const anchor = findPriorAssistantClaudeAgentUuid(messages, keptTailId);
  applyRewindPatch(minionChat, anchor);
  console.debug(
    '[minionTool] claude-agent rollback: resumeAt=%s sessionId=%s (keptTail=%s)',
    anchor?.uuid ?? '(none — dropped session)',
    minionChat.claudeAgentSessionId ?? '(none)',
    keptTailId
  );
  await storage.saveMinionChat(minionChat);
}

/**
 * Write a planned rollback: subtract the dropped messages' tokens and cost
 * from the chat totals, delete them, rewind a claude-agent session to the kept
 * tail, and leave the savepoint on the rollback point. After a failed
 * claude-agent run `applyClaudeAgentRewindOnFailure` has already rewound to the
 * anchor at-or-before the savepoint; when that savepoint is the rollback point,
 * the rewind here lands on the same anchor.
 */
export async function applyRollback(
  storage: UnifiedStorage,
  minionChat: MinionChat,
  plan: RollbackPlan
): Promise<void> {
  for (const msg of plan.dropped) {
    const meta = msg.metadata;
    if (meta) {
      minionChat.totalInputTokens = Math.max(
        0,
        (minionChat.totalInputTokens ?? 0) - (meta.inputTokens ?? 0)
      );
      minionChat.totalOutputTokens = Math.max(
        0,
        (minionChat.totalOutputTokens ?? 0) - (meta.outputTokens ?? 0)
      );
      minionChat.totalReasoningTokens = Math.max(
        0,
        (minionChat.totalReasoningTokens ?? 0) - (meta.reasoningTokens ?? 0)
      );
      minionChat.totalCacheCreationTokens = Math.max(
        0,
        (minionChat.totalCacheCreationTokens ?? 0) - (meta.cacheCreationTokens ?? 0)
      );
      minionChat.totalCacheReadTokens = Math.max(
        0,
        (minionChat.totalCacheReadTokens ?? 0) - (meta.cacheReadTokens ?? 0)
      );
      minionChat.totalCost = Math.max(0, (minionChat.totalCost ?? 0) - (meta.messageCost ?? 0));
    }
  }

  const firstDroppedId = plan.dropped[0].id;
  if (plan.pointId === SAVEPOINT_START) {
    await storage.deleteMessageAndAfter(minionChat.id, firstDroppedId);
  } else {
    await storage.deleteMessagesAfter(minionChat.id, plan.pointId);
  }
  await applyClaudeAgentRewindOnRollback(
    storage,
    minionChat,
    [...plan.kept, ...plan.dropped],
    firstDroppedId
  );
  minionChat.savepoint = plan.pointId;
  minionChat.lastModifiedAt = new Date();
  await storage.saveMinionChat(minionChat);
}

type ChatTotals = Pick<
  MinionChat,
  | 'totalInputTokens'
  | 'totalOutputTokens'
  | 'totalReasoningTokens'
  | 'totalCacheCreationTokens'
  | 'totalCacheReadTokens'
  | 'totalCost'
  | 'costUnreliable'
>;

/**
 * The chat totals with a run's spend added. They cover every stored message, a
 * failed run's included, because `applyRollback` subtracts whatever it drops.
 */
function chatTotalsWithRun(minionChat: MinionChat, totals: TokenTotals): ChatTotals {
  return {
    totalInputTokens: (minionChat.totalInputTokens ?? 0) + totals.inputTokens,
    totalOutputTokens: (minionChat.totalOutputTokens ?? 0) + totals.outputTokens,
    totalReasoningTokens: (minionChat.totalReasoningTokens ?? 0) + totals.reasoningTokens,
    totalCacheCreationTokens:
      (minionChat.totalCacheCreationTokens ?? 0) + totals.cacheCreationTokens,
    totalCacheReadTokens: (minionChat.totalCacheReadTokens ?? 0) + totals.cacheReadTokens,
    totalCost: (minionChat.totalCost ?? 0) + totals.cost,
    costUnreliable: totals.costUnreliable || minionChat.costUnreliable || undefined,
  };
}

/** Stop reason of a run's last message — `end_turn` unless it's an assistant message that says otherwise. */
function finalStopReason(messages: Message<unknown>[]): string {
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role !== 'assistant') return 'end_turn';
  return (lastMsg.content.stopReason as string) ?? 'end_turn';
}

/**
 * Resolve the effective return mode from tool options, with backward
 * compat for legacy `noReturnTool` / `returnOnly` booleans.
 */
function resolveReturnMode(opts: ToolOptions): string {
  if (typeof opts.returnMode === 'string') return opts.returnMode;
  if (opts.noReturnTool === true) return 'no-return';
  if (opts.returnOnly === true) return 'return-only';
  return 'both';
}

/**
 * Build effective tool list for minion.
 * Formula: (requestedTools ∩ projectTools) - minion + return
 *
 * @param requestedTools - Tools requested by the caller
 * @param projectTools - Tools enabled for the project
 * @returns Final list of tools available to the minion
 */
export function buildMinionTools(
  requestedTools: string[] | undefined,
  projectTools: string[],
  includeReturn: boolean,
  includeMinion = false
): string[] {
  // Start with intersection
  let tools: string[];
  if (requestedTools && requestedTools.length > 0) {
    // Intersect requested with project tools
    const projectToolSet = new Set(projectTools);
    tools = requestedTools.filter(t => projectToolSet.has(t));
  } else {
    // No tools by default — caller must explicitly specify
    tools = [];
  }

  // `minion` is granted authoritatively, not by the model listing it: drop it
  // unconditionally, then re-add it only when the caller granted nesting
  // (`includeMinion`) and it's actually a project tool. This way `allowNesting`
  // alone gives the child the tool, and the model can't sneak nesting in via
  // `enabledTools` without the grant.
  tools = tools.filter(t => t !== 'minion');
  if (includeMinion && projectTools.includes('minion')) {
    tools.push('minion');
  }

  if (includeReturn && !tools.includes('return')) {
    tools.push('return');
  }

  return tools;
}

/**
 * Whether a spawned child should receive the `minion` tool. All three gates
 * must hold: the project allows nesting at all, a grandchild would still be
 * within the depth cap, and the caller granted nesting for this spawn.
 */
export function resolveChildNesting(
  projectAllowNesting: boolean,
  childMayNest: boolean,
  childDepth: number,
  maxNestingDepth: number
): boolean {
  return projectAllowNesting && childMayNest && childDepth + 1 <= maxNestingDepth;
}

/**
 * Validate a spawned minion's persona and its onward delegation grant against
 * the caller's ceiling (the set the caller itself may delegate to). Returns a
 * human-readable reason string when disallowed, or `null` when allowed.
 * A `ceiling` of `undefined` means unrestricted (top-level chat); `'default'`
 * (the no-persona baseline) is always allowed to adopt.
 */
export function checkPersonaDelegation(
  ceiling: string[] | undefined,
  persona: string,
  grant: string[] | undefined
): string | null {
  if (!ceiling) return null;
  if (persona !== 'default' && !ceiling.includes(persona)) {
    return `persona "${persona}" is not in the set this minion may delegate to: [${ceiling.join(', ')}].`;
  }
  if (grant) {
    const outside = grant.filter(p => !ceiling.includes(p));
    if (outside.length > 0) {
      return `cannot grant personas not available to this minion: [${outside.join(', ')}]. Available: [${ceiling.join(', ')}].`;
    }
  }
  return null;
}

/**
 * Build the ToolInfoRenderBlock group for a minion execution.
 * Placed at the start of renderingGroups to show task description and chat reference.
 */
function buildInfoGroup(
  taskMessage: string,
  chatId: string,
  persona?: string,
  displayName?: string,
  apiDefinitionId?: string,
  modelId?: string,
  injectedFiles?: Array<{ path: string; content: string; error?: boolean }>,
  injectedFilesAfter?: Array<{ path: string; content: string; error?: boolean }>
): RenderingBlockGroup {
  const infoBlock: ToolInfoRenderBlock = {
    type: 'tool_info',
    input: taskMessage,
    chatId,
    persona,
    displayName,
    apiDefinitionId,
    modelId,
    injectedFiles,
    injectedFilesAfter,
  };
  return { category: 'backstage', blocks: [infoBlock] };
}

/**
 * The `remote` flag as the caller sent it. LLMs sometimes pass booleans as
 * strings, so 'true'/'false' count too; anything else means "not specified".
 * The executor and `renderMinionInput` both read it through here, so the call
 * block can't say "Remote: human" for a call that ran on an LLM.
 */
export function readRemoteFlag(input: { remote?: unknown }): boolean | undefined {
  if (input.remote === true || input.remote === 'true') return true;
  if (input.remote === false || input.remote === 'false') return false;
  return undefined;
}

/** The `async` flag, with the same string tolerance as `readRemoteFlag`. */
export function readAsyncFlag(input: { async?: unknown }): boolean | undefined {
  if (input.async === true || input.async === 'true') return true;
  if (input.async === false || input.async === 'false') return false;
  return undefined;
}

/** The `remoteToken` param, trimmed. Blank or not a string counts as not passed. */
export function readRemoteToken(input: { remoteToken?: unknown }): string | undefined {
  if (typeof input.remoteToken !== 'string') return undefined;
  return input.remoteToken.trim() || undefined;
}

/**
 * The `outputFormat` param. Anything but 'text' or 'json' counts as not
 * passed, so a stray value neither persists nor hides the chat's stored format.
 */
export function readOutputFormat(input: {
  outputFormat?: unknown;
}): MinionOutputFormat | undefined {
  const format = input.outputFormat;
  return format === 'text' || format === 'json' ? format : undefined;
}

/** Precedence: this call's `outputFormat`, then the chat's, then 'text'. */
export function resolveOutputFormat(
  input: { outputFormat?: unknown },
  minionChat: Pick<MinionChat, 'outputFormat'>
): MinionOutputFormat {
  return readOutputFormat(input) ?? minionChat.outputFormat ?? 'text';
}

/**
 * The `minionChatId` param split on its first `@`: `<continueToken>@<chatId>`,
 * or a bare chat id. Every reader of the param goes through here, so the busy
 * guard, the throttle group and the call display all see the bare id. Not a
 * string, or empty, counts as not passed.
 */
export function parseMinionChatRef(raw: unknown): { chatId?: string; continueToken?: string } {
  if (typeof raw !== 'string' || raw === '') return {};
  const at = raw.indexOf('@');
  if (at === -1) return { chatId: raw };
  const chatId = raw.slice(at + 1);
  const continueToken = raw.slice(0, at);
  return chatId ? { chatId, continueToken } : { continueToken };
}

/**
 * Why a call with a continue token can't run, as far as the input alone tells;
 * undefined when it can. The chat-dependent checks (remote, the token
 * resolving) follow once the chat is loaded.
 */
function checkContinueTokenCall(
  minionInput: MinionInput,
  continueTokensEnabled: boolean,
  chatId: string | undefined
): string | undefined {
  if (!continueTokensEnabled) {
    return 'Continue tokens are not enabled, so minionChatId takes a bare minion chat id without a "<token>@" prefix.';
  }
  if (!chatId) {
    return 'A continue token needs the minion chat id after the "@": "<continueToken>@<minionChatId>".';
  }
  if (minionInput.action === 'retry') {
    return 'action "retry" cannot be combined with a continue token, which already picks the point to send from. Drop one of them.';
  }
  // Even with autoRollback on: a token means "send something new from here",
  // so there is no rolled-back message to recover.
  if (!minionInput.message && !hasInjectSpecs(minionInput)) {
    return '"message" (or injectFiles / injectFilesAfter) is required with a continue token: it sends something new from that point.';
  }
  return undefined;
}

export function isRemoteCall(input: { remote?: unknown }): boolean {
  return readRemoteFlag(input) === true;
}

/** Default total remote timeout (10 minutes) */
const REMOTE_DEFAULT_TIMEOUT_MS = 600_000;
/** Same floor as the option's `min`: the settings form isn't the only writer of tool options. */
const REMOTE_MIN_TIMEOUT_MS = 10_000;
/** The backend contract's ceiling for `timeoutMs` (7 days). */
const REMOTE_MAX_TIMEOUT_MS = 604_800_000;
/** Remote errors carry setup hints (CORS, endpoint shape), so they get more room than truncateError's default. */
const REMOTE_ERROR_LIMIT = 600;

export function resolveRemoteTimeoutMs(opts: ToolOptions): number {
  const configured =
    typeof opts.remoteTimeoutMs === 'number' && Number.isFinite(opts.remoteTimeoutMs)
      ? opts.remoteTimeoutMs
      : REMOTE_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(configured, REMOTE_MIN_TIMEOUT_MS), REMOTE_MAX_TIMEOUT_MS);
}

/** "10 minutes", "1.5 minutes", "30 seconds" */
function formatWaitDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`;
  const minutes = Number((ms / 60_000).toFixed(1));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function isRemoteConfigured(opts: ToolOptions): boolean {
  return typeof opts.remoteEndpoint === 'string' && opts.remoteEndpoint.trim() !== '';
}

interface RemoteConfig {
  endpoint: string;
  password: string;
}

/**
 * Check a call that routes to a human against the tool options. Returns the
 * backend config, or a sentence saying why the call can't go remote.
 */
function resolveRemoteConfig(
  minionInput: MinionInput,
  opts: ToolOptions
): { config: RemoteConfig } | { problem: string } {
  // A verify hook is a safety check. Skipping it for a human answer would let
  // the savepoint advance on output nobody verified.
  if (minionInput.verifyHook) {
    return {
      problem:
        'verifyHook cannot be used with a remote (human) minion. Drop verifyHook and resend.',
    };
  }
  const endpoint = normalizeTouchGrassEndpoint(
    typeof opts.remoteEndpoint === 'string' ? opts.remoteEndpoint : ''
  );
  if (!endpoint) {
    return {
      problem:
        'No Remote Minion Endpoint is configured in the minion tool options; ask the user to set it.',
    };
  }
  const invalid = validateTouchGrassEndpoint(endpoint);
  if (invalid) return { problem: `${invalid} Ask the user to fix it in the minion tool options.` };
  const password = typeof opts.remotePassword === 'string' ? opts.remotePassword : '';
  if (!password) {
    return {
      problem:
        'No Remote Minion Password is configured in the minion tool options; ask the user to set it.',
    };
  }
  return { config: { endpoint, password } };
}

/** UI label for a minion call: its displayName, else a non-default persona when personas are on. */
function minionPersonaLabel(minionChat: MinionChat, toolOptions: ToolOptions): string | undefined {
  return (
    minionChat.displayName ??
    (toolOptions.namespacedMinion !== 'off' &&
    minionChat.persona &&
    minionChat.persona !== 'default'
      ? minionChat.persona
      : undefined)
  );
}

type InjectedEntry = {
  path: string;
  content: string;
  preamble?: string;
  postamble?: string;
  error?: boolean;
};

/** Injected files read for one call, as entries and as inline text. */
interface InjectedFileBatches {
  /** Whether the content carries line numbers */
  withLineNumbers: boolean;
  /** `' with line numbers'` when the content carries them (part of the default framing) */
  label: string;
  /** `injectFiles`: lands before the message */
  before: InjectedEntry[];
  /** `injectFilesAfter`: lands after the message */
  after: InjectedEntry[];
  /** Inline text of `before`, for buildInlineContent */
  prefix: string;
  /** `=== end of files ===` when any leading file uses the default framing */
  endMarker: string;
  /** Inline text of `after`, for buildInlineContent */
  suffix: string;
}

/**
 * Whether injected file content carries line numbers: the call's
 * fileLineNumbers override, else the one persisted on the minion chat, else
 * the project default.
 */
function injectedFilesWithLineNumbers(
  minionInput: MinionInput,
  minionChat: MinionChat,
  projectNoLineNumbers: boolean | undefined
): boolean {
  return minionInput.fileLineNumbers ?? minionChat.fileLineNumbers ?? !projectNoLineNumbers;
}

/** Default-framing label for injected files that carry line numbers. */
const LINE_NUMBERS_LABEL = ' with line numbers';

/**
 * The line-number choice a retry stash's files were read with, so a re-send
 * frames them as before even if the setting changed since. Each file bar holds
 * `buildInlineSection(entry, label)` byte for byte (the invariant
 * `extractCarriedInjection` relies on too), so the label that reproduces a
 * default-framed bar is the original one. Undefined when every file is
 * custom-framed: the label then appears nowhere.
 */
function stashedFilesWithLineNumbers(stash: StashedRetryContent): boolean | undefined {
  const { before, after } = splitInjectedFileBlocks(stash.renderingContent);
  const bars = [...before, ...after];
  const entries = [...(stash.injectedFiles ?? []), ...(stash.injectedFilesAfter ?? [])];
  const idx = entries.findIndex(f => !hasCustomFraming(f));
  if (idx === -1 || !bars[idx]) return undefined;
  return bars[idx].content === buildInlineSection(entries[idx], LINE_NUMBERS_LABEL);
}

/** Batches with their inline text, from entries already formatted for the reader. */
function assembleInjectedBatches(
  withLineNumbers: boolean,
  before: InjectedEntry[],
  after: InjectedEntry[]
): InjectedFileBatches {
  const label = withLineNumbers ? LINE_NUMBERS_LABEL : '';
  // A failed read fails the whole call, so error entries never reach the text.
  const inlineSections = (entries: InjectedEntry[]) =>
    entries
      .filter(f => !f.error)
      .map(f => buildInlineSection(f, label))
      .join('\n\n');
  return {
    withLineNumbers,
    label,
    before,
    after,
    prefix: before.length > 0 ? inlineSections(before) + '\n\n' : '',
    // Custom-framed files delimit themselves; the meta end marker is only
    // needed when at least one file carries the default `=== path ===` framing.
    endMarker: before.some(f => !f.error && !hasCustomFraming(f)) ? '=== end of files ===\n\n' : '',
    // No end marker: nothing follows the trailing batch.
    suffix: after.length > 0 ? '\n\n' + inlineSections(after) : '',
  };
}

/**
 * Read `injectFiles` / `injectFilesAfter` from the VFS, formatted the way the
 * minion (LLM or human) gets them: line numbers per the effective setting,
 * display paths relative to the persona's namespace. Any failed read fails the
 * call before anything is sent.
 */
async function readInjectedFiles(
  minionInput: MinionInput,
  minionChat: MinionChat,
  toolOptions: ToolOptions,
  projectNoLineNumbers: boolean | undefined,
  createVfsAdapter: ToolContext['createVfsAdapter']
): Promise<{ files: InjectedFileBatches } | { failure: ToolResult }> {
  const withLineNumbers = injectedFilesWithLineNumbers(
    minionInput,
    minionChat,
    projectNoLineNumbers
  );
  if (!hasInjectSpecs(minionInput)) {
    return { files: assembleInjectedBatches(withLineNumbers, [], []) };
  }

  // Compute namespace prefix so display paths can be relative to the minion's root
  const nsMode = toolOptions.namespacedMinion ?? 'off';
  const persona = minionInput.persona ?? minionChat.persona ?? 'default';
  const shouldNs = nsMode !== 'off' && (nsMode === 'all' || persona !== 'default');
  const injectNsPrefix = shouldNs ? personaNamespace(persona) : undefined;
  const rootAdapter = createVfsAdapter();

  const readInjectBatch = async (specs: Array<string | InjectFileSpec> | undefined) => {
    const entries: InjectedEntry[] = [];
    for (const specOrPath of specs ?? []) {
      const spec: InjectFileSpec =
        typeof specOrPath === 'string' ? { path: specOrPath } : specOrPath;
      const displayPath = stripNsPrefix(spec.path, injectNsPrefix);
      try {
        const fileContent = await rootAdapter.readFile(spec.path);
        entries.push({
          path: displayPath,
          content: withLineNumbers ? formatFileWithLineNumbers(fileContent) : fileContent,
          preamble: spec.preamble,
          postamble: spec.postamble,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        entries.push({ path: spec.path, content: errMsg, error: true });
      }
    }
    return entries;
  };

  const files = assembleInjectedBatches(
    withLineNumbers,
    await readInjectBatch(minionInput.injectFiles),
    await readInjectBatch(minionInput.injectFilesAfter)
  );
  const failedFiles = [...files.before, ...files.after].filter(f => f.error);
  if (failedFiles.length > 0) {
    const paths = failedFiles.map(f => `${f.path}: ${f.content}`).join('\n');
    return {
      failure: {
        content: truncateError(
          `Error: Failed to read injected file(s):\n${paths}\nFix the paths and resend.`
        ),
        isError: true,
      },
    };
  }
  return { files };
}

/** tool_info entries for one batch; undefined when it's empty */
function toInfoFileEntries(entries: InjectedEntry[], label: string) {
  return entries.length > 0 ? entries.map(f => toInfoFileEntry(f, label)) : undefined;
}

/**
 * Rendering for a minion user message: leading file bars, the message text,
 * trailing file bars.
 */
function buildUserMessageGroups(
  files: InjectedFileBatches,
  messageText: string
): RenderingBlockGroup[] {
  const groups: RenderingBlockGroup[] = [];
  if (files.before.length > 0) {
    groups.push({
      category: 'backstage',
      blocks: files.before.map(f => toInjectedFileBlock(f, files.label)),
    });
  }
  // The text group is the split point between leading and trailing file
  // bars in the chat mirror, so an inject-only call still emits it — empty.
  groups.push({
    category: 'text',
    blocks: messageText === '' ? [] : [{ type: 'text', text: messageText }],
  });
  if (files.after.length > 0) {
    groups.push({
      category: 'backstage',
      blocks: files.after.map(f => toInjectedFileBlock(f, files.label)),
    });
  }
  return groups;
}

interface MinionResultFields {
  returnMode: string;
  /** Ignored in 'both' mode, whose result is always its own JSON */
  outputFormat: MinionOutputFormat;
  minionChatId: string;
  stopReason: string;
  hasCoT: boolean;
  /** Assistant prose of the run, '' when there was none */
  text: string;
  /** What the minion handed back as its result; undefined when the return tool wasn't called */
  returnValue: string | undefined;
  /** A human answered through the remote backend */
  remote?: boolean;
  /** Marks the chat state right after this result (the `continueTokens` option) */
  continueToken?: string;
}

const RETURN_NOT_CALLED_WARNING = 'Return tool was not called';

/**
 * The tool result text the calling LLM reads. 'both' mode gets JSON with text
 * and result side by side. Every other mode carries one body: the return
 * value, a warning that it's missing (enforced modes), or else the prose.
 * `outputFormat` 'text' writes the `<minionChatId>` tag, an optional
 * `<continueToken>` tag, optional `<hasCoT />` / `<remote />` marker lines,
 * then the body; 'json' writes the same facts under the keys 'both' uses
 * (`result`, `text`) plus `warning`. `parseSimplifiedOutput` reads the tag
 * shape back; `renderMinionOutput` renders all three.
 */
export function formatMinionResult(fields: MinionResultFields): string {
  const {
    returnMode,
    outputFormat,
    minionChatId,
    stopReason,
    hasCoT,
    text,
    returnValue,
    remote,
    continueToken,
  } = fields;
  const tokenField = continueToken !== undefined ? { continueToken } : {};
  if (returnMode === 'both') {
    const resultJson: Record<string, unknown> = {
      stopReason,
      hasCoT,
      minionChatId,
      ...tokenField,
      text,
    };
    if (returnValue !== undefined) resultJson.result = returnValue;
    if (remote) resultJson.remote = true;
    return JSON.stringify(resultJson);
  }
  const missingReturn =
    returnValue === undefined && (returnMode === 'enforced' || returnMode === 'auto-enforced');
  if (outputFormat === 'json') {
    const resultJson: Record<string, unknown> = {
      minionChatId,
      ...tokenField,
      stopReason,
      hasCoT,
    };
    if (remote) resultJson.remote = true;
    if (missingReturn) resultJson.warning = RETURN_NOT_CALLED_WARNING;
    else if (returnValue !== undefined) resultJson.result = returnValue;
    else resultJson.text = text;
    return JSON.stringify(resultJson);
  }
  let body: string;
  if (missingReturn) {
    body = `Warning: ${RETURN_NOT_CALLED_WARNING}`;
  } else if (returnValue !== undefined) {
    body = returnValue;
  } else {
    // no-return mode, or return-only fallback when return wasn't called
    body = text;
  }
  const tokenLine =
    continueToken !== undefined ? `<continueToken>${continueToken}</continueToken>\n` : '';
  const markers = (hasCoT ? '<hasCoT />\n' : '') + (remote ? '<remote />\n' : '');
  return `<minionChatId>${minionChatId}</minionChatId>\n${tokenLine}${markers}${body}`;
}

interface MinionErrorFields {
  /** Untruncated error text; the formatter truncates it */
  error: string;
  minionChatId: string;
  outputFormat: MinionOutputFormat;
  continueToken?: string;
}

/**
 * The tool result text for an LLM run that failed after its message was saved.
 * The chat id comes along so the caller can retry it, which matters most for a
 * new chat whose first run failed: its id appears nowhere else. Text puts the
 * truncated error first and the tags after, outside the truncation.
 */
export function formatMinionError(fields: MinionErrorFields): string {
  const { minionChatId, outputFormat, continueToken } = fields;
  const error = truncateError(fields.error);
  if (outputFormat === 'json') {
    return JSON.stringify({
      error,
      minionChatId,
      ...(continueToken !== undefined && { continueToken }),
    });
  }
  const tokenLine =
    continueToken !== undefined ? `\n<continueToken>${continueToken}</continueToken>` : '';
  return `${error}\n<minionChatId>${minionChatId}</minionChatId>${tokenLine}`;
}

/** How long Stop waits for the cancel to report an answer that beat it. */
const ABORT_CANCEL_WAIT_MS = 1_000;

/** `promise`'s value, or undefined once `ms` pass first. `promise` must not reject. */
function withinMs<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

/** The human's answer when it beat the cancel, else undefined. */
function answerThatBeatCancel(cancelled: CancelOutcome | undefined): string | undefined {
  return cancelled && 'state' in cancelled && cancelled.state.status === 'answered'
    ? cancelled.state.response.content
    : undefined;
}

/** What the calling LLM gets back for an async note. */
const ASYNC_SENT_RESULT = 'Message sent.';

/** Told to the human when the backend no longer has the session their earlier messages lived in. */
const REMOTE_LOST_CONTEXT_NOTE =
  '[The earlier messages of this conversation were lost on the backend, so this one starts a new session.]';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Why a question ended without an answer, for the calling LLM. */
function describeUnanswered(
  outcome: Exclude<WaitOutcome, { status: 'answered' }>,
  timeoutMs: number
): string {
  if (outcome.status === 'timeout' || outcome.reason === 'timeout') {
    const lastError =
      outcome.status === 'timeout' && outcome.lastError
        ? ` The backend was failing at the end: ${outcome.lastError}`
        : '';
    return `Remote minion: no human answer within ${formatWaitDuration(timeoutMs)}; the question was withdrawn.${lastError}`;
  }
  switch (outcome.reason) {
    case 'cancelled':
      return 'Remote minion: the question was cancelled on the backend before a human answered.';
    case 'superseded':
      return 'Remote minion: a newer message on the same remote session replaced the question before a human answered.';
    case undefined:
      // v1 backends expire without saying why.
      return 'Remote minion: the question expired on the backend before a human answered.';
  }
}

/**
 * Execute a call on a remote (human) minion chat.
 *
 * Creates or reuses a Touch Grass session, posts the message with injected
 * files as structured data, then long-polls until the human answers, the
 * question expires, `remoteTimeoutMs` passes, or the user hits Stop. Whenever
 * we stop waiting on a question that may still be open, it is cancelled on the
 * backend so the human can't answer into the void.
 *
 * `retryStash` is set on a true retry: without fresh inject specs, the files
 * the original question carried are re-sent from it rather than re-read.
 *
 * `rollback` is the retry / autoRollback planned in Phase 1. It is written
 * once the post goes through, right before the user message is saved, so a
 * failed file read, session setup or post (Stop included) leaves the chat as it
 * was and the next retry finds the question again.
 *
 * `hasHistory` says the chat has saved messages once that rollback lands. Only
 * a post to a session leaves one, and the session id is dropped only when the
 * backend reports the session gone, so a chat with history but no session lost
 * it on the backend. The human is told so when a new one opens.
 */
async function* executeRemoteMinion(
  minionInput: MinionInput,
  minionChat: MinionChat,
  messageText: string,
  toolOptions: ToolOptions,
  remote: RemoteConfig,
  retryStash: StashedRetryContent | undefined,
  rollback: RollbackPlan | undefined,
  hasHistory: boolean,
  context: ToolContext
): AsyncGenerator<ToolStreamEvent, ToolResult, void> {
  const storage = context.storage;
  const signal = context.signal;
  const asyncNote = readAsyncFlag(minionInput) === true;
  const outputFormat = resolveOutputFormat(minionInput, minionChat);

  const project = await storage.getProject(context.projectId);
  if (!project) {
    return {
      content: truncateError(
        `Error: Project not found: ${context.projectId}. Resend to reattempt.`
      ),
      isError: true,
    };
  }
  const injected =
    retryStash && stashHasInjectedFiles(retryStash) && !hasInjectSpecs(minionInput)
      ? {
          files: assembleInjectedBatches(
            stashedFilesWithLineNumbers(retryStash) ??
              injectedFilesWithLineNumbers(minionInput, minionChat, project.noLineNumbers),
            retryStash.injectedFiles ?? [],
            retryStash.injectedFilesAfter ?? []
          ),
        }
      : await readInjectedFiles(
          minionInput,
          minionChat,
          toolOptions,
          project.noLineNumbers,
          context.createVfsAdapter
        );
  if ('failure' in injected) return injected.failure;
  const { files } = injected;

  const infoGroup = buildInfoGroup(
    messageText,
    minionChat.id,
    minionPersonaLabel(minionChat, toolOptions),
    minionChat.displayName,
    undefined,
    undefined,
    toInfoFileEntries(files.before, files.label),
    toInfoFileEntries(files.after, files.label)
  );
  const followUp = `To ask again, call minion with minionChatId "${minionChat.id}".`;
  const remoteError = (detail: string): ToolResult => ({
    content: `${truncateError(detail, REMOTE_ERROR_LIMIT)} ${followUp}`,
    isError: true,
    renderingGroups: [infoGroup],
  });
  // Stop can land after the question was posted and saved, so it names the chat too.
  const abortedResult: ToolResult = {
    content: `Minion was aborted. ${followUp}`,
    isError: true,
    renderingGroups: [infoGroup],
  };

  // `openSession` covers the first create and the re-create after the backend
  // lost the session, so both route to the chat's inbox.
  const client = new TouchGrassClient({ ...remote, userToken: minionChat.remoteToken });
  const timeoutMs = resolveRemoteTimeoutMs(toolOptions);
  const deadline = Date.now() + timeoutMs;

  // Files travel as structured data only. Custom preamble/postamble rides in
  // the content: it is part of what the caller wanted the reader to see.
  const toRemoteFile = (f: InjectedEntry, placement: 'before' | 'after'): RemoteInjectedFile => ({
    path: f.path,
    content: wrapInjectedFile(f),
    placement,
    ...(files.withLineNumbers && { lineNumbers: true }),
  });
  const remoteFiles = [
    ...files.before.map(f => toRemoteFile(f, 'before')),
    ...files.after.map(f => toRemoteFile(f, 'after')),
  ];
  const persona =
    minionChat.persona && minionChat.persona !== 'default' ? minionChat.persona : undefined;
  const sessionLabel = `${project.name} · ${minionChat.displayName ?? persona ?? 'minion'}`.slice(
    0,
    200
  );
  // Setup requests retry briefly: a backend restart blip is worth riding out,
  // a CORS or address mistake should surface its hint within seconds.
  const setupRetry = { maxRetries: 2, deadline, signal };

  const openSession = async (): Promise<string> => {
    const sessionId = await withRetry(() => client.createSession(sessionLabel, signal), setupRetry);
    minionChat.remoteSessionId = sessionId;
    minionChat.lastModifiedAt = new Date();
    await storage.saveMinionChat(minionChat);
    return sessionId;
  };
  const fileFields = remoteFiles.length > 0 ? { files: remoteFiles } : {};
  // The backend closes the question at our deadline, so the human sees when it
  // stops being answerable.
  const postQuestion = (sessionId: string, content: string) =>
    postMessageWithRetry(client, sessionId, { content, ...fileFields }, setupRetry);
  const postNote = (sessionId: string, content: string) =>
    postMessageWithRetry(
      client,
      sessionId,
      { content, ...fileFields, awaitReply: false },
      setupRetry
    );

  /** Posts to the chat's session, opening one first when it has none. */
  const postToSession = async <T>(
    post: (sessionId: string, content: string) => Promise<T>
  ): Promise<{ sessionId: string; posted: T }> => {
    const knownSessionId = minionChat.remoteSessionId;
    let contextLost = hasHistory;
    if (knownSessionId) {
      try {
        return { sessionId: knownSessionId, posted: await post(knownSessionId, messageText) };
      } catch (err) {
        // The backend lost the session (deleted, DB wiped, retention). Start a
        // new one, once, and tell the human what they're missing. Any other
        // 404 is a wrong endpoint: the session may be alive behind it, so the
        // chat keeps it.
        if (!isSessionGone(err)) throw err;
        console.debug('[minionTool] remote session %s is gone, opening a new one', knownSessionId);
      }
      // Forgotten before the re-create: when that fails (the token's user was
      // deleted), the next call may bring a corrected remoteToken, which Phase 1
      // only takes on a chat without a session.
      minionChat.remoteSessionId = undefined;
      minionChat.lastModifiedAt = new Date();
      await storage.saveMinionChat(minionChat);
      contextLost = true;
    }
    const sessionId = await openSession();
    let content = messageText;
    if (contextLost) {
      content = messageText
        ? `${REMOTE_LOST_CONTEXT_NOTE}\n\n${messageText}`
        : REMOTE_LOST_CONTEXT_NOTE;
    }
    return { sessionId, posted: await post(sessionId, content) };
  };
  const postFailed = (err: unknown): ToolResult =>
    isTouchGrassAbort(err)
      ? abortedResult
      : remoteError(
          `Error: posting the ${asyncNote ? 'message' : 'question'} to the remote backend failed. ${errorText(err)}`
        );

  // The local transcript keeps the inline text an LLM reading this chat would
  // need (a clone into a regular chat keeps the files), plus the file bars.
  // The files are stored as entries too, so a retry can re-send them the way
  // the human got them. No `injectionMode`: API clients only build blocks from
  // the entries when one is set, so a clone reads the inline text alone.
  const saveUserMessage = async (): Promise<Message<string>> => {
    const userMessage: Message<string> = {
      id: generateUniqueId('msg_user'),
      role: 'user',
      content: {
        type: 'text',
        content: buildInlineContent(files.prefix, files.endMarker, messageText, files.suffix),
        renderingContent: buildUserMessageGroups(files, messageText),
        ...(files.before.length > 0 && { injectedFiles: files.before.map(toStoredInjectedFile) }),
        ...(files.after.length > 0 && {
          injectedFilesAfter: files.after.map(toStoredInjectedFile),
        }),
      },
      timestamp: new Date(),
    };
    await storage.saveMinionMessage(minionChat.id, userMessage);
    return userMessage;
  };

  // Runs once the post went through, before the user message is saved: the
  // rollback can't delete it then, and a failed post took nothing back. The
  // chat is saved either way, so what this call merged (outputFormat, the
  // display name, ...) persists even when no answer comes back.
  const settleChat = async (): Promise<void> => {
    if (rollback) await applyRollback(storage, minionChat, rollback);
    else await storage.saveMinionChat(minionChat);
  };

  if (asyncNote) {
    let note: PostedMessage;
    try {
      ({ posted: note } = await postToSession(postNote));
    } catch (err) {
      return postFailed(err);
    }
    await settleChat();
    const userMessage = await saveUserMessage();
    // No answer comes back, so the note is a finished exchange on its own: a
    // retry or autoRollback must not take it back.
    minionChat.savepoint = userMessage.id;
    minionChat.lastModifiedAt = new Date();
    await storage.saveMinionChat(minionChat);
    if (note.requestId !== null) {
      // A 2.0 backend ignored awaitReply and asked the human a question; withdraw it.
      const cancelling = client.cancel(note.requestId);
      if (!(await withinMs(cancelling, ABORT_CANCEL_WAIT_MS))?.reached) {
        void retryCancelInBackground(client, note.requestId, cancelling, deadline);
      }
    }
    return {
      content: formatMinionResult({
        returnMode: resolveReturnMode(toolOptions),
        outputFormat,
        minionChatId: minionChat.id,
        stopReason: 'end_turn',
        hasCoT: false,
        text: '',
        // Not `remote`: the result is ours, not a human's answer.
        returnValue: ASYNC_SENT_RESULT,
      }),
      renderingGroups: [infoGroup],
    };
  }

  let sessionId: string;
  let posted: PendingRequestRef;
  try {
    ({ sessionId, posted } = await postToSession(postQuestion));
  } catch (err) {
    return postFailed(err);
  }
  await settleChat();
  await saveUserMessage();

  // One init carries the whole waiting state: nothing changes until the human
  // answers, and delta encoding makes re-yielding identical snapshots wasteful.
  const waitingBlock: ToolResultRenderBlock = {
    type: 'tool_result',
    name: 'minion',
    tool_use_id: '',
    icon: '⏳',
    status: 'running',
    content: [
      'Waiting for a human answer.',
      `Answer at: ${client.sessionUrl(sessionId)}`,
      `Deadline: ${posted.expiresAt ?? new Date(deadline).toISOString()}`,
    ].join('\n'),
  };
  yield {
    type: 'groups_delta',
    delta: {
      kind: 'init',
      infoGroup,
      accumulatedGroups: [],
      streamingGroups: [{ category: 'backstage', blocks: [waitingBlock] }],
    },
  };

  // Runs while the busy guard is held, like every other write of this call.
  const saveAnswer = async (content: string): Promise<RenderingBlockGroup> => {
    const answerGroup: RenderingBlockGroup = {
      category: 'text',
      blocks: [{ type: 'text', text: content }],
    };
    const humanMessage: Message<string> = {
      id: generateUniqueId('msg_asst'),
      role: 'assistant',
      content: { type: 'text', content, renderingContent: [answerGroup] },
      timestamp: new Date(),
    };
    await storage.saveMinionMessage(minionChat.id, humanMessage);
    minionChat.savepoint = humanMessage.id;
    minionChat.lastModifiedAt = new Date();
    await storage.saveMinionChat(minionChat);
    return answerGroup;
  };

  let outcome: WaitOutcome;
  try {
    outcome = await waitForAnswer(client, posted.requestId, { deadline, signal });
  } catch (err) {
    if (isTouchGrassAbort(err)) {
      // Stop must unblock the parent promptly, so the cancel gets a short
      // window to report an answer that won the race. A cancel that is slower,
      // or can't reach the backend, carries on in the background until it
      // gets through or the deadline closes the question anyway. That never
      // touches storage: the guard is released by then.
      const cancelling = client.cancel(posted.requestId);
      const cancelled = await withinMs(cancelling, ABORT_CANCEL_WAIT_MS);
      if (!cancelled?.reached) {
        void retryCancelInBackground(client, posted.requestId, cancelling, deadline);
      }
      const answer = answerThatBeatCancel(cancelled);
      if (answer === undefined) return abortedResult;
      const answerGroup = await saveAnswer(answer);
      return {
        content: `Minion was aborted, but the human had already answered. The exchange is saved in minionChatId "${minionChat.id}". Their answer:\n${answer}`,
        isError: true,
        renderingGroups: [infoGroup, { ...answerGroup, isToolGenerated: true }],
      };
    }
    // The request goes with its session: nothing left to cancel, and the next
    // post 404s too, which opens a new session.
    if (err instanceof TouchGrassError && err.status === 404) {
      return {
        content: `Remote minion: the question is gone from the backend — the human deleted this conversation, or the backend lost its data. A follow-up with minionChatId "${minionChat.id}" starts a new session.`,
        isError: true,
        renderingGroups: [infoGroup],
      };
    }
    // Cancel, and take the answer if the human beat us to it.
    const answer = answerThatBeatCancel(await client.cancel(posted.requestId));
    if (answer === undefined) {
      return remoteError(`Error: waiting for the human answer failed. ${errorText(err)}`);
    }
    outcome = { status: 'answered', content: answer };
  }
  if (outcome.status === 'timeout') {
    const answer = answerThatBeatCancel(await client.cancel(posted.requestId));
    if (answer !== undefined) outcome = { status: 'answered', content: answer };
  }
  if (outcome.status !== 'answered') {
    return remoteError(describeUnanswered(outcome, timeoutMs));
  }

  const answerGroup = await saveAnswer(outcome.content);

  return {
    content: formatMinionResult({
      returnMode: resolveReturnMode(toolOptions),
      outputFormat,
      minionChatId: minionChat.id,
      stopReason: 'end_turn',
      hasCoT: false,
      text: '',
      // The answer is the deliberate final value of the exchange, so it fills
      // the return slot in every mode: 'return-only' / 'enforced' never warn
      // that a person "didn't call the return tool", and 'both' carries it as
      // `result`, the field the output renderer shows.
      returnValue: outcome.content,
      remote: true,
    }),
    renderingGroups: [infoGroup, { ...answerGroup, isToolGenerated: true }],
  };
}

/**
 * Execute the minion tool as an async generator.
 *
 * Busy-guard wrapper: two callers driving the same minion chat concurrently
 * would interleave the lazy savepoint rollback with the other's appends (and
 * race the claude-agent session bookkeeping), so a chat id is exclusively held
 * for the duration of a call. Newly created chats need no guard — their id
 * isn't visible to other callers until this call returns it.
 */
async function* executeMinion(
  input: Record<string, unknown>,
  toolOptions?: ToolOptions,
  context?: ToolContext
): AsyncGenerator<ToolStreamEvent, ToolResult, void> {
  // The bare id: a `<token>@<id>` call must collide with a plain one on the same chat.
  const guardChatId = parseMinionChatRef(input.minionChatId).chatId;
  const registry = context?.loopRegistry;
  if (registry && guardChatId) {
    if (!registry.acquireMinionChat(guardChatId)) {
      return {
        content: truncateError(
          `Error: Minion chat ${guardChatId} is busy with another request. Wait for it to finish and resend.`
        ),
        isError: true,
      };
    }
  }
  try {
    return yield* executeMinionInner(input, toolOptions, context);
  } finally {
    if (registry && guardChatId) registry.releaseMinionChat(guardChatId);
  }
}

/**
 * Creates or continues a minion chat, runs an agentic loop with scoped tools,
 * yields groups_delta events for real-time streaming, and returns the final
 * result with renderingGroups for nested display.
 */
async function* executeMinionInner(
  input: Record<string, unknown>,
  toolOptions?: ToolOptions,
  context?: ToolContext
): AsyncGenerator<ToolStreamEvent, ToolResult, void> {
  const minionInput = input as unknown as MinionInput;
  const action = minionInput.action ?? 'message';

  // Stashed fullContent from a rolled-back tool_result message for re-use during retry.
  // When the stashed modelFamily matches the current apiDef.apiType, we can re-use the
  // original fullContent directly instead of reconstructing from extracted text.
  // Only valid when this send is a true retry of the recovered original message —
  // a different message must build fresh content (reusing the old fullContent would
  // send the rolled-back text to the model, since fullContent is canon; reusing
  // renderingContent would render the old text in the chat mirror).
  let stashedRetryContent: StashedRetryContent | undefined;
  // Whether this send re-attempts the exact message that was rolled back (as opposed
  // to a new message arriving after a failed turn). Gates stash reuse above and the
  // verify-feedback note below.
  let isTrueRetry = false;
  // Retry, autoRollback and continue tokens are planned in Phase 1 and written
  // right before this call's message is, so an error on the way there leaves
  // the chat as it was.
  let pendingRollback: RollbackPlan | undefined;
  // The message a continue token resolved to. It becomes the savepoint even
  // when nothing follows it, so a retry of this call returns there.
  let rollbackPointId: string | undefined;

  // ── Phase 1: Validate inputs + load/create chat ──
  // Errors here indicate no state change; caller can resend to reattempt.

  const minionToolOptions = toolOptions ?? {};
  const autoRollbackEnabled = toolOptions?.autoRollback === true;
  const verifyFeedbackEnabled = toolOptions?.verifyFeedback === true;
  const continueTokensEnabled = toolOptions?.continueTokens === true;
  const { chatId: requestedChatId, continueToken } = parseMinionChatRef(minionInput.minionChatId);
  const continueTokenProblem =
    continueToken !== undefined
      ? checkContinueTokenCall(minionInput, continueTokensEnabled, requestedChatId)
      : undefined;
  if (continueTokenProblem) {
    return {
      content: truncateError(`Error: ${continueTokenProblem} Resend to reattempt.`),
      isError: true,
    };
  }
  if (
    action === 'message' &&
    !minionInput.message &&
    !hasInjectSpecs(minionInput) &&
    !autoRollbackEnabled
  ) {
    return {
      content: truncateError(
        'Error: "message" is required when action is "message" (or omitted) and no injectFiles / injectFilesAfter are given. Resend to reattempt.'
      ),
      isError: true,
    };
  }
  if (action === 'retry' && !requestedChatId) {
    return {
      content: truncateError(
        'Error: "minionChatId" is required when action is "retry". Resend to reattempt.'
      ),
      isError: true,
    };
  }

  if (!context?.projectId) {
    return {
      content: truncateError('Error: projectId is required in context. Resend to reattempt.'),
      isError: true,
    };
  }

  // ── Nested-minion depth guard ──
  // `context.minionDepth` is the depth of the loop that called this minion
  // (0/undefined for a top-level chat); the child we are about to spawn runs
  // one level deeper. Hard-cap to avoid runaway recursion, before any chat is
  // created so an over-cap call has no side effects. Nesting is gated off by
  // default — children never receive the `minion` tool unless `allowNesting`
  // is on (see buildMinionTools call below), so this only fires defensively.
  const callerDepth = context.minionDepth ?? 0;
  const childDepth = callerDepth + 1;
  const maxNestingDepth =
    typeof toolOptions?.maxNestingDepth === 'number' && toolOptions.maxNestingDepth >= 1
      ? toolOptions.maxNestingDepth
      : DEFAULT_MAX_NESTING_DEPTH;
  if (childDepth > maxNestingDepth) {
    return {
      content: truncateError(
        `Error: max minion nesting depth (${maxNestingDepth}) reached. This minion cannot spawn another minion.`
      ),
      isError: true,
    };
  }

  // Bind injected backend deps locally so the helper functions and the main
  // body can read storage / api / tool registry without reaching for module
  // singletons. The agentic loop's `ToolContext` construction site always
  // populates these from `options.deps`.
  const storage = context.storage;
  const apiService = context.apiService;
  const toolRegistry = context.toolRegistry;

  // Load or create minion chat + handle retry rollback
  let minionChat: MinionChat;
  let existingMessages: Message<unknown>[] = [];
  // Set when this call goes to a human. Remote is a property of the chat,
  // decided at creation; the call's `remote` flag only has to agree with it.
  let remoteConfig: RemoteConfig | undefined;
  const remoteFlag = readRemoteFlag(minionInput);
  const asyncFlag = readAsyncFlag(minionInput) === true;
  const remoteToken = readRemoteToken(minionInput);
  const requestedOutputFormat = readOutputFormat(minionInput);
  if (asyncFlag && !requestedChatId && remoteFlag !== true) {
    return {
      content:
        'Error: async=true only works with remote (human) minions. Start the chat with remote=true, or drop async and resend.',
      isError: true,
    };
  }
  if (remoteToken && !requestedChatId && remoteFlag !== true) {
    return {
      content: truncateError(
        'Error: remoteToken only works with remote (human) minions. Start the chat with remote=true, or drop remoteToken and resend.'
      ),
      isError: true,
    };
  }

  if (requestedChatId) {
    if (validateIdChecksum(requestedChatId) === 'invalid') {
      return {
        content: truncateError(
          'Error: Invalid minionChatId (checksum mismatch) — the ID may have been copied incorrectly. Check the minionChatId from the previous minion result and resend.'
        ),
        isError: true,
      };
    }
    const existing = await storage.getMinionChat(requestedChatId);
    if (!existing) {
      return {
        content: truncateError(
          `Error: Minion chat not found: ${requestedChatId}. Resend to reattempt.`
        ),
        isError: true,
      };
    }
    minionChat = existing;
    existingMessages = await storage.getMinionMessages(requestedChatId);

    // Route before merging anything: a remote chat must not pick up LLM knobs.
    const chatId = minionChat.id;
    if (continueToken !== undefined && isRemoteMinionChat(minionChat)) {
      return {
        content: truncateError(
          `Error: Minion chat ${chatId} is a remote (human) chat, and a human's conversation can't be rolled back. Pass the bare minionChatId. Resend to reattempt.`
        ),
        isError: true,
      };
    }
    if (isRemoteMinionChat(minionChat)) {
      if (remoteFlag === false) {
        return {
          content: `Error: Minion chat ${chatId} is a remote (human) chat, so remote=false is not allowed on it. Omit remote to continue it, or omit minionChatId to start an LLM minion.`,
          isError: true,
        };
      }
      const resolved = resolveRemoteConfig(minionInput, minionToolOptions);
      if ('problem' in resolved) {
        return {
          content: `Error: Minion chat ${chatId} is a remote (human) chat. ${resolved.problem}`,
          isError: true,
        };
      }
      remoteConfig = resolved.config;
      // Chats from before the flag existed are marked by their session id alone.
      minionChat.remote = true;
      // The token picks the inbox a session is created in, so it can only
      // change while the chat has none: its first create failed, or the
      // backend lost its session and the re-create failed.
      if (remoteToken && remoteToken !== minionChat.remoteToken) {
        if (minionChat.remoteSessionId) {
          return {
            content: truncateError(
              `Error: Minion chat ${chatId} already has a remote session in another inbox, so its remoteToken can't change. Omit remoteToken, or start a new remote chat.`
            ),
            isError: true,
          };
        }
        minionChat.remoteToken = remoteToken;
        minionChat.lastModifiedAt = new Date();
        // Saved now: a create that fails again must not lose the correction.
        await storage.saveMinionChat(minionChat);
      }
    } else if (remoteFlag === true) {
      // Remote is decided at creation. Even an empty LLM chat stays LLM: it
      // may hold LLM-only settings (a verifyHook) a human answer would skip.
      return {
        content: `Error: remote=true cannot be used on minion chat ${chatId}: it is an LLM minion chat. Omit minionChatId to start a new remote chat.`,
        isError: true,
      };
    } else if (asyncFlag) {
      return {
        content: `Error: async=true cannot be used on minion chat ${chatId}: it is an LLM minion chat, and async only works with remote (human) minions. Drop async and resend.`,
        isError: true,
      };
    } else if (remoteToken) {
      return {
        content: truncateError(
          `Error: remoteToken cannot be used on minion chat ${chatId}: it is an LLM minion chat. Drop remoteToken, or start a new chat with remote=true.`
        ),
        isError: true,
      };
    }

    // Merge caller-provided settings into existing chat. A human only needs
    // what labels the chat and shapes the injected files, and the caller
    // still picks how the result reads; everything else is an LLM knob.
    if (minionInput.displayName !== undefined) minionChat.displayName = minionInput.displayName;
    if (minionInput.persona !== undefined) minionChat.persona = minionInput.persona;
    if (minionInput.fileLineNumbers !== undefined)
      minionChat.fileLineNumbers = minionInput.fileLineNumbers;
    if (requestedOutputFormat) minionChat.outputFormat = requestedOutputFormat;
    if (!remoteConfig) {
      if (minionInput.enabledTools !== undefined)
        minionChat.enabledTools = minionInput.enabledTools;
      if (minionInput.allowNesting !== undefined)
        minionChat.allowNesting = minionInput.allowNesting;
      if (minionInput.availablePersonas !== undefined)
        minionChat.availablePersonas = minionInput.availablePersonas;
      if (minionInput.verifyHook !== undefined) minionChat.verifyHook = minionInput.verifyHook;
      if (minionInput.enableReasoning !== undefined)
        minionChat.enableReasoning = minionInput.enableReasoning;
      if (minionInput.reasoningBudgetTokens !== undefined)
        minionChat.reasoningBudgetTokens = minionInput.reasoningBudgetTokens;
      if (minionInput.reasoningEffort !== undefined)
        minionChat.reasoningEffort = minionInput.reasoningEffort as ReasoningEffort;
      if (minionInput.verbosity !== undefined)
        minionChat.verbosity = minionInput.verbosity as Verbosity;
      if (minionInput.temperature !== undefined) minionChat.temperature = minionInput.temperature;
      if (minionInput.maxOutputTokens !== undefined)
        minionChat.maxOutputTokens = minionInput.maxOutputTokens;
      if (minionInput.fileInjectionMode !== undefined)
        minionChat.fileInjectionMode = minionInput.fileInjectionMode;
      if (minionInput.systemPrompt !== undefined)
        minionChat.systemPrompt = minionInput.systemPrompt;
      if (minionInput.systemPromptFile !== undefined)
        minionChat.systemPromptFile = minionInput.systemPromptFile;
      if (minionInput.prePersonaSystemPromptFile !== undefined)
        minionChat.prePersonaSystemPromptFile = minionInput.prePersonaSystemPromptFile;
      if (minionInput.nudgeThinking !== undefined)
        minionChat.nudgeThinking = minionInput.nudgeThinking;
      if (minionInput.thinkingKeepTurns !== undefined)
        minionChat.thinkingKeepTurns = minionInput.thinkingKeepTurns;
      if (minionInput.pruneThinkingBeforeApiCall !== undefined)
        minionChat.pruneThinkingBeforeApiCall = minionInput.pruneThinkingBeforeApiCall;
    }

    if (continueToken !== undefined) {
      // The token stands in for retry and autoRollback: drop what follows its
      // message, whatever the savepoint says.
      const pointId = resolveContinueToken(continueToken, existingMessages);
      if (pointId === undefined) {
        return {
          content: truncateError(
            `Error: Continue token "${continueToken}" is not in minion chat ${chatId}: rolled back past it, or copied wrong. Resend to reattempt.`
          ),
          isError: true,
        };
      }
      const rollback = planRollback(existingMessages, pointId, false);
      if (rollback) {
        const resolved = resolveRetryStash(rollback, minionInput.message ?? '');
        isTrueRetry = resolved.isTrueRetry;
        stashedRetryContent = resolved.stash;
        pendingRollback = rollback;
        existingMessages = rollback.kept;
      }
      // A rejection reason judged the run after the savepoint. From any other
      // point that run is on another branch, so a resend must not carry it.
      if (pointId !== minionChat.savepoint) minionChat.pendingVerifyFeedback = undefined;
      rollbackPointId = pointId;
    } else if (action === 'retry') {
      // Retry: roll back to savepoint before proceeding
      if (minionChat.savepoint === undefined) {
        return {
          content: truncateError(
            'Error: Cannot retry — no savepoint on this minion chat. Resend to reattempt.'
          ),
          isError: true,
        };
      }

      const rollback = planRollback(
        existingMessages,
        minionChat.savepoint,
        remoteConfig !== undefined
      );

      if (!rollback || (!rollback.stashedRetryContent && !rollback.recoveredMessage)) {
        return {
          content: truncateError(
            'Error: No messages after savepoint to retry. Resend to reattempt.'
          ),
          isError: true,
        };
      }

      // A recovered '' is a real value (inject-only original) — only `undefined`
      // means the original is lost.
      if (!minionInput.message && rollback.recoveredMessage !== undefined) {
        minionInput.message = rollback.recoveredMessage;
      } else if (!minionInput.message && !hasInjectSpecs(minionInput)) {
        return {
          content: truncateError(
            'Error: message required — original could not be recovered. Resend to reattempt.'
          ),
          isError: true,
        };
      }
      const resolved = resolveRetryStash(rollback, minionInput.message ?? '');
      isTrueRetry = resolved.isTrueRetry;
      stashedRetryContent = resolved.stash;
      pendingRollback = rollback;
      // Everything after this sees the chat as the rollback will leave it.
      existingMessages = rollback.kept;
    } else if (autoRollbackEnabled && minionChat.savepoint !== undefined) {
      // A continuation after a failed run drops that run first.
      const rollback = planRollback(
        existingMessages,
        minionChat.savepoint,
        remoteConfig !== undefined
      );
      if (rollback) {
        if (!minionInput.message && rollback.recoveredMessage !== undefined) {
          minionInput.message = rollback.recoveredMessage;
        }
        const resolved = resolveRetryStash(rollback, minionInput.message ?? '');
        isTrueRetry = resolved.isTrueRetry;
        stashedRetryContent = resolved.stash;
        pendingRollback = rollback;
        existingMessages = rollback.kept;
      }
    }
  } else if (remoteFlag === true) {
    // Checked before the row exists, so a misconfigured call leaves nothing behind.
    const resolved = resolveRemoteConfig(minionInput, minionToolOptions);
    if ('problem' in resolved) {
      return { content: `Error: ${resolved.problem}`, isError: true };
    }
    remoteConfig = resolved.config;
    // Only what a human conversation needs, and how the caller reads the
    // result; LLM knobs would be dead weight (and a lie, if the chat were
    // ever cloned).
    minionChat = {
      id: generateChecksummedId('minion'),
      parentChatId: context.chatId ?? 'standalone',
      projectId: context.projectId,
      savepoint: SAVEPOINT_START,
      displayName: minionInput.displayName,
      persona: minionInput.persona,
      fileLineNumbers: minionInput.fileLineNumbers,
      outputFormat: requestedOutputFormat,
      remote: true,
      ...(remoteToken && { remoteToken }),
      createdAt: new Date(),
      lastModifiedAt: new Date(),
    };
    await storage.saveMinionChat(minionChat);
  } else {
    // Create new minion chat with initial savepoint
    const parentChatId = context.chatId ?? 'standalone';
    minionChat = {
      id: generateChecksummedId('minion'),
      parentChatId,
      projectId: context.projectId,
      savepoint: SAVEPOINT_START,
      displayName: minionInput.displayName,
      persona: minionInput.persona,
      enabledTools: minionInput.enabledTools,
      allowNesting: minionInput.allowNesting,
      availablePersonas: minionInput.availablePersonas,
      verifyHook: minionInput.verifyHook,
      enableReasoning: minionInput.enableReasoning,
      reasoningBudgetTokens: minionInput.reasoningBudgetTokens,
      reasoningEffort: minionInput.reasoningEffort as ReasoningEffort,
      verbosity: minionInput.verbosity as Verbosity,
      temperature: minionInput.temperature,
      maxOutputTokens: minionInput.maxOutputTokens,
      fileInjectionMode: minionInput.fileInjectionMode,
      systemPrompt: minionInput.systemPrompt,
      systemPromptFile: minionInput.systemPromptFile,
      prePersonaSystemPromptFile: minionInput.prePersonaSystemPromptFile,
      nudgeThinking: minionInput.nudgeThinking,
      thinkingKeepTurns: minionInput.thinkingKeepTurns,
      pruneThinkingBeforeApiCall: minionInput.pruneThinkingBeforeApiCall,
      outputFormat: requestedOutputFormat,
      createdAt: new Date(),
      lastModifiedAt: new Date(),
    };
    await storage.saveMinionChat(minionChat);
  }

  // After autoRollback may have recovered a message, validate there is a task to
  // send: message text, freshly injected files, or stashed files a true retry
  // can rebuild.
  if (
    !minionInput.message &&
    !hasInjectSpecs(minionInput) &&
    !stashHasInjectedFiles(stashedRetryContent)
  ) {
    return {
      content: truncateError(
        'Error: "message" is required (or inject files to send). Resend to reattempt.'
      ),
      isError: true,
    };
  }
  // Every downstream path treats the message as a string; an inject-only call
  // sends '' and lets the file content stand as the task.
  const messageText = minionInput.message ?? '';
  minionInput.message = messageText;

  // A human needs none of the LLM validation below (model, API definition,
  // tool subset, web search), so remote calls branch off here.
  if (remoteConfig) {
    return yield* executeRemoteMinion(
      minionInput,
      minionChat,
      messageText,
      minionToolOptions,
      remoteConfig,
      stashedRetryContent,
      pendingRollback,
      existingMessages.length > 0,
      context
    );
  }

  // ── Phase 2: Validation + setup ──
  // No state change yet. Errors here mean caller should resend.

  const allowWebSearch = toolOptions?.allowWebSearch === true;
  if (minionInput.enableWeb && !allowWebSearch) {
    return {
      content: truncateError(
        'Error: Web search is not allowed for minions. Enable "Allow Web Search" in minion tool options. Resend to reattempt.'
      ),
      isError: true,
    };
  }

  const fileInjectionMode =
    (minionInput.fileInjectionMode as InjectionMode) ??
    (minionChat.fileInjectionMode as InjectionMode) ??
    (minionToolOptions.fileInjectionMode as InjectionMode) ??
    'inline';

  // Resolve effective model: input.model (from LLM) > minionChat stored model > toolOptions.model
  // (default). Precedence lives in resolveMinionModelRef (shared with parallel-throttle grouping);
  // here we additionally validate an explicitly-requested model before relying on it.
  if (minionInput.model) {
    const modelsList = minionToolOptions.models;
    if (!isModelReferenceArray(modelsList) || modelsList.length === 0) {
      return {
        content: truncateError(
          'Error: model parameter provided but no models list configured. Resend to reattempt.'
        ),
        isError: true,
      };
    }

    const parsed = parseModelString(minionInput.model);
    if (!parsed) {
      return {
        content: truncateError(
          `Error: Invalid model format: "${minionInput.model}". Expected "apiDefinitionId:modelId". Resend to reattempt.`
        ),
        isError: true,
      };
    }

    const isInList = modelsList.some(
      ref => ref.apiDefinitionId === parsed.apiDefinitionId && ref.modelId === parsed.modelId
    );
    if (!isInList) {
      const available = modelsList.map(formatModelString).join(', ');
      return {
        content: truncateError(
          `Error: Model "${minionInput.model}" is not in the configured models list. Available: ${available}. Resend to reattempt.`
        ),
        isError: true,
      };
    }
  }

  const effectiveModelRef = resolveMinionModelRef(minionInput, minionChat, minionToolOptions);

  if (!effectiveModelRef) {
    return {
      content: truncateError(
        'Error: Minion model not configured. Please configure a model in project settings. Resend to reattempt.'
      ),
      isError: true,
    };
  }

  const project = await storage.getProject(context.projectId);
  if (!project) {
    return {
      content: truncateError(
        `Error: Project not found: ${context.projectId}. Resend to reattempt.`
      ),
      isError: true,
    };
  }

  const apiDef = await storage.getAPIDefinition(effectiveModelRef.apiDefinitionId);
  if (!apiDef) {
    return {
      content: truncateError(
        `Error: API definition not found: ${effectiveModelRef.apiDefinitionId}. Resend to reattempt.`
      ),
      isError: true,
    };
  }

  const model = await storage.getModel(
    effectiveModelRef.apiDefinitionId,
    effectiveModelRef.modelId
  );
  if (!model) {
    return {
      content: truncateError(
        `Error: Model not found: ${effectiveModelRef.modelId}. Resend to reattempt.`
      ),
      isError: true,
    };
  }

  const projectTools = project.enabledTools ?? [];
  const effectiveEnabledTools = minionInput.enabledTools ?? minionChat.enabledTools;

  // claude-agent runs its own agentic loop inside the SDK. Tools DO work — they
  // bridge through the in-process MCP server (buildGremlinMcpServer) and web
  // search rides the SDK's built-in WebSearch/WebFetch. Two constraints remain:
  // the SDK owns sampling/reasoning so a few knobs are no-ops, and the `return`
  // tool is free-run only — its MCP handler can't break the SDK's turn, so a
  // return call stores a value (via the bridge side-channel) and the SDK keeps
  // running until it stops on its own.
  const isClaudeAgent = apiDef.apiType === 'claude-agent';
  if (isClaudeAgent) {
    const unsupportedInputs: string[] = [];
    if (typeof minionInput.temperature === 'number') unsupportedInputs.push('temperature');
    if (typeof minionInput.verbosity === 'string') unsupportedInputs.push('verbosity');
    if (typeof minionInput.nudgeThinking === 'string') unsupportedInputs.push('nudgeThinking');
    if (minionInput.thinkingKeepTurns !== undefined) unsupportedInputs.push('thinkingKeepTurns');
    if (minionInput.pruneThinkingBeforeApiCall !== undefined)
      unsupportedInputs.push('pruneThinkingBeforeApiCall');
    if (unsupportedInputs.length > 0) {
      console.debug(
        '[minionTool] claude-agent: ignoring no-op minion params (SDK owns sampling/reasoning):',
        unsupportedInputs.join(', ')
      );
    }
    if (fileInjectionMode === 'mock-tool-call' || fileInjectionMode === 'as-file') {
      console.debug(
        '[minionTool] claude-agent: fileInjectionMode downgraded to separate-block:',
        fileInjectionMode
      );
    }
  }

  if (effectiveEnabledTools && effectiveEnabledTools.length > 0) {
    const projectToolSet = new Set(projectTools);
    const invalidTools = effectiveEnabledTools.filter(
      t => t !== 'return' && !projectToolSet.has(t)
    );
    if (invalidTools.length > 0) {
      return {
        content: truncateError(
          `Error: Tools not available in project: ${invalidTools.join(', ')}. Available tools: ${projectTools.join(', ') || '(none)'}. Resend to reattempt.`
        ),
        isError: true,
      };
    }
  }

  const returnMode = resolveReturnMode(minionToolOptions);
  const includeReturn = returnMode !== 'no-return';
  const disableReasoning = minionToolOptions.disableReasoning === true;
  // Give the child the `minion` tool only when (a) the project gate is on,
  // (b) a grandchild (childDepth + 1) is still within the cap, and (c) the
  // caller explicitly granted nesting for this spawn (per-call opt-in, default
  // off — persisted on the minion chat for continuations). All three are hard
  // gates; the per-call grant can only narrow within the project gate + cap.
  const projectAllowNesting = minionToolOptions.allowNesting === true;
  const childMayNest = minionInput.allowNesting ?? minionChat.allowNesting ?? false;
  const includeMinionTool = resolveChildNesting(
    projectAllowNesting,
    childMayNest,
    childDepth,
    maxNestingDepth
  );
  const minionTools = buildMinionTools(
    effectiveEnabledTools,
    projectTools,
    includeReturn,
    includeMinionTool
  );

  // Persona delegation capability. `personaCeiling` is the set THIS minion may
  // delegate to (undefined = unrestricted, top-level chat). `requestedGrant` is
  // what the caller hands the child; `childAvailablePersonas` is the effective
  // ceiling threaded onto the child (inherits the full ceiling when omitted).
  const personaCeiling = context.minionAvailablePersonas;
  const requestedPersonaGrant = minionInput.availablePersonas ?? minionChat.availablePersonas;
  const childAvailablePersonas = requestedPersonaGrant ?? personaCeiling;

  // Resolve persona, namespace and the four prompt inputs.
  const promptInputs = resolveMinionPromptInputs(minionInput, minionChat, minionToolOptions);
  const { persona, nsMode, namespace: minionNamespace } = promptInputs;

  if (nsMode !== 'off') {
    // Capability check: the caller may only spawn personas within its own
    // ceiling, and may only grant a subset of that ceiling onward.
    const delegationError = checkPersonaDelegation(personaCeiling, persona, requestedPersonaGrant);
    if (delegationError) {
      return { content: truncateError(`Error: ${delegationError} Resend.`), isError: true };
    }
  }

  let minionSystemPrompt: string;
  try {
    minionSystemPrompt = await resolveAgentSystemPrompt({
      createVfsAdapter: context.createVfsAdapter,
      ...promptInputs.spec,
    });
  } catch (err) {
    if (err instanceof AgentPromptError) {
      return { content: truncateError(minionPromptErrorText(err)), isError: true };
    }
    throw err;
  }

  // ── Phase 3: Message + execution ──
  // A failed inject-file read still leaves the chat untouched. After that the
  // planned rollback lands and the user message is saved; errors from then on
  // name the minion chat and can be retried via action: 'retry'.

  // Check if last message is assistant with unresolved tool_use blocks (needs apiDef.apiType).
  // This happens when the return tool was called (possibly in parallel with other tools),
  // breaking the agentic loop before a tool_result message could be saved.
  let pendingReturnToolUse: { id: string; name: string } | undefined;
  let unresolvedNonReturnTools: { id: string; name: string }[] = [];
  if (existingMessages.length > 0) {
    const lastMsg = existingMessages[existingMessages.length - 1];
    if (lastMsg.role === 'assistant' && lastMsg.content.fullContent) {
      const toolUseBlocks = apiService.extractToolUseBlocks(
        apiDef.apiType,
        lastMsg.content.fullContent
      );
      if (toolUseBlocks.length > 0) {
        const returnToolUse = toolUseBlocks.find(t => t.name === 'return');
        if (returnToolUse) {
          pendingReturnToolUse = { id: returnToolUse.id, name: returnToolUse.name };
          unresolvedNonReturnTools = toolUseBlocks
            .filter(t => t.name !== 'return')
            .map(t => ({ id: t.id, name: t.name }));
        }
      }
    }
  }

  const injected = await readInjectedFiles(
    minionInput,
    minionChat,
    minionToolOptions,
    project.noLineNumbers,
    context.createVfsAdapter
  );
  if ('failure' in injected) return injected.failure;
  const injectedFiles = injected.files;
  const {
    label: injectFileLabel,
    before: injectedFileEntries,
    after: injectedFileAfterEntries,
    prefix: injectedFilesPrefix,
    endMarker: injectedFilesEndMarker,
    suffix: injectedFilesSuffix,
  } = injectedFiles;

  // Build info group for streaming display (include persona name for non-default personas)
  const personaLabel = minionPersonaLabel(minionChat, minionToolOptions);
  const infoGroup = buildInfoGroup(
    messageText,
    minionChat.id,
    personaLabel,
    minionChat.displayName,
    effectiveModelRef.apiDefinitionId,
    effectiveModelRef.modelId,
    toInfoFileEntries(injectedFileEntries, injectFileLabel),
    toInfoFileEntries(injectedFileAfterEntries, injectFileLabel)
  );

  // Persist resolved model and tools into minionChat for future continuation
  minionChat.apiDefinitionId = effectiveModelRef.apiDefinitionId;
  minionChat.modelId = effectiveModelRef.modelId;
  minionChat.enabledTools = effectiveEnabledTools;

  // Verify-feedback note: consume the pending rejection reason. Applied only to
  // a true retry (re-attempting the rejected message) in the normal user-message
  // branch below — a new message means the orchestrator already changed course,
  // so the note is dropped as moot. The fullContent-reuse and return-tool
  // branches keep their exact payloads and skip the note (a limitation).
  const verifyFeedbackNote = isTrueRetry ? minionChat.pendingVerifyFeedback : undefined;
  minionChat.pendingVerifyFeedback = undefined;

  // Every check has passed. The rollback Phase 1 planned lands here, right
  // before this call's first message write. The chat is saved either way, so
  // the cleared feedback and the settings this call changed persist even if
  // the run fails: a continue token restores the transcript, not settings.
  if (pendingRollback) {
    await applyRollback(storage, minionChat, pendingRollback);
  } else {
    if (rollbackPointId !== undefined && rollbackPointId !== minionChat.savepoint) {
      // Nothing follows the token's message, but a failed run may have left
      // the savepoint, and a claude-agent session, behind it.
      if (minionChat.claudeAgentSessionId) {
        applyRewindPatch(
          minionChat,
          findPriorAssistantClaudeAgentUuid(existingMessages, rollbackPointId)
        );
      }
      minionChat.savepoint = rollbackPointId;
      minionChat.lastModifiedAt = new Date();
    }
    await storage.saveMinionChat(minionChat);
  }
  const verifyNoteText = verifyFeedbackNote
    ? buildVerifyFeedbackNote(verifyFeedbackNote)
    : undefined;

  // Build context for minion based on retry re-use, return tool resumption, or normal message
  let minionContext: Message<unknown>[];

  if (stashedRetryContent && stashedRetryContent.modelFamily === apiDef.apiType) {
    // Re-use original message with its fullContent (compatible API type).
    // This preserves the exact tool_result payload without lossy text extraction + reconstruction.
    const reusedMessage: Message<unknown> = {
      id: generateUniqueId('msg_user'),
      role: 'user',
      content: {
        type: 'text',
        content: messageText,
        modelFamily: stashedRetryContent.modelFamily,
        fullContent: stashedRetryContent.fullContent,
        renderingContent: stashedRetryContent.renderingContent,
      },
      timestamp: new Date(),
    };
    await storage.saveMinionMessage(minionChat.id, reusedMessage);
    minionContext = [...existingMessages, reusedMessage];
  } else if (pendingReturnToolUse) {
    // Resume after return tool: build tool_result for the return tool + error results
    // for any other tools that were called in parallel and skipped.
    const toolResultBlocks: ToolResultBlock[] = [];
    const toolResultRenderBlocks: ToolResultRenderBlock[] = [];

    // Error results for tools that were skipped due to parallel return call
    for (const skipped of unresolvedNonReturnTools) {
      const errContent =
        'Tool call skipped: the return tool was called in parallel, which breaks the agentic loop. Other parallel tool calls cannot be executed.';
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: skipped.id,
        name: skipped.name,
        content: errContent,
        is_error: true,
      });
      toolResultRenderBlocks.push(
        createToolResultRenderBlock(
          skipped.id,
          skipped.name,
          errContent,
          true,
          undefined,
          undefined,
          toolRegistry
        )
      );
    }

    // Return tool result: user's continuation message. A tool result is plain
    // text, so injected files ride inline here whatever the injection mode.
    const continuationText = buildInlineContent(
      injectedFilesPrefix,
      injectedFilesEndMarker,
      messageText,
      injectedFilesSuffix
    );
    toolResultBlocks.push({
      type: 'tool_result',
      tool_use_id: pendingReturnToolUse.id,
      name: pendingReturnToolUse.name,
      content: continuationText,
    });
    // The file bars around this group already show the files, so the block
    // shows the message alone (like a user message's text group).
    toolResultRenderBlocks.push(
      createToolResultRenderBlock(
        pendingReturnToolUse.id,
        pendingReturnToolUse.name,
        messageText,
        false,
        undefined,
        undefined,
        toolRegistry
      )
    );

    const toolResultMessage: Message<unknown> = {
      id: generateUniqueId('msg_user'),
      role: 'user',
      content: {
        type: 'text',
        content: '',
        modelFamily: apiDef.apiType,
      },
      timestamp: new Date(),
    };
    toolResultMessage.content.toolResults = toolResultBlocks;
    const continuationGroups: RenderingBlockGroup[] = [];
    if (injectedFileEntries.length > 0) {
      continuationGroups.push({
        category: 'backstage',
        blocks: injectedFileEntries.map(f => toInjectedFileBlock(f, injectFileLabel)),
      });
    }
    continuationGroups.push({ category: 'backstage', blocks: toolResultRenderBlocks });
    if (injectedFileAfterEntries.length > 0) {
      continuationGroups.push({
        category: 'backstage',
        blocks: injectedFileAfterEntries.map(f => toInjectedFileBlock(f, injectFileLabel)),
      });
    }
    toolResultMessage.content.renderingContent = continuationGroups;

    await storage.saveMinionMessage(minionChat.id, toolResultMessage);

    minionContext = [...existingMessages, toolResultMessage];
  } else {
    // Normal case: build user message for minion
    // Use stashed renderingContent from retry if available and no new files were injected,
    // preserving file bar UI instead of rendering file content as plain text.
    const hasFreshInjectEntries =
      injectedFileEntries.length > 0 || injectedFileAfterEntries.length > 0;
    let renderingGroups: RenderingBlockGroup[];
    if (stashedRetryContent?.renderingContent && !hasFreshInjectEntries) {
      // Drop any stale verify-feedback note carried in the stash — the model
      // only receives the current note (appended below), so rendering the old
      // one would misrepresent what this attempt saw.
      renderingGroups = stashedRetryContent.renderingContent.filter(
        g => !isVerifyFeedbackNoteGroup(g)
      );
    } else {
      renderingGroups = buildUserMessageGroups(injectedFiles, messageText);
    }

    // Determine effective injection mode, restoring from stash on retry
    const restoreFromStash =
      !hasFreshInjectEntries &&
      Boolean(stashedRetryContent?.injectedFiles ?? stashedRetryContent?.injectedFilesAfter);
    const effectiveMode = restoreFromStash
      ? ((stashedRetryContent!.injectionMode as typeof fileInjectionMode) ?? 'inline')
      : fileInjectionMode;
    const effectiveFiles = restoreFromStash
      ? (stashedRetryContent!.injectedFiles ?? [])
      : injectedFileEntries.filter(f => !f.error);
    const effectiveFilesAfter = restoreFromStash
      ? (stashedRetryContent!.injectedFilesAfter ?? [])
      : injectedFileAfterEntries.filter(f => !f.error);
    // mock-tool-call changes the message shape (synthetic tool_use/tool_result
    // pairs), so its downgrade must happen here at production time — the API
    // client can't undo stored messages. Block-level modes stay stored raw and
    // are downgraded client-side like every other provider.
    // An inject-only call can't use mock-tool-call either: the synthetic pairs
    // must follow a user turn with content, and an empty user message is
    // rejected by every provider (or, if skipped, leaves a fresh chat opening
    // with an assistant turn). Downgrade to separate-block, which keeps the
    // stored fields and the file bars intact.
    let resolvedMode: typeof fileInjectionMode;
    if (effectiveMode !== 'mock-tool-call') {
      resolvedMode = effectiveMode;
    } else if (messageText === '') {
      console.debug(
        '[minionTool] mock-tool-call: no message text, downgraded to separate-block for inject-only call'
      );
      resolvedMode = 'separate-block';
    } else {
      resolvedMode = effectiveInjectionMode('mock-tool-call', apiDef.apiType);
    }
    const isMockToolCall = resolvedMode === 'mock-tool-call';
    const useStructuredInjection =
      !isMockToolCall &&
      resolvedMode !== 'inline' &&
      effectiveFiles.length + effectiveFilesAfter.length > 0;
    // Mock mode must also store the fields: its file content lives only in the
    // synthetic pair messages, which a retry rollback deletes — the stash can
    // only rebuild the pairs from fields carried by the user message itself.
    // API clients ignore stored 'mock-tool-call' (no emit branch), so nothing
    // double-injects.
    const storeInjectionFields =
      (useStructuredInjection || isMockToolCall) &&
      effectiveFiles.length + effectiveFilesAfter.length > 0;

    // For mock-tool-call: keep content clean, files go into synthetic message pairs below.
    // For inline mode: wrap the message with file text (prefix before, suffix after).
    // For separate-block / as-file: keep content clean, store files on the message
    // so the API client can build native blocks.
    const llmContent =
      isMockToolCall || useStructuredInjection
        ? messageText
        : buildInlineContent(
            injectedFilesPrefix,
            injectedFilesEndMarker,
            messageText,
            injectedFilesSuffix
          );

    // Append the verify-feedback note to what the model receives AND to the
    // rendered mirror (spread, not push — the stash branch above may have
    // handed us the stashed array).
    if (verifyNoteText) {
      renderingGroups = [
        ...renderingGroups,
        {
          category: 'text',
          blocks: [{ type: 'text', text: verifyNoteText }],
          isToolGenerated: true,
        },
      ];
    }

    const userMessage: Message<string> = {
      id: generateUniqueId('msg_user'),
      role: 'user',
      content: {
        type: 'text',
        content: verifyNoteText ? `${llmContent}\n\n${verifyNoteText}` : llmContent,
        renderingContent: renderingGroups,
        ...(storeInjectionFields && {
          ...(effectiveFiles.length > 0 && {
            injectedFiles: effectiveFiles.map(toStoredInjectedFile),
          }),
          ...(effectiveFilesAfter.length > 0 && {
            injectedFilesAfter: effectiveFilesAfter.map(toStoredInjectedFile),
          }),
          injectionMode: resolvedMode,
          modelFamily: apiDef.apiType,
        }),
      },
      timestamp: new Date(),
    };

    // Save user message to minion chat
    await storage.saveMinionMessage(minionChat.id, userMessage);

    minionContext = [...existingMessages, userMessage];

    // For mock-tool-call mode: insert synthetic assistant tool_use + user tool_result pairs
    // after the user message, so the LLM sees the files as if it had read them via a tool.
    // Leading batch first, then the trailing one — same order the inline text uses.
    if (isMockToolCall) {
      for (const file of [...effectiveFiles, ...effectiveFilesAfter]) {
        // file.content is already formatted per injectFileLineNumbers (inline
        // seam above / stashed on retry) — re-formatting would double the line
        // numbers.
        const [assistantMsg, resultMsg] = buildMockToolCallPair(
          file,
          buildInjectedFileDisplay(file, injectFileLabel)
        );
        await storage.saveMinionMessage(minionChat.id, assistantMsg);
        await storage.saveMinionMessage(minionChat.id, resultMsg);
        minionContext.push(assistantMsg, resultMsg);
      }
    }
  }

  // Build system prompts from enabled tools
  const systemPromptContext = {
    projectId: context.projectId,
    chatId: minionChat.id,
    apiDefinitionId: apiDef.id,
    modelId: model.id,
    apiType: apiDef.apiType,
    namespace: minionNamespace,
    // Filter the child's persona listing to the set it may delegate to.
    minionAvailablePersonas: childAvailablePersonas,
    createVfsAdapter: context.createVfsAdapter,
  };

  const toolSystemPrompts = await toolRegistry.getSystemPrompts(
    apiDef.apiType,
    minionTools,
    systemPromptContext,
    project.toolOptions ?? {}
  );

  // Combine system prompts: minion-specific + tool prompts
  const combinedSystemPrompt = [minionSystemPrompt, ...toolSystemPrompts]
    .filter(Boolean)
    .join('\n\n');

  // Build effective tool options — inject returnMode and deferReturn into return tool's options
  // so its description function reflects the current mode. claude-agent forces
  // free-run: the bridged return tool can't break the SDK's turn, so its result
  // is stored and delivered when the turn ends — the only honest description.
  const deferReturnMode: 'no' | 'auto-ack' | 'free-run' | undefined = isClaudeAgent
    ? 'free-run'
    : typeof minionToolOptions.deferReturn === 'string'
      ? (minionToolOptions.deferReturn as 'no' | 'auto-ack' | 'free-run')
      : minionToolOptions.deferReturn === true
        ? 'free-run'
        : undefined;
  const effectiveToolOptions = { ...(project.toolOptions ?? {}) };
  effectiveToolOptions.return = {
    ...effectiveToolOptions.return,
    returnMode,
    ...(deferReturnMode && deferReturnMode !== 'no' ? { deferReturn: deferReturnMode } : {}),
  };

  // ── Child loop registration with LoopRegistry ──
  // The minion tool spawns its own agentic loop directly (it doesn't go
  // through ChatRunner), so the registry never sees it unless we register
  // here. Without this the sidebar Running Loops UI cannot show parallel
  // minion calls or hard-abort one without killing the parent. Skip
  // registration when the parent isn't tracked (test/standalone path) —
  // there's no meaningful parent to nest under in that case.
  const shouldRegisterChildLoop = context.loopId !== undefined;
  const childLoopId: LoopId | undefined = shouldRegisterChildLoop
    ? generateUniqueId('loop')
    : undefined;
  // Fresh AbortController per child so the sidebar can hard-abort one
  // minion without aborting siblings or the parent. Parent → child
  // cascade is wired below via a one-shot listener; child → parent
  // cascade does NOT happen.
  const childAbortController = new AbortController();
  const onParentAbort = () => childAbortController.abort();
  if (context.signal.aborted) {
    childAbortController.abort();
  } else {
    context.signal.addEventListener('abort', onParentAbort, { once: true });
  }

  if (childLoopId) {
    const childActiveLoop: ActiveLoop = {
      loopId: childLoopId,
      // Use the parent chat id so the sidebar groups the row under the
      // chat the user is actually viewing. Falls back to the minion chat
      // id only when the parent doesn't have one (defensive — production
      // always sets it via ChatRunner's context).
      chatId: context.chatId ?? minionChat.id,
      parentLoopId: context.loopId,
      startedAt: Date.now(),
      status: 'running',
      apiDefinitionId: effectiveModelRef.apiDefinitionId,
      modelId: effectiveModelRef.modelId,
      // The sidebar prefers `displayName` over the chat name; reuse the
      // same persona/displayName label the streaming info group uses so
      // the row is recognizable.
      displayName: personaLabel ?? minionInput.displayName,
    };
    context.loopRegistry.register(childActiveLoop, childAbortController);
  }

  // Build agentic loop options for minion
  const loopOptions: AgenticLoopOptions = {
    apiDef,
    model,
    projectId: context.projectId,
    chatId: minionChat.id,
    // PR 4: forward the parent loop's id so the LoopRegistry can render the
    // minion run as a child of the loop that called the minion tool. The
    // child's own `loopId` is minted by the backend in PR 7+.
    loopId: childLoopId,
    parentLoopId: context.loopId,
    // The child runs one level deeper; threading this lets the child's own
    // minion calls (if any) enforce the same depth cap.
    minionDepth: childDepth,
    // The persona set this child may delegate to — its ceiling for further
    // narrowing, and what its persona listing is filtered to.
    minionAvailablePersonas: childAvailablePersonas,
    temperature:
      minionInput.temperature !== undefined
        ? minionInput.temperature
        : minionChat.temperature !== undefined
          ? minionChat.temperature
          : (project.temperature ?? undefined),
    maxTokens:
      minionInput.maxOutputTokens !== undefined
        ? minionInput.maxOutputTokens
        : minionChat.maxOutputTokens !== undefined
          ? minionChat.maxOutputTokens
          : project.maxOutputTokens,
    systemPrompt: combinedSystemPrompt || undefined,
    preFillResponse: undefined, // Minions don't use prefill
    webSearchEnabled: allowWebSearch && (minionInput.enableWeb ?? false),
    enabledTools: minionTools,
    toolOptions: effectiveToolOptions,
    disableStream: project.disableStream ?? false,
    extendedContext: project.extendedContext ?? false,
    useAnthropicOneHourCache: project.useAnthropicOneHourCache ?? false,
    // Thread the project setting (minion sub-loops otherwise never inherit it)
    // plus the minion-level override, so the child's own fs/memory reads resolve
    // the same precedence — a per-read withLineNumbers still wins over both.
    noLineNumbers: project.noLineNumbers,
    fileLineNumbers: minionInput.fileLineNumbers ?? minionChat.fileLineNumbers,
    // Scope is the project's, but the key is derived from THIS loop's chatId —
    // which is the minion chat — so 'chat' scope isolates each minion's cache
    // bucket instead of sharing the parent's.
    cacheRoutingScope: project.cacheRoutingScope,
    // Gated against the MINION's apiDef, not the parent's: a minion routed to a
    // flex-supporting provider gets the discount even when the main chat's
    // provider doesn't support it.
    flexTierEnabled: !!(project.flexTierEnabled && apiDef.advancedSettings?.flexTierSupported),
    namespace: minionNamespace,
    createVfsAdapter: context.createVfsAdapter,
    deferReturn: deferReturnMode && deferReturnMode !== 'no' ? deferReturnMode : undefined,
    fallbackToolExtraction: true,
    deferredSoftStopRounds:
      typeof minionToolOptions.deferredSoftStopRounds === 'number'
        ? minionToolOptions.deferredSoftStopRounds
        : undefined,
    deferredForceStopRounds:
      typeof minionToolOptions.deferredForceStopRounds === 'number'
        ? minionToolOptions.deferredForceStopRounds
        : undefined,
    returnAckMessage:
      typeof minionToolOptions.returnAckMessage === 'string' && minionToolOptions.returnAckMessage
        ? minionToolOptions.returnAckMessage
        : undefined,
    returnDuplicateMessage:
      typeof minionToolOptions.returnDuplicateMessage === 'string' &&
      minionToolOptions.returnDuplicateMessage
        ? minionToolOptions.returnDuplicateMessage
        : undefined,
    autoAckMessage:
      typeof minionToolOptions.autoAckMessage === 'string' && minionToolOptions.autoAckMessage
        ? minionToolOptions.autoAckMessage
        : undefined,
    // Reasoning settings — input overrides take precedence over project defaults
    enableReasoning:
      minionInput.enableReasoning !== undefined
        ? minionInput.enableReasoning
        : minionChat.enableReasoning !== undefined
          ? minionChat.enableReasoning
          : disableReasoning
            ? false
            : project.enableReasoning,
    reasoningBudgetTokens:
      minionInput.reasoningBudgetTokens !== undefined
        ? minionInput.reasoningBudgetTokens
        : minionChat.reasoningBudgetTokens !== undefined
          ? minionChat.reasoningBudgetTokens
          : project.reasoningBudgetTokens,
    thinkingKeepTurns: (() => {
      const effective =
        minionInput.thinkingKeepTurns !== undefined
          ? minionInput.thinkingKeepTurns
          : minionChat.thinkingKeepTurns !== undefined
            ? minionChat.thinkingKeepTurns
            : project.thinkingKeepTurns;
      return effective;
    })(),
    pruneThinkingKeepTurns: (() => {
      const prune =
        minionInput.pruneThinkingBeforeApiCall !== undefined
          ? minionInput.pruneThinkingBeforeApiCall
          : minionChat.pruneThinkingBeforeApiCall !== undefined
            ? minionChat.pruneThinkingBeforeApiCall
            : project.pruneThinkingBeforeApiCall;
      if (!prune) return undefined;
      const keep =
        minionInput.thinkingKeepTurns !== undefined
          ? minionInput.thinkingKeepTurns
          : minionChat.thinkingKeepTurns !== undefined
            ? minionChat.thinkingKeepTurns
            : project.thinkingKeepTurns;
      return keep !== undefined && keep >= 0 ? keep : undefined;
    })(),
    reasoningEffort:
      minionInput.reasoningEffort !== undefined
        ? (minionInput.reasoningEffort as ReasoningEffort)
        : minionChat.reasoningEffort !== undefined
          ? minionChat.reasoningEffort
          : project.reasoningEffort,
    reasoningSummary: project.reasoningSummary,
    verbosity: (minionInput.verbosity as Verbosity) ?? minionChat.verbosity ?? project.verbosity,
    // Nudge thinking — input override wins (empty string explicitly disables),
    // then the persisted minion-chat value, then the provider-level toggle with
    // the default text.
    nudgeThinking:
      typeof minionInput.nudgeThinking === 'string'
        ? minionInput.nudgeThinking
        : typeof minionChat.nudgeThinking === 'string'
          ? minionChat.nudgeThinking
          : apiDef.advancedSettings?.nudgeThinking
            ? NUDGE_THINKING_DEFAULT
            : undefined,
    // The child loop runs against its OWN AbortController so the sidebar
    // can hard-abort one minion without aborting siblings. The parent's
    // signal still propagates via the one-shot listener wired above —
    // aborting the parent fires every child's controller too.
    signal: childAbortController.signal,
    // Forward the parent loop's injected backend bundle so the minion's
    // child loop runs against the same storage / encryption / api / tool
    // registry instances the parent received. Threading the bundle this way
    // — instead of importing module-level singletons — is what makes the
    // child loop work in worker mode against remote storage.
    deps: {
      storage: context.storage,
      encryption: context.encryption,
      vfsService: context.vfsService,
      apiService: context.apiService,
      toolRegistry: context.toolRegistry,
      loopRegistry: context.loopRegistry,
    },
    claudeAgentSessionId: minionChat.claudeAgentSessionId,
    claudeAgentResumeAt: minionChat.claudeAgentResumeAt,
    claudeAgentForkSession: shouldForkSession(minionChat),
  };

  // Delta-encoding emitter state. The minion ships `tool_groups_delta`
  // events instead of full per-chunk snapshots; this closure-state object
  // tracks what the receivers hold across yield sites. Init fires lazily on
  // the first streaming yield (or on a `message_finalized` if the minion
  // finishes before producing a streaming chunk).
  const deltaState = makeEmitterState(infoGroup);

  // Run agentic loop with streaming
  const totals = createTokenTotals();
  // Accumulated finalized blocks from all minion messages (marked as tool-generated)
  const accumulatedGroups: RenderingBlockGroup[] = [];
  // Text content from all assistant messages in this turn
  const accumulatedText: string[] = [];
  let assistantMessageCount = 0;
  let usedReturnTool = false;
  let returnValue: string | undefined;

  // Tracks the terminal status we'll report to the LoopRegistry in the
  // outer `finally`. Defaults to `error` so any unexpected throw or
  // early-return path before the loop produces a meaningful status still
  // closes out the registration with a sane terminal state.
  let terminalRegistryStatus: 'complete' | 'error' | 'aborted' | 'soft_stopped' | 'max_iterations' =
    'error';

  const outputFormat = resolveOutputFormat(minionInput, minionChat);
  // A plain continue lands on top of what a failed run saved, and only this
  // token marks the spot before that continue. With autoRollback the next
  // call drops the failed run anyway, so the last success token already does.
  const failureContinueTokens = continueTokensEnabled && !autoRollbackEnabled;
  const runFailure = async (error: string): Promise<ToolResult> => {
    // The failed run's messages stay stored, so the totals take its spend:
    // the rollback that drops them later subtracts it again. Best effort, like
    // the token: a failing write must not swallow the error result.
    if (hasTokenUsage(totals)) {
      try {
        await storage.saveMinionChat(
          Object.assign(minionChat, chatTotalsWithRun(minionChat, totals))
        );
      } catch (err) {
        console.debug('[minionTool] totals of the failed run of %s not saved:', minionChat.id, err);
      }
    }
    return {
      content: formatMinionError({
        error,
        minionChatId: minionChat.id,
        outputFormat,
        continueToken: failureContinueTokens
          ? await storedTailContinueToken(storage, minionChat.id)
          : undefined,
      }),
      isError: true,
      renderingGroups: [infoGroup, ...accumulatedGroups],
      tokenTotals: totals,
    };
  };

  try {
    type LoopFinalResult =
      Awaited<ReturnType<typeof runAgenticLoop>> extends AsyncGenerator<infer _E, infer R, infer _N>
        ? R
        : never;

    let loopMessages = minionContext;
    let autoEnforceAttempts = 0;
    let lastFinalResult: LoopFinalResult | undefined;

    // Main execution loop (re-runs for auto-enforce retries)
    while (true) {
      const gen = runAgenticLoop(loopOptions, loopMessages);

      // Consume generator, handling events
      let iterResult: IteratorResult<AgenticLoopEvent, LoopFinalResult>;

      do {
        iterResult = await gen.next();

        if (!iterResult.done) {
          const event = iterResult.value;

          switch (event.type) {
            case 'streaming_start': {
              // A new child iteration streams a new reply from empty groups.
              const delta = streamingResetDelta(deltaState);
              if (delta) {
                yield { type: 'groups_delta', delta };
              }
              break;
            }

            case 'streaming_delta':
              // The child's ops pass straight through; the first one
              // becomes the `init` carrying the full state.
              yield { type: 'groups_delta', delta: nextStreamingOpsDelta(deltaState, event.ops) };
              break;

            case 'message_created':
              // Save message to minion chat
              await storage.saveMinionMessage(minionChat.id, event.message);
              if (event.message.role === 'assistant') {
                assistantMessageCount++;
              }
              // Accumulate rendering content, mark as tool-generated
              if (event.message.content.renderingContent) {
                const markedGroups = event.message.content.renderingContent.map(g => ({
                  ...g,
                  isToolGenerated: true,
                }));
                accumulatedGroups.push(...markedGroups);
              }
              // Accumulate text from assistant messages
              if (event.message.role === 'assistant' && event.message.content.content) {
                accumulatedText.push(event.message.content.content as string);
              }
              // Roll the in-flight streaming state into accumulated. The
              // helper also promotes to `init` if no streaming chunk fired
              // for this tool run (e.g., tool returns without producing a
              // sub-message).
              yield {
                type: 'groups_delta',
                delta: finalizeMessageDelta(deltaState, accumulatedGroups.slice(), []),
              };
              break;

            case 'tokens_consumed':
              addTokens(totals, event.tokens);
              break;

            case 'claude_agent_turn': {
              // Persist SDK session ID on the MinionChat row and clear any
              // pending resumeAt — same idempotent pattern ChatRunner uses
              // for the parent-chat case. Nothing is deleted; see
              // engine/lib/claudeAgentSessionSharing.
              const needsSessionSave = minionChat.claudeAgentSessionId !== event.sessionId;
              const needsResumeClear = minionChat.claudeAgentResumeAt !== undefined;
              if (needsSessionSave || needsResumeClear) {
                minionChat.claudeAgentSessionId = event.sessionId;
                minionChat.claudeAgentResumeAt = undefined;
                await storage.saveMinionChat(minionChat);
              }
              break;
            }

            case 'streaming_end':
            case 'first_chunk':
            case 'pending_tool_result':
            case 'tool_block_update':
            case 'tool_groups_delta':
            case 'checkpoint_set':
            case 'active_hook_changed':
            case 'chat_metadata_updated':
            case 'dummy_hook_start':
            case 'dummy_hook_end':
              break;
          }
        }
      } while (!iterResult.done);

      lastFinalResult = iterResult.value;
      // Mirror the loop's terminal status into the variable the outer
      // `finally` reports to the LoopRegistry. Status keeps the LAST
      // iteration's value across auto-enforce retries (which is what we
      // want — the registry sees the final outcome, not the intermediate
      // re-runs).
      terminalRegistryStatus = lastFinalResult.status;

      // Determine response based on final status
      if (lastFinalResult.status === 'complete' && lastFinalResult.returnValue !== undefined) {
        usedReturnTool = true;
        returnValue = lastFinalResult.returnValue;
      } else if (lastFinalResult.status === 'error') {
        await applyClaudeAgentRewindOnFailure(
          storage,
          minionChat,
          isClaudeAgent,
          existingMessages,
          lastFinalResult?.messages ?? [],
          'turn error'
        );
        return await runFailure(`Minion error: ${lastFinalResult.error.message}`);
      } else if (lastFinalResult.status === 'aborted') {
        // Sidebar STOP on this minion row (or parent abort cascading
        // through the wired listener). Return an error tool result so the
        // parent agentic loop continues with its other parallel branches
        // intact instead of inheriting the abort.
        await applyClaudeAgentRewindOnFailure(
          storage,
          minionChat,
          isClaudeAgent,
          existingMessages,
          lastFinalResult?.messages ?? [],
          'aborted'
        );
        return await runFailure('Minion was aborted');
      } else if (lastFinalResult.status === 'max_iterations') {
        // If a deferred return was stored before hitting max iterations, use it
        if (lastFinalResult.returnValue !== undefined) {
          usedReturnTool = true;
          returnValue = lastFinalResult.returnValue;
        } else {
          await applyClaudeAgentRewindOnFailure(
            storage,
            minionChat,
            isClaudeAgent,
            existingMessages,
            lastFinalResult?.messages ?? [],
            'max iterations'
          );
          return await runFailure(`Minion reached maximum iterations (${MAX_ITERATIONS})`);
        }
      } else if (lastFinalResult.status === 'soft_stopped') {
        await applyClaudeAgentRewindOnFailure(
          storage,
          minionChat,
          isClaudeAgent,
          existingMessages,
          lastFinalResult?.messages ?? [],
          'soft stopped'
        );
        return await runFailure('Minion was stopped before completion');
      }

      // Auto-enforce retry: if return wasn't called and retries remain, send reminder and re-run.
      // Skipped for claude-agent — the SDK owns the loop, so return is free-run
      // best-effort and there's no clean "re-run with a reminder" boundary.
      // Skipped for a truncated run too: the abnormal-stop gate below reports it.
      if (
        returnMode === 'auto-enforced' &&
        !isClaudeAgent &&
        !usedReturnTool &&
        NORMAL_STOP_REASONS.has(finalStopReason(lastFinalResult.messages)) &&
        autoEnforceAttempts < AUTO_ENFORCE_MAX_RETRIES
      ) {
        autoEnforceAttempts++;
        const reminderMessage: Message<string> = {
          id: generateUniqueId('msg_user'),
          role: 'user',
          content: {
            type: 'text',
            content:
              (typeof minionToolOptions.returnEnforceMessage === 'string' &&
                minionToolOptions.returnEnforceMessage) ||
              'You have not used the return tool to respond. Please put your response in the return tool call.',
          },
          timestamp: new Date(),
        };
        await storage.saveMinionMessage(minionChat.id, reminderMessage);
        // Add reminder to accumulated rendering groups
        accumulatedGroups.push({
          category: 'text',
          blocks: [{ type: 'text', text: reminderMessage.content.content }],
          isToolGenerated: true,
        });
        yield {
          type: 'groups_delta',
          delta: finalizeMessageDelta(deltaState, accumulatedGroups.slice(), []),
        };
        loopMessages = await storage.getMinionMessages(minionChat.id);
        continue;
      }

      break;
    }

    // Guard: no assistant message produced at all
    if (assistantMessageCount === 0) {
      await applyClaudeAgentRewindOnFailure(
        storage,
        minionChat,
        isClaudeAgent,
        existingMessages,
        lastFinalResult?.messages ?? [],
        'no assistant message'
      );
      return await runFailure('Minion completed but no assistant message was produced');
    }

    let stopReason = lastFinalResult ? finalStopReason(lastFinalResult.messages) : 'end_turn';
    // Map tool_use → end_turn when return tool triggered completion
    if (usedReturnTool && stopReason === 'tool_use') {
      stopReason = 'end_turn';
    }

    // Abnormal stop reasons → error (skip savepoint so next call can roll back)
    if (!NORMAL_STOP_REASONS.has(stopReason)) {
      await applyClaudeAgentRewindOnFailure(
        storage,
        minionChat,
        isClaudeAgent,
        existingMessages,
        lastFinalResult?.messages ?? [],
        'abnormal stop'
      );
      return await runFailure(`Minion ended unexpectedly (${stopReason})`);
    }

    // ── Verify hook: run VFS-based JS to validate minion output before savepoint ──
    if (minionChat.verifyHook) {
      const hookPath = `/hooks/${minionChat.verifyHook}.js`;
      const hookAdapter = context.createVfsAdapter();
      let hookCode: string | null = null;
      try {
        hookCode = await hookAdapter.readFile(hookPath);
      } catch {
        // VFS error — treat as missing
      }
      if (!hookCode) {
        return await runFailure(`Verify hook file not found: ${hookPath}`);
      }

      // Gather new messages from this run
      const allStoredMessages = await storage.getMinionMessages(minionChat.id);
      const newMessages = allStoredMessages.slice(existingMessages.length);

      // Condense to HookInputMessage format
      const condensed: HookInputMessage[] = newMessages.map(msg => {
        const entry: HookInputMessage = {
          id: msg.id,
          role: msg.role as 'user' | 'assistant' | 'system',
        };
        const textContent = msg.content.content as string | undefined;
        if (textContent?.trim()) entry.text = textContent;
        if (msg.content.toolCalls?.length) {
          entry.toolCalls = msg.content.toolCalls.map(tc => ({
            id: tc.id,
            name: tc.name,
            input: tc.input,
          }));
        }
        if (msg.content.toolResults?.length) {
          entry.toolResults = msg.content.toolResults.map(tr => ({
            tool_use_id: tr.tool_use_id,
            name: tr.name ?? 'unknown',
            content: tr.content,
            ...(tr.is_error ? { is_error: true } : {}),
          }));
        }
        return entry;
      });

      // Run hook in QuickJS sandbox
      const vm = await JsVMContext.create(hookAdapter, false, false);
      try {
        const wrappedCode = `
          (async function() {
            var __verifyFn = await (async function() {
              ${hookCode}
            })();
            if (typeof __verifyFn !== 'function') {
              throw new Error('verifyHook file must return a function');
            }
            return __verifyFn(${JSON.stringify(condensed)});
          })()
        `;

        const evalResult = await vm.evaluate(wrappedCode, 'verifyHook');

        if (evalResult.isError) {
          return await runFailure(
            `Verify hook error: ${String(evalResult.value ?? 'Unknown error')}`
          );
        }

        // Nullish → pass; string → rejection
        if (evalResult.value !== null && evalResult.value !== undefined) {
          const errorMsg =
            typeof evalResult.value === 'string'
              ? evalResult.value
              : JSON.stringify(evalResult.value);
          if (verifyFeedbackEnabled) {
            // Deliver the rejection reason with the next true retry so the
            // model gets a corrective signal instead of a byte-identical
            // resend. Capped — hooks can return arbitrarily large payloads.
            minionChat.pendingVerifyFeedback = errorMsg.slice(0, 1000);
            await storage.saveMinionChat(minionChat);
          }
          // claude-agent: rewind the SDK session past this rejected turn so the
          // next call (action: 'retry' or autoRollback) doesn't resume from it.
          await applyClaudeAgentRewindOnFailure(
            storage,
            minionChat,
            isClaudeAgent,
            existingMessages,
            lastFinalResult?.messages ?? [],
            'verifyHook reject'
          );
          return await runFailure(`Verify hook rejected: ${errorMsg}`);
        }
      } finally {
        vm.dispose();
      }
    }

    // Advance savepoint to the last message after successful execution
    const allMessages = [...existingMessages, ...(lastFinalResult?.messages ?? [])];
    const finalSavepoint =
      allMessages.length > 0 ? allMessages[allMessages.length - 1].id : SAVEPOINT_START;

    // Update minion chat with totals and new savepoint (after all retries). A
    // copy: if this save throws, the catch below adds the run's totals once.
    const updatedMinionChat: MinionChat = {
      ...minionChat,
      ...chatTotalsWithRun(minionChat, totals),
      savepoint: finalSavepoint,
      pendingVerifyFeedback: undefined,
      lastModifiedAt: new Date(),
    };
    await storage.saveMinionChat(updatedMinionChat);

    const resultContent = formatMinionResult({
      returnMode,
      outputFormat,
      minionChatId: minionChat.id,
      stopReason,
      hasCoT: !!lastFinalResult?.hasCoT,
      text: accumulatedText.join('\n\n'),
      returnValue: usedReturnTool ? returnValue : undefined,
      // The new savepoint is the stored tail, so `<token>@<id>` right away is a plain continue.
      continueToken:
        continueTokensEnabled && finalSavepoint !== SAVEPOINT_START
          ? continueTokenFor(finalSavepoint)
          : undefined,
    });

    // Reaching here means the loop ended with `complete` (with or without
    // a return value) or `max_iterations` with a deferred return captured
    // before the limit hit. Both are accurate terminal states for the
    // registry — `terminalRegistryStatus` was set inside the do/while loop
    // from `lastFinalResult.status`, so no override needed.
    return {
      content: resultContent,
      renderingGroups: [infoGroup, ...accumulatedGroups],
      tokenTotals: totals,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    terminalRegistryStatus = 'error';
    return await runFailure(`Minion execution failed: ${message}`);
  } finally {
    // Tear down the parent → child cascade listener (if it ever fired,
    // it removed itself thanks to `{ once: true }`; this catches the
    // common case where the parent stayed alive). Then unregister the
    // child loop with the registry's terminal status. The order matters:
    // remove the listener first so a parent abort racing with `end()`
    // doesn't fire a no-op on an already-aborted controller.
    context.signal.removeEventListener('abort', onParentAbort);
    if (childLoopId) {
      context.loopRegistry.end(childLoopId, terminalRegistryStatus);
    }
  }
}

/**
 * Comma-joined paths for an injected-file list. Custom preamble/postamble
 * replaces the default `=== path ===` framing, which changes what the minion
 * actually sees — flag it rather than rendering the entry identically to a
 * plain path.
 */
function formatInjectPaths(files: Array<string | InjectFileSpec>): string {
  return files
    .map(file =>
      typeof file === 'string'
        ? file
        : file.preamble || file.postamble
          ? `${file.path} (framed)`
          : file.path
    )
    .join(', ');
}

/**
 * Render minion tool input for display.
 *
 * Every `MinionInput` field the caller actually passed gets a line — an
 * explicitly-passed `false` or `[]` is a real instruction ("no tools", "don't
 * nest") and reads very differently from an omitted parameter, so booleans and
 * arrays test `!== undefined` rather than truthiness. Omitted fields stay
 * absent; the display shows what was asked for, not the resolved defaults.
 */
function renderMinionInput(input: Record<string, unknown>): string {
  const minionInput = input as unknown as MinionInput;
  const lines: string[] = [];

  /** Keep one oversized prompt from swamping the rest of the call block */
  const brief = (text: string) => (text.length > 80 ? text.slice(0, 77) + '...' : text);

  if (minionInput.action === 'retry') {
    lines.push('Action: retry');
  }

  const chatRef = parseMinionChatRef(minionInput.minionChatId);
  if (chatRef.chatId !== undefined || chatRef.continueToken !== undefined) {
    const rollback = chatRef.continueToken !== undefined ? ` (from ${chatRef.continueToken})` : '';
    lines.push(`Continue: ${chatRef.chatId ?? '(no chat id)'}${rollback}`);
  }

  if (minionInput.enabledTools !== undefined) {
    lines.push(`Tools: ${minionInput.enabledTools.join(', ') || '(none)'}`);
  }

  if (minionInput.enableWeb !== undefined) {
    lines.push(`Web: ${minionInput.enableWeb ? 'enabled' : 'disabled'}`);
  }

  if (minionInput.persona) {
    lines.push(`Persona: ${minionInput.persona}`);
  }

  if (minionInput.allowNesting !== undefined) {
    lines.push(`Nesting: ${minionInput.allowNesting ? 'granted' : 'denied'}`);
  }

  if (minionInput.availablePersonas !== undefined) {
    lines.push(`Grants personas: ${minionInput.availablePersonas.join(', ') || '(none)'}`);
  }

  if (minionInput.model) {
    lines.push(`Model: ${minionInput.model}`);
  }

  if (minionInput.displayName) {
    lines.push(`Display: ${minionInput.displayName}`);
  }

  const remoteFlag = readRemoteFlag(minionInput);
  if (remoteFlag !== undefined) {
    lines.push(`Remote: ${remoteFlag ? 'human' : 'local'}`);
  }

  if (readAsyncFlag(minionInput)) {
    lines.push('Async: yes');
  }

  // A prefix is enough to tell tokens apart without spelling one out on screen.
  const remoteToken = readRemoteToken(minionInput);
  if (remoteToken) {
    lines.push(`Token: ${remoteToken.slice(0, 7)}…`);
  }

  const outputFormat = readOutputFormat(minionInput);
  if (outputFormat) {
    lines.push(`Output: ${outputFormat}`);
  }

  if (minionInput.verifyHook) {
    lines.push(`VerifyHook: ${minionInput.verifyHook}`);
  }

  if (minionInput.injectFiles?.length) {
    lines.push(`Files: ${formatInjectPaths(minionInput.injectFiles)}`);
  }

  if (minionInput.injectFilesAfter?.length) {
    lines.push(`FilesAfter: ${formatInjectPaths(minionInput.injectFilesAfter)}`);
  }

  if (minionInput.fileInjectionMode) {
    lines.push(`Injection: ${minionInput.fileInjectionMode}`);
  }

  if (minionInput.fileLineNumbers !== undefined) {
    lines.push(`LineNumbers: ${minionInput.fileLineNumbers}`);
  }

  if (minionInput.enableReasoning !== undefined) {
    lines.push(`Reasoning: ${minionInput.enableReasoning ? 'on' : 'off'}`);
  }

  if (minionInput.reasoningBudgetTokens !== undefined) {
    lines.push(`Budget: ${minionInput.reasoningBudgetTokens}`);
  }

  if (minionInput.reasoningEffort) {
    lines.push(`Effort: ${minionInput.reasoningEffort}`);
  }

  if (minionInput.thinkingKeepTurns !== undefined) {
    const keep = minionInput.thinkingKeepTurns;
    lines.push(`KeepThinking: ${keep === -1 ? 'all' : keep}`);
  }

  if (minionInput.pruneThinkingBeforeApiCall !== undefined) {
    lines.push(`PruneThinking: ${minionInput.pruneThinkingBeforeApiCall ? 'on' : 'off'}`);
  }

  if (minionInput.verbosity) {
    lines.push(`Verbosity: ${minionInput.verbosity}`);
  }

  if (minionInput.temperature !== undefined) {
    lines.push(`Temp: ${minionInput.temperature}`);
  }

  if (minionInput.maxOutputTokens !== undefined) {
    lines.push(`MaxTokens: ${minionInput.maxOutputTokens}`);
  }

  if (minionInput.systemPrompt) {
    lines.push(`Prompt: ${brief(minionInput.systemPrompt)}`);
  }

  if (minionInput.systemPromptFile) {
    const files = Array.isArray(minionInput.systemPromptFile)
      ? minionInput.systemPromptFile.join(', ')
      : minionInput.systemPromptFile;
    if (files) lines.push(`PromptFile: ${files}`);
  }

  if (minionInput.prePersonaSystemPromptFile !== undefined) {
    const prePersona = minionInput.prePersonaSystemPromptFile;
    lines.push(prePersona === '' ? 'PrePersonaFile: off' : `PrePersonaFile: ${prePersona}`);
  }

  if (minionInput.nudgeThinking !== undefined) {
    const nudge = minionInput.nudgeThinking;
    lines.push(nudge === '' ? 'Nudge: off' : `Nudge: ${brief(nudge)}`);
  }

  if (minionInput.message) {
    lines.push('');
    lines.push(minionInput.message);
  }

  return lines.join('\n');
}

/** Extract minionChatId, the continue token, the marker lines, and body from the simplified tag format */
export function parseSimplifiedOutput(output: string):
  | {
      minionChatId: string;
      continueToken?: string;
      hasCoT: boolean;
      remote: boolean;
      body: string;
    }
  | undefined {
  const match = output.match(
    /^<minionChatId>([^<]+)<\/minionChatId>\n?(?:<continueToken>([^<]+)<\/continueToken>\n?)?(<hasCoT \/>\n?)?(<remote \/>\n?)?([\s\S]*)$/
  );
  if (!match) return undefined;
  return {
    minionChatId: match[1],
    ...(match[2] !== undefined && { continueToken: match[2] }),
    hasCoT: match[3] !== undefined,
    remote: match[4] !== undefined,
    body: match[5],
  };
}

const HUMAN_ANSWER_LABEL = '[Answered by a human]';

/** Read back what `formatMinionError` wrote, in either format; undefined for a prose error. */
function parseMinionErrorOutput(
  output: string
): { error: string; minionChatId: string; continueToken?: string } | undefined {
  const tagged = output.match(
    /^([\s\S]*)\n<minionChatId>([^<]+)<\/minionChatId>(?:\n<continueToken>([^<]+)<\/continueToken>)?$/
  );
  if (tagged) {
    return {
      error: tagged[1],
      minionChatId: tagged[2],
      ...(tagged[3] !== undefined && { continueToken: tagged[3] }),
    };
  }
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { error, minionChatId, continueToken } = parsed as Record<string, unknown>;
    if (typeof error !== 'string' || typeof minionChatId !== 'string') return undefined;
    return {
      error,
      minionChatId,
      ...(typeof continueToken === 'string' && { continueToken }),
    };
  } catch {
    return undefined;
  }
}

/**
 * Render minion tool output for display
 */
function renderMinionOutput(output: string, isError?: boolean): string {
  if (isError) {
    // Same chat id / token lines as a result; prose errors stay as they are.
    const failure = parseMinionErrorOutput(output);
    if (!failure) return output;
    const lines = [failure.error, `[minionChatId: ${failure.minionChatId}]`];
    if (failure.continueToken) lines.push(`[continueToken: ${failure.continueToken}]`);
    return lines.join('\n\n');
  }

  // Simplified tag format (non-both modes)
  const simplified = parseSimplifiedOutput(output);
  if (simplified) {
    const lines: string[] = [];
    if (simplified.hasCoT) {
      lines.push('[CoT: yes]');
    }
    if (simplified.remote) {
      lines.push(HUMAN_ANSWER_LABEL);
    }
    if (simplified.body) {
      lines.push(simplified.body);
    }
    lines.push(`[minionChatId: ${simplified.minionChatId}]`);
    if (simplified.continueToken) {
      lines.push(`[continueToken: ${simplified.continueToken}]`);
    }
    return lines.join('\n\n');
  }

  // JSON format ('both' mode, outputFormat 'json', legacy)
  try {
    const parsed = JSON.parse(output);
    const lines: string[] = [];

    if (parsed.hasCoT) {
      lines.push('[CoT: yes]');
    }
    if (parsed.remote) {
      lines.push(HUMAN_ANSWER_LABEL);
    }
    if (parsed.warning) {
      lines.push(`⚠ ${parsed.warning}`);
    }
    // Same body as the tag format: the result, or the prose when nothing was returned.
    const body = parsed.result ?? parsed.text;
    if (body) {
      lines.push(body);
    }
    if (parsed.minionChatId) {
      lines.push(`[minionChatId: ${parsed.minionChatId}]`);
    }
    if (parsed.continueToken) {
      lines.push(`[continueToken: ${parsed.continueToken}]`);
    }

    return lines.join('\n\n');
  } catch {
    return output;
  }
}

/**
 * System prompt for persona discovery.
 * Lists available persona files from /minions/ when namespacedMinion is enabled.
 */
async function getMinionSystemPromptInjection(
  context: SystemPromptContext,
  opts: ToolOptions
): Promise<string> {
  if (opts.namespacedMinion === 'off' || !opts.namespacedMinion) return '';

  const mode = typeof opts.personaListingMode === 'string' ? opts.personaListingMode : 'detailed';
  if (mode === 'none') return '';

  // VFS access lives only in the worker. `createVfsAdapter` is always
  // populated by `buildLoopOptions`, which is the single production
  // constructor of `SystemPromptContext`. Anything reaching this code
  // path without one is an upstream bug — fail loudly instead of
  // silently returning an empty prompt.
  if (!context.createVfsAdapter) {
    throw new Error(
      'minionTool.getMinionSystemPromptInjection: SystemPromptContext.createVfsAdapter is required. ' +
        'VFS access is only available inside the worker — direct service-layer calls are unsupported.'
    );
  }
  const adapter = context.createVfsAdapter();

  try {
    const dirExists = await adapter.isDirectory(MINION_VFS_ROOT);
    if (!dirExists) return '';

    const entries = await adapter.readDir(MINION_VFS_ROOT);
    const allowedPersonas = context.minionAvailablePersonas
      ? new Set(context.minionAvailablePersonas)
      : undefined;
    const personaFiles = entries
      .filter(e => e.type === 'file' && e.name.endsWith('.md'))
      // When this loop has a delegation ceiling, only list personas it may use.
      .filter(e => !allowedPersonas || allowedPersonas.has(e.name.replace(/\.md$/, '')))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (personaFiles.length === 0) return '';

    const lines = ['## Available Minion Personas', ''];
    for (const file of personaFiles) {
      const name = file.name.replace(/\.md$/, '');
      if (mode === 'name-only') {
        lines.push(`- **${name}**`);
        continue;
      }
      try {
        const content = await adapter.readFile(`${MINION_VFS_ROOT}/${file.name}`);
        const firstLine = content
          .split('\n')[0]
          .replace(/^#+\s*/, '')
          .trim();
        lines.push(`- **${name}**: ${firstLine}`);
      } catch {
        lines.push(`- **${name}**`);
      }
    }
    lines.push(
      '',
      'Use the `persona` parameter when calling the minion tool to select one.',
      'Omit persona for the default minion (uses configured system prompt).'
    );
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * The remote paragraph of the tool description. The calling LLM has to know
 * the human sees nothing but this message, or it writes "fix the bug we
 * discussed" to someone who wasn't there.
 */
function getRemoteMinionDescription(opts: ToolOptions): string {
  return [
    'Remote (human) minions: remote=true sends the message to a person instead of an LLM.',
    'They see only your message and the injected files, not your conversation, VFS or tools, so make the message self-contained and set displayName to say who is asking.',
    `Answers take minutes; the call blocks for up to ${formatWaitDuration(resolveRemoteTimeoutMs(opts))}.`,
    'The minion chat stays remote: continue it with minionChatId alone (remote=false on it is an error).',
    'LLM-only parameters (model, enabledTools, enableWeb, system prompts, reasoning and sampling overrides, fileInjectionMode) are ignored, and verifyHook is rejected.',
    'If no answer arrives in time, the question is withdrawn; you can follow up with the same minionChatId.',
    'async=true posts a message the human cannot reply to and returns "Message sent." at once: use it for progress updates and FYIs.',
    'remoteToken, passed with remote=true on a new chat, sends the chat to that Touch Grass user instead of the admin; it sticks to the chat.',
  ].join(' ');
}

/** Build minion tool description, conditionally including web search and retry bullets. */
function getMinionDescription(opts: ToolOptions): string {
  const remoteEnabled = isRemoteConfigured(opts);
  const lines = [
    remoteEnabled
      ? 'Delegate a task to a minion: an LLM sub-agent, or a human operator with remote=true. An LLM minion runs independently with its own agentic loop and can use a subset of available tools. Use this to parallelize work or delegate specific tasks.'
      : 'Delegate a task to a minion sub-agent. The minion runs independently with its own agentic loop and can use a subset of available tools. Use this to parallelize work or delegate specific tasks.',
    '',
    'The minion will execute the task and return the result. You can optionally:',
    '- Continue a previous minion conversation by providing minionChatId',
  ];

  if (opts.autoRollback === true) {
    lines.push(
      '- If a previous run failed, the minion automatically recovers on next continuation.'
    );
  } else {
    lines.push(
      '- Retry the last run by setting action to "retry" with the same minionChatId. Omit message to re-send the original, or provide a new message to replace it.'
    );
  }

  if (opts.continueTokens === true) {
    // Refusals carry no token: they leave the chat on the caller's last one.
    const tokenNote =
      opts.autoRollback === true
        ? 'Each successful result carries a continueToken for the chat state right after it.'
        : 'Each result carries a continueToken for the chat state right after it, and so does an error from a run that started; an error without one changed nothing, so your last token still holds.';
    lines.push(
      `- ${tokenNote} Pass "<continueToken>@<minionChatId>" as minionChatId to continue from that point; anything after it is dropped (settings you changed since stay changed; re-pass any that should differ).${isRemoteConfigured(opts) ? ' LLM minion chats only.' : ''}`
    );
  }

  if (opts.allowWebSearch === true) {
    lines.push('- Enable web search for the minion via enableWeb');
  }

  lines.push(
    '- Specify which tools the minion can use via enabledTools (must be a subset of project tools; defaults to none)',
    '- Provide a displayName to label this minion in the UI',
    '- Inject file context via injectFiles (array of VFS paths, or objects with path + optional preamble/postamble replacing the default framing). Contents are prepended to the message.',
    '- Use injectFilesAfter for the same thing with the contents appended after the message instead',
    '- message may be omitted when injectFiles / injectFilesAfter carry the whole task: the file content becomes the message',
    '- Provide a verifyHook (name of a /hooks/<name>.js file) to validate minion output before savepoint advances. The hook returns null to approve or a string to reject.'
  );

  if (opts.namespacedMinion && opts.namespacedMinion !== 'off') {
    lines.push(
      '- Select a persona via the persona parameter. Each persona gets its own isolated VFS namespace and system prompt from /minions/<name>.md'
    );

    // Check if models list is configured
    const modelsList = opts.models;
    if (isModelReferenceArray(modelsList) && modelsList.length > 0) {
      lines.push(
        '- Select a model via the model parameter. Available models are listed in the schema enum.'
      );
    }
  }

  if (remoteEnabled) {
    lines.push('- Set remote=true to ask a human operator instead (see below)');
  }

  if (resolveReturnMode(opts) !== 'no-return') {
    lines.push(
      '',
      remoteEnabled
        ? "An LLM minion always has access to a 'return' tool to explicitly signal completion with a result."
        : "The minion always has access to a 'return' tool to explicitly signal completion with a result."
    );
  }

  if (remoteEnabled) {
    lines.push('', getRemoteMinionDescription(opts));
  }

  return lines.join('\n');
}

/** Build minion input schema, conditionally including enableWeb and action properties. */
function getMinionInputSchema(opts: ToolOptions): ToolInputSchema {
  const properties: Record<string, unknown> = {};

  // Omit action when autoRollback is on — caller doesn't see the retry option
  if (opts.autoRollback !== true) {
    properties.action = {
      type: 'string',
      enum: ['message', 'retry'],
      description:
        'Action to perform. "message" (default) sends a new message. "retry" rolls back the minion chat to the last savepoint and re-executes.',
    };
  }

  const continueTokens = opts.continueTokens === true;
  properties.minionChatId = {
    type: 'string',
    description: continueTokens
      ? `Optional: ID of an existing minion chat to continue the conversation. Or "<continueToken>@<minionChatId>", with a continueToken from an earlier result, to continue from that point, dropping anything after it. Needs message or inject files${opts.autoRollback === true ? '' : ', and no action "retry"'}. Settings you changed since stay changed; re-pass any that should differ.`
      : 'Optional: ID of an existing minion chat to continue the conversation',
  };
  properties.message = {
    type: 'string',
    description:
      'The task or message to send to the minion. Required for "message" action unless injectFiles / injectFilesAfter carry the whole task (their content becomes the message). For "retry": omit to re-send the original, or provide a new message to replace it.',
  };
  properties.enabledTools = {
    type: 'array',
    items: { type: 'string' },
    description:
      "Tools to enable for the minion (must be subset of project tools). The 'minion' tool is granted via the separate `allowNesting` parameter, not by listing it here. Defaults to none — specify tools explicitly.",
  };
  properties.displayName = {
    type: 'string',
    description:
      'Display name shown in the UI for this minion call. If omitted, persona name is used.',
  };
  const injectFileItemsSchema = {
    anyOf: [
      { type: 'string' },
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'VFS file path' },
          preamble: {
            type: 'string',
            description: 'Text placed before the file content, replacing the default framing',
          },
          postamble: {
            type: 'string',
            description: 'Text placed after the file content, replacing the default framing',
          },
        },
        required: ['path'],
      },
    ],
  };
  properties.injectFiles = {
    type: 'array',
    items: injectFileItemsSchema,
    description:
      'VFS files to inject as context, prepended to the message. Each item is a path string (default "=== path ===" framing), or an object with path plus optional preamble/postamble that replace the default framing (joined to the content with newlines).',
  };
  properties.injectFilesAfter = {
    type: 'array',
    items: injectFileItemsSchema,
    description:
      'VFS files to inject as context, appended after the message instead of before it. Same item shape as injectFiles. Use it to put instructions first and the reference material last.',
  };
  properties.verifyHook = {
    type: 'string',
    description:
      'Name of a hook file in /hooks/ (without .js) that verifies minion output before savepoint advances. The hook must return a function(messages). Return null to approve, or a string error message to reject.',
  };
  // 'both' already answers in JSON with text and result side by side, which
  // the tag format can't hold.
  if (resolveReturnMode(opts) !== 'both') {
    properties.outputFormat = {
      type: 'string',
      enum: ['text', 'json'],
      description: `Format of the result you get back. "text" (default): a <minionChatId> tag line${continueTokens ? ' and a <continueToken> tag line' : ''}, then the result. "json": one JSON object with minionChatId, ${continueTokens ? 'continueToken, ' : ''}stopReason and hasCoT, plus whichever of result (the returned value), warning or text (the prose) applies. Persisted on the minion chat.`,
    };
  }

  if (opts.allowWebSearch === true) {
    properties.enableWeb = {
      type: 'boolean',
      description: 'Enable web search for the minion (default: false)',
    };
  }

  if (opts.namespacedMinion && opts.namespacedMinion !== 'off') {
    properties.persona = {
      type: 'string',
      description:
        'Persona name for the minion (matches a file in /minions/). Omit for default persona.',
    };

    properties.prePersonaSystemPromptFile = {
      type: 'string',
      description:
        'Override the VFS path of the pre-persona prompt file read before the persona prompt (default /minions/_global.md). Empty string disables it. Persisted on the minion chat.',
    };

    // Add model enum when models list is configured
    const modelsList = opts.models;
    if (isModelReferenceArray(modelsList) && modelsList.length > 0) {
      const modelStrings = modelsList.map(formatModelString);
      properties.model = {
        type: 'string',
        enum: modelStrings,
        description: 'Model to use for this minion call. Omit to use the default minion model.',
      };
    }

    // Persona delegation allowlist — only meaningful when this minion can nest.
    if (opts.allowNesting === true) {
      properties.availablePersonas = {
        type: 'array',
        items: { type: 'string' },
        description:
          'Personas the spawned minion may delegate to when it spawns its own sub-minions. Must be a subset of the personas you yourself may delegate to. Omit to grant the full set you hold.',
      };
    }
  }

  // Per-call nesting grant — only when the project allows nesting at all.
  if (opts.allowNesting === true) {
    properties.allowNesting = {
      type: 'boolean',
      description:
        'Grant the spawned minion the ability to spawn its own sub-minions (default false). Subject to the project nesting cap.',
    };
  }

  if (isRemoteConfigured(opts)) {
    properties.remote = {
      type: 'boolean',
      description: `Ask a human operator instead of an LLM sub-agent. Set it when starting a new minion chat; a remote chat stays remote, so omit it on continuations. The human sees only message + injected files, and the call blocks for up to ${formatWaitDuration(resolveRemoteTimeoutMs(opts))}.`,
    };
    properties.async = {
      type: 'boolean',
      description:
        'Remote (human) chats only: post the message without waiting for an answer. The human sees it but cannot reply to it, and the call returns "Message sent." right away. Good for progress updates.',
    };
    properties.remoteToken = {
      type: 'string',
      description:
        'Remote chats only, set with remote=true on a new chat: the Touch Grass user token whose inbox gets this conversation. Sticks to the chat; omit on continuations. Without it the question goes to the admin.',
    };
  }

  // Reasoning overrides
  properties.enableReasoning = {
    type: 'boolean',
    description: 'Override reasoning on/off (default: use project setting)',
  };
  properties.reasoningBudgetTokens = {
    type: 'number',
    description: 'Override reasoning budget tokens. 0 = adaptive mode on supported models.',
  };
  properties.reasoningEffort = {
    type: 'string',
    enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    description: 'Override reasoning effort level',
  };
  properties.verbosity = {
    type: 'string',
    enum: ['low', 'medium', 'high'],
    description:
      "Override how long the minion's answer is, independent of maxOutputTokens and reasoning effort. OpenAI GPT-5-era models only; ignored elsewhere. Persisted on the minion chat.",
  };
  properties.temperature = {
    type: 'number',
    description: 'Override temperature (default: use project setting)',
  };
  properties.maxOutputTokens = {
    type: 'number',
    description: 'Override max output tokens for this minion call (default: use project setting).',
  };
  properties.fileInjectionMode = {
    type: 'string',
    enum: ['inline', 'separate-block', 'as-file', 'mock-tool-call'],
    description: 'Override how injected files are sent to the minion',
  };
  properties.fileLineNumbers = {
    type: 'boolean',
    description:
      "Override line-number display for this minion: true shows line numbers, false strips them, omit to use the project setting. Applies to injected files and to the minion's own filesystem/memory reads (a per-read withLineNumbers still wins).",
  };
  properties.systemPrompt = {
    type: 'string',
    description: 'Additional system prompt text, appended after persona/configured prompt.',
  };
  properties.systemPromptFile = {
    anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    description:
      'VFS file path(s) to system prompt file(s). Pass a single string, or an array of strings to stitch multiple fragments in order. Contents are appended after systemPrompt, joined with blank lines.',
  };
  properties.nudgeThinking = {
    type: 'string',
    description:
      'Optional text appended to the last user message to nudge chain-of-thought (e.g., "<<WITH THINKING STEPS>>"). Pass an empty string to disable. Use this to experiment with different phrasings when a model skips reasoning.',
  };
  properties.thinkingKeepTurns = {
    type: 'number',
    description:
      'Override how many recent user turns of thinking blocks to keep. -1 = all, 0+ = keep exactly N turns from the end. Persisted on the minion chat for continuations.',
  };
  properties.pruneThinkingBeforeApiCall = {
    type: 'boolean',
    description:
      "When true (and thinkingKeepTurns is set to 0 or higher), strip older thinking blocks client-side before the API call. Useful for continuing a minion chat without resending the prior agentic run's thinking. Persisted on the minion chat.",
  };

  return {
    type: 'object',
    properties,
    required: [],
  };
}

/**
 * Minion tool definition.
 *
 * Allows the primary chat LLM to delegate tasks to a sub-agent that runs
 * its own agentic loop with scoped tools.
 */
export const minionTool: ClientSideTool = {
  name: 'minion',
  displayName: 'Minion',
  displaySubtitle: 'Delegate tasks to a sub-agent',
  claudeAgentBridgeable: true,
  complex: true,
  parallelThrottleMs: 2000,
  // Scope the 2s stagger to one upstream API definition: parallel minions on the
  // same apiDefinitionId space out, but minions on different definitions (whether
  // a different provider or just a different account/key) all launch immediately.
  async getParallelThrottleGroup(input, toolOptions, context) {
    const { chatId } = parseMinionChatRef(input.minionChatId);
    const minionChat = chatId ? await context.storage.getMinionChat(chatId) : undefined;
    // Humans don't share an LLM provider's rate limit, so remote calls stay out
    // of the apiDefinition groups (they still space out among themselves).
    if (isRemoteCall(input) || (minionChat && isRemoteMinionChat(minionChat))) {
      return 'minion:__remote__';
    }
    const ref = resolveMinionModelRef(input, minionChat, toolOptions);
    return ref ? `minion:${ref.apiDefinitionId}` : 'minion:__default__';
  },
  description: getMinionDescription,
  inputSchema: getMinionInputSchema,
  systemPrompt: getMinionSystemPromptInjection,

  iconInput: '🤖',
  iconOutput: '🤖',

  optionDefinitions: [
    {
      type: 'longtext',
      id: 'systemPrompt',
      label: 'Minion System Prompt',
      subtitle: 'Instructions for minion sub-agents',
      default: '',
      placeholder: 'Instructions for minion agents...',
    },
    {
      type: 'model',
      id: 'model',
      label: 'Minion Model',
      subtitle: 'Model for delegated tasks (can use cheaper model)',
    },
    {
      type: 'modellist',
      id: 'models',
      label: 'Available Models',
      subtitle: 'Models the LLM can choose from when calling minions (namespaced mode)',
    },
    {
      type: 'boolean',
      id: 'disableReasoning',
      label: 'Disable Reasoning',
      subtitle: 'Turn off reasoning/thinking for minion calls regardless of project settings',
      default: false,
    },
    {
      type: 'boolean',
      id: 'allowWebSearch',
      label: 'Allow Web Search',
      subtitle: 'Let minions use web search when requested',
      default: false,
    },
    {
      type: 'boolean',
      id: 'allowNesting',
      label: 'Allow Nested Minions',
      subtitle: 'Let a minion spawn its own sub-minions (off by default)',
      default: false,
    },
    {
      type: 'number',
      id: 'maxNestingDepth',
      label: 'Max Nesting Depth',
      subtitle: 'Hard cap on how deep minions can nest (1 = no nesting)',
      default: DEFAULT_MAX_NESTING_DEPTH,
      min: 1,
      visibleWhen: { optionId: 'allowNesting', value: true },
    },
    {
      type: 'boolean',
      id: 'autoRollback',
      label: 'Auto Rollback',
      subtitle: 'Automatically roll back previously failed interactions on next continuation',
      default: false,
    },
    {
      type: 'boolean',
      id: 'verifyFeedback',
      label: 'Verify Feedback',
      subtitle:
        'Append the verify-hook rejection reason to the retried message so the minion can correct itself',
      default: false,
    },
    {
      type: 'boolean',
      id: 'continueTokens',
      label: 'Continue Tokens',
      subtitle:
        'Give each result a token the caller can pass back to continue the minion chat from that point',
      default: false,
    },
    {
      type: 'select',
      id: 'namespacedMinion',
      label: 'Namespace',
      subtitle: 'Isolate minion personas into VFS namespaces',
      default: 'off',
      choices: [
        { value: 'off', label: 'Off' },
        { value: 'persona', label: 'Persona' },
        { value: 'all', label: 'All' },
      ],
      migrateFrom: [{ optionId: 'namespacedMinion', whenTrue: 'all' }],
    },
    {
      type: 'select',
      id: 'personaListingMode',
      label: 'Persona Listing',
      subtitle: 'How personas are described in the system prompt',
      default: 'detailed',
      choices: [
        { value: 'detailed', label: 'Detailed' },
        { value: 'name-only', label: 'Name Only' },
        { value: 'none', label: 'None' },
      ],
      visibleWhen: { optionId: 'namespacedMinion', value: ['persona', 'all'] },
    },
    {
      type: 'select',
      id: 'returnMode',
      label: 'Return Mode',
      subtitle: 'How minion output is captured',
      default: 'both',
      choices: [
        { value: 'no-return', label: 'No Return' },
        { value: 'both', label: 'Both' },
        { value: 'return-only', label: 'Return Only' },
        { value: 'enforced', label: 'Enforced' },
        { value: 'auto-enforced', label: 'Auto Enforced' },
      ],
      migrateFrom: [
        { optionId: 'noReturnTool', whenTrue: 'no-return' },
        { optionId: 'returnOnly', whenTrue: 'return-only' },
      ],
    },
    {
      type: 'text',
      id: 'returnEnforceMessage',
      label: 'Auto-Enforce Reminder',
      subtitle: 'Message sent when auto-enforced mode retries because return was not called',
      default: '',
      placeholder:
        'You have not used the return tool to respond. Please put your response in the return tool call.',
      visibleWhen: { optionId: 'returnMode', value: 'auto-enforced' },
    },
    {
      type: 'select',
      id: 'deferReturn',
      label: 'Deferred Return',
      subtitle: 'How the return tool interacts with the agentic loop',
      default: 'no',
      choices: [
        { value: 'no', label: 'No' },
        { value: 'auto-ack', label: 'Auto Ack' },
        { value: 'free-run', label: 'Free Run' },
      ],
      migrateFrom: [{ optionId: 'deferReturn', whenTrue: 'free-run' }],
      visibleWhen: {
        optionId: 'returnMode',
        value: ['both', 'return-only', 'enforced', 'auto-enforced'],
      },
    },
    {
      type: 'number',
      id: 'deferredSoftStopRounds',
      label: 'Soft Stop Rounds',
      subtitle: 'Rounds after deferred return before injecting stop messages',
      default: 5,
      min: 0,
      visibleWhen: { optionId: 'deferReturn', value: 'free-run' },
    },
    {
      type: 'number',
      id: 'deferredForceStopRounds',
      label: 'Force Stop Rounds',
      subtitle: 'Rounds after deferred return before force-stopping the loop',
      default: 10,
      min: 0,
      visibleWhen: { optionId: 'deferReturn', value: 'free-run' },
    },
    {
      type: 'text',
      id: 'returnAckMessage',
      label: 'Return Accepted',
      subtitle: 'Tool result message sent when return stores a result',
      default: '',
      placeholder: 'Recorded. Stop and user will call you back.',
      visibleWhen: { optionId: 'deferReturn', value: ['auto-ack', 'free-run'] },
    },
    {
      type: 'text',
      id: 'autoAckMessage',
      label: 'Acknowledge Message',
      subtitle: 'Assistant text appended after return to create a clean conversation boundary',
      default: '',
      placeholder: 'Will do.',
      visibleWhen: { optionId: 'deferReturn', value: 'auto-ack' },
    },
    {
      type: 'text',
      id: 'returnDuplicateMessage',
      label: 'Return Already Stored',
      subtitle: 'Error sent when return is called again after a result is stored',
      default: '',
      placeholder:
        'The previous return has been recorded already. Please stop and user will call back.',
      visibleWhen: { optionId: 'deferReturn', value: 'free-run' },
    },
    {
      type: 'select',
      id: 'fileInjectionMode',
      label: 'File Injection Mode',
      subtitle: 'How injected files are sent to the minion LLM',
      default: 'inline',
      choices: [
        { value: 'inline', label: 'Inline' },
        { value: 'separate-block', label: 'Separate Blocks' },
        { value: 'as-file', label: 'Document Blocks' },
        { value: 'mock-tool-call', label: 'Mock Tool Call' },
      ],
    },
    {
      type: 'text',
      id: 'remoteEndpoint',
      label: 'Remote Minion Endpoint',
      subtitle: 'URL of the Touch Grass backend for human delegation',
      default: '',
      placeholder: 'http://localhost:3004',
    },
    {
      type: 'text',
      id: 'remotePassword',
      label: 'Remote Minion Password',
      subtitle: 'API password for the remote backend',
      default: '',
      placeholder: 'shared-secret',
      secret: true,
    },
    {
      type: 'number',
      id: 'remoteTimeoutMs',
      label: 'Remote Timeout (ms)',
      subtitle: 'Total time to wait for a human response before giving up',
      default: 600000,
      min: 10000,
    },
  ],

  execute: executeMinion,
  renderInput: renderMinionInput,
  renderOutput: renderMinionOutput,
};
