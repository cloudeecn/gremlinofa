export type { StorageConfig } from './storageConfig';
export type { BundleFileEntry, ProjectBundle } from './projectBundle';

// Re-export content types for convenience
export type {
  MessageStopReason,
  BlockCategory,
  RenderingBlockGroup,
  RenderingContentBlock,
  ThinkingRenderBlock,
  TextRenderBlock,
  WebSearchRenderBlock,
  WebSearchResult,
  WebFetchRenderBlock,
  ToolInfoRenderBlock,
  ErrorRenderBlock,
  ToolResultStatus,
  ToolResultRenderBlock,
  TokenTotals,
} from './content';
export { categorizeBlock, groupAndConsolidateBlocks } from './content';
import type { RenderingBlockGroup, MessageStopReason } from './content';

import type Anthropic from '@anthropic-ai/sdk';
import type { ChatCompletionTool } from 'openai/resources/index.mjs';
import type OpenAI from 'openai';
import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';

export type APIType =
  | 'anthropic'
  | 'chatgpt'
  | 'responses_api'
  | 'bedrock'
  | 'google'
  | 'claude-agent'
  | 'ds01-dummy-system';

/** Type-safe tool definition overrides for each API type */
export interface APIToolOverrides {
  anthropic?: Anthropic.Beta.BetaToolUnion;
  chatgpt?: ChatCompletionTool;
  responses_api?: OpenAI.Responses.Tool;
  bedrock?: BedrockTool;
  google?: unknown;
  'claude-agent'?: Anthropic.Beta.BetaToolUnion;
}

export interface APIDefinition {
  id: string;
  apiType: APIType;
  name: string; // User-given display name (e.g., "xAI", "My OpenAI")
  baseUrl: string; // Empty means use apiType default
  apiKey: string;
  icon?: string; // Custom emoji icon (defaults to apiType icon)
  isDefault?: boolean; // Mark as default (non-deletable) definition
  isLocal?: boolean; // Local provider - API key is optional (e.g., Ollama, LM Studio)
  modelsEndpoint?: string; // Custom endpoint for fetching models list (no auth)
  modelsEndpointDisabled?: boolean; // Skip model discovery — only use extraModelIds
  proxyUrl?: string; // CORS proxy URL — when set, SDK traffic routes through this proxy
  proxyAuthToken?: string; // Shared secret sent as X-Proxy-Auth to the CORS proxy (its own auth, not the provider key)
  extraModelIds?: string[]; // Manually-added model IDs not returned by provider discovery
  advancedSettings?: {
    pruneThinking?: boolean; // Strip thinking/reasoning blocks from messages before latest user message
    pruneEmptyText?: boolean; // Strip empty text blocks from messages before latest user message
    isSubscription?: boolean; // Flat-rate subscription — all cost tracked as $0
    enforceGenuineAnthropic?: boolean; // Reject responses with zero cache activity or unsigned thinking blocks
    deFactoThinking?: boolean; // Send { thinking: { type: "enabled" | "disabled" } } in request body (DeepSeek, Kimi, MiMo, etc.)
    nudgeThinking?: boolean; // Append "<<WITH THINKING STEPS>>" to last user message
    mandateCoT?: boolean; // Reject responses without chain-of-thought reasoning tokens
    treatEmptyOutputAsError?: boolean; // Reject turns that produce empty text and no tool calls
    useStreamAccumulator?: boolean; // Build result from stream events instead of stream.finalResponse() — for Responses API providers that return empty finalResponse
    // Provider accepts the flex/batch service tier param (OpenAI service_tier,
    // Gemini serviceTier). When false (default), the project's flex toggle is a
    // no-op for this provider so we don't send unknown fields to compatible APIs
    // (Doubao, DeepSeek, aihubmix, etc.) that may error or silently drop them.
    flexTierSupported?: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Reasoning mode classification for models
 */
export type ModelReasoningMode =
  | 'always' // o-series, grok-4: reasoning can't be disabled
  | 'optional' // gpt-5, grok-3-mini: user can toggle via params
  | 'none'; // Most models, gpt-5-chat, grok-4-non-reasoning

export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | undefined;
export type ReasoningSummary = 'auto' | 'concise' | 'detailed' | undefined;

/**
 * Anthropic-specific reasoning configuration
 */
export type AnthropicReasoningMode =
  | 'budget-based' // Uses budget_tokens parameter
  | 'none'; // No reasoning support

/**
 * Comprehensive model metadata including pricing, capabilities, and provider-specific quirks
 */
export interface ModelMetadata {
  // === Context & Limits ===
  /** Max input context window in tokens */
  contextWindow?: number;

  /** Max output/completion tokens */
  maxOutputTokens?: number;

  /** Whether the model supports 1M extended context window (Anthropic beta) */
  supportsExtendedContext?: boolean;

  // === Pricing (per 1M tokens in USD, or per-unit for images/requests). 0 means free, undefined means unable to find data ===

  /** Input/prompt token price per 1M tokens */
  inputPrice?: number;

  /** Output/completion token price per 1M tokens */
  outputPrice?: number;

  /** Cached input read price per 1M tokens */
  cacheReadPrice?: number;

  /** Cache write price per 1M tokens */
  cacheWritePrice?: number;

  /** Internal reasoning token price per 1M tokens */
  reasoningPrice?: number;

  /** Per web search request price in USD */
  webSearchPrice?: number;

  /** Per-request base price in USD (e.g., Perplexity charges per request) */
  requestPrice?: number;

  // === Reasoning Capabilities ===
  /**
   * Reasoning mode classification
   * - 'always': Model always reasons, can't be disabled (o-series, grok-4)
   * - 'optional': Reasoning can be toggled via parameters (gpt-5, grok-3-mini)
   * - 'none': No reasoning support (most models)
   */
  reasoningMode?: ModelReasoningMode;

  /**
   * Supported reasoning effort levels for OpenAI/xAI models
   * Used by mapReasoningEffort() to validate/map user-specified effort
   * Examples:
   * - o-series: ['low', 'medium', 'high']
   * - gpt-5: ['minimal', 'low', 'medium', 'high']
   * - gpt-5.1/5.2: ['none', 'minimal', 'low', 'medium', 'high']
   * - grok-3-mini: ['low', 'high']
   */
  supportedReasoningEfforts?: ReasoningEffort[];

  /** Uses de facto { thinking: { type: "enabled" | "disabled" } } parameter (DeepSeek, MiMo, Kimi, etc.) */
  deFactoThinking?: boolean;

  // === Feature Support ===
  /** Accepts temperature parameter (some reasoning models ignore it) */
  supportsTemperature?: boolean;

  /** Supports adaptive reasoning (thinking: { type: 'adaptive' }) — Anthropic Opus 4.6, Sonnet 4.6+ */
  supportsAdaptiveReasoning?: boolean;

  /** When true, adaptive mode is forced regardless of `reasoningBudgetTokens` — Anthropic Opus 4.7+. */
  onlyAdaptiveReasoning?: boolean;

  /** Accepts `xhigh` as a distinct output_config.effort value (between `high` and `max`) — Anthropic Opus 4.7+. */
  supportsXhighEffort?: boolean;

  /** Supports function/tool calling */
  supportsTools?: boolean;
}

export interface ModelKnowledge extends ModelMetadata {
  /* Conditions to match a api / model pair to the metadata. it is interpret like or - and - or condition structure:
     1. If a model
     
     If a model's Id matched any of the conditions in this matches field, it is considered matching this metadata
     2. 
  */
  matches: {
    apiType: APIType[]; // Any of the apiType (usually for ChatGPT compatible apis, which usually support both chat-completions and responses)
    endpoint?: Array<RegExp | string>; // Any of the RegExp matches the endpoint,
    modelIdExact?: string[]; // modelId any of the string. Array is used so modelAlias is supported for example ["opus", "claude-opus-4-5-20251101"]
    modelIdFuzz?: {
      modelIdPrefix?: string;
      modelIdPostfix?: string;
      unreliable?: boolean;
    }[];
  }[];
}

export interface Model extends ModelMetadata {
  id: string;
  name: string;
  apiType: APIType;

  matchedMode?: 'exact' | 'fuzz' | 'unreliable' | 'default';
  /** Base model ID for providers with aliasing (e.g., Bedrock inference profiles) */
  baseModelId?: string;
  /** Region codes for Bedrock cross-region inference profiles (e.g., ["us-east-1", "us-west-2"]) */
  region?: string[];
}

// Project types
export interface Project {
  id: string;
  name: string;
  icon?: string; // Emoji
  createdAt: Date;
  lastUsedAt: Date;
  systemPrompt: string;
  preFillResponse: string;
  apiDefinitionId: string | null; // null = not configured
  modelId: string | null; // null = not configured
  webSearchEnabled: boolean;
  temperature: number | null;
  maxOutputTokens: number;
  // Anthropic reasoning
  enableReasoning: boolean;
  reasoningBudgetTokens: number;
  thinkingKeepTurns?: number; // undefined = model default, -1 = "all", 0+ = keep N turns
  // Client-side counterpart to `thinkingKeepTurns`. When true AND
  // `thinkingKeepTurns` is set to a number >= 0, strip thinking blocks older
  // than the N-th-from-last user text msg locally before calling the API.
  // No effect if `thinkingKeepTurns` is undefined or -1.
  pruneThinkingBeforeApiCall?: boolean;
  // OpenAI/Responses API reasoning
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; // undefined = auto
  reasoningSummary?: 'auto' | 'concise' | 'detailed'; // undefined = auto
  // Message metadata settings
  sendMessageMetadata?: boolean | 'template';
  metadataTimestampMode?: 'utc' | 'local' | 'relative' | 'disabled';
  metadataIncludeModelName?: boolean;
  metadataIncludeContextWindow?: boolean;
  metadataIncludeCost?: boolean;
  metadataTemplate?: string;
  metadataNewContext?: boolean;

  // Tool configuration (new unified format)
  enabledTools?: string[]; // ['memory', 'javascript', 'filesystem']
  toolOptions?: Record<string, ToolOptions>; // Per-tool options, e.g., { memory: { useSystemPrompt: true } }

  // Disable streaming (use non-streaming API calls)
  disableStream?: boolean;
  // Extended context window (1M tokens, Anthropic beta)
  extendedContext?: boolean;
  // Use 1h cache TTL on Anthropic cache_control breakpoints (default 5m).
  // Only honored when apiType === 'anthropic'.
  useAnthropicOneHourCache?: boolean;
  // Strip line numbers from filesystem/memory tool output
  noLineNumbers?: boolean;
  // Scope for the per-request cache-routing key (OpenAI `prompt_cache_key`,
  // Anthropic `metadata.user_id`). 'project' (default) maximizes cache hits
  // across every chat in the project; 'chat' isolates routing per chat —
  // including each minion sub-loop, since they run with their own chatId.
  cacheRoutingScope?: 'project' | 'chat';
  // Opt into the provider's discounted/lower-priority service tier when supported.
  // Honored only when the active APIDefinition has advancedSettings.flexTierSupported.
  // OpenAI: sets `service_tier: 'flex'`. Gemini: sets `serviceTier: 'flex'`.
  // Cost calc applies a 0.5× token-price multiplier when active.
  flexTierEnabled?: boolean;
  // Remote VFS configuration
  remoteVfsUrl?: string; // URL of remote VFS backend
  remoteVfsPassword?: string; // Server-wide password
  /** @deprecated E2E encryption removed — kept for migration reads */
  remoteVfsEncrypt?: boolean;
}

// Chat pending state types
export interface ChatPendingState {
  type: 'userMessage' | 'forkMessage';
  content: {
    message: string;
    attachments?: MessageAttachment[]; // Processed attachments (base64)
  };
}

// Chat types
export interface Chat {
  id: string;
  projectId: string;
  name: string;
  summary?: string;
  createdAt: Date;
  lastModifiedAt: Date;
  // Overrides (null = use project default)
  apiDefinitionId: string | null;
  modelId: string | null;
  //
  messageCount?: number;
  // Cumulative totals (never decrease, even when messages deleted)
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalReasoningTokens?: number;
  totalCacheCreationTokens?: number;
  totalCacheReadTokens?: number;
  totalCost?: number;
  // Cumulative totals for minion (sub-agent) costs only
  minionTotalInputTokens?: number;
  minionTotalOutputTokens?: number;
  minionTotalReasoningTokens?: number;
  minionTotalCacheCreationTokens?: number;
  minionTotalCacheReadTokens?: number;
  minionTotalCost?: number;
  // Current context window usage (recalculated, can decrease)
  contextWindowUsage?: number;
  // True if any message has unreliable cost calculation
  costUnreliable?: boolean;
  // Fork tracking
  isForked?: boolean;
  forkedFromChatId?: string;
  forkedFromMessageId?: string; // Original message ID where fork occurred
  forkedAtMessageId?: string; // New message ID in this chat (last copied message)
  // Pending state for deferred operations
  pendingState?: ChatPendingState;
  // Checkpoint message ID for context tidy (legacy single ID, migrated to array)
  checkpointMessageId?: string;
  // Checkpoint message IDs for context tidy (accumulated per checkpoint call)
  checkpointMessageIds?: string[];
  // DUMMY System: active hook file name (e.g., 'auto-search')
  activeHook?: string;
  /**
   * Claude Agent SDK session ID (UUID v4). Set on first claude-agent turn.
   * Presence locks the chat to claude-agent — provider switching disabled,
   * edit/fork hidden in UI. See development.md "Claude Agent provider".
   */
  claudeAgentSessionId?: string;
  /**
   * SDK assistant message UUID to rewind to on next user send (via
   * resumeSessionAt). Set by rollback UI / verifyHook-driven retry; cleared
   * once the SDK has accepted the rewind.
   */
  claudeAgentResumeAt?: string;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export interface MessageContent<T> {
  type: 'text';
  content: string; // Pure text for display (from StreamResult.textContent)
  modelFamily?: APIType; // Which API created this message
  fullContent?: T; // Provider-specific blocks (for caching/replay)
  /**
   * Pre-extracted tool_use blocks. Populated backend-side at every point a
   * message crosses the protocol boundary (`message_created` events,
   * `attachChat` snapshot phase, persisted reads). The frontend reads this
   * field instead of re-running the provider-specific parser at render time
   * — Phase 1.8 leak fix to keep `extractToolUseBlocks` and the API client
   * shapes off the React render path.
   *
   * Distinct from `toolCalls`: that field stores the *cross-model
   * reconstruction* on assistant messages saved by the agentic loop, while
   * `toolUseBlocks` is whatever the active provider response actually
   * contains. The frontend prefers `toolUseBlocks ?? toolCalls ?? []`.
   *
   * Computed fresh, never persisted — `GremlinServer` strips this field
   * before storage writes via `prepareMessageForWire` so the canonical row
   * format stays unchanged.
   */
  toolUseBlocks?: ToolUseBlock[];
  toolCalls?: ToolUseBlock[]; // Model-agnostic tool_use blocks (for cross-model reconstruction)
  toolResults?: ToolResultBlock[]; // Model-agnostic tool_result blocks (for cross-model reconstruction)
  renderingContent?: RenderingBlockGroup[]; // Pre-grouped blocks for UI rendering
  attachmentIds?: string[]; // References to attachment records
  originalAttachmentCount?: number; // Number of attachments when message was sent (for tracking deleted attachments)
  stopReason?: MessageStopReason; // Why message ended (end_turn, max_tokens, etc.)
  injectedFiles?: Array<{ path: string; content: string }>; // Files for API-client-level block construction
  injectionMode?: 'inline' | 'separate-block' | 'as-file'; // How API client should render injectedFiles
}

// Attachment types
export interface MessageAttachment {
  id: string;
  type: 'image';
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string; // base64 encoded image data
}

export interface MessageMetadata {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  webSearchCount?: number;

  // Feature 1: Pricing - total cost calculated at message creation time
  messageCost?: number; // Total calculated cost at message time
  contextWindow?: number; // Model's max context window in tokens
  contextWindowUsage?: number; // Model's context window usage in tokens
  costUnreliable?: boolean; // True if cost calculation may be inaccurate
  /** Claude Agent SDK message UUID — target for resumeSessionAt rewinds. */
  claudeAgentMessageUuid?: string;
}

export interface Message<T> {
  id: string;
  role: MessageRole;
  content: MessageContent<T>;
  timestamp: Date;
  metadata?: MessageMetadata;
  attachments?: MessageAttachment[]; // Loaded from storage when needed for API calls
  /**
   * True for assistant messages synthesized by the agentic loop's abort path
   * — the model was streaming when the user hard-aborted, and we kept the
   * partial output for display only. Chats whose last message is `incomplete`
   * are locked from continuation until the user resolves the tail (delete
   * the message or roll back to a checkpoint). Enforced via
   * `assertChatNotLockedByIncompleteTail()`.
   */
  incomplete?: boolean;
}

// UI types
export interface TokenUsage {
  input: number;
  output: number;
  reasoning?: number;
  cacheCreation?: number;
  cacheRead?: number;
  cost?: number;
}

// Attachment Manager types
export interface AttachmentInfo {
  id: string;
  messageId: string;
  timestamp: Date;
}

export interface AttachmentSection {
  chatId: string;
  chatName: string;
  chatTimestamp: Date;
  projectId: string;
  projectName: string;
  projectIcon: string;
  attachments: AttachmentInfo[];
}

// Client-side tool types
export interface ToolUseBlock {
  type: 'tool_use';
  id: string; // toolu_xxxx
  name: string; // e.g., 'memory', 'ping'
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  name?: string;
  content: string;
  is_error?: boolean;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Signal to break the agentic loop */
  breakLoop?: {
    returnValue?: string;
  };
  /** Signal that a checkpoint was set — triggers auto-continue after turn ends */
  checkpoint?: boolean;
  /** Signal to change the active DUMMY hook for this chat (string = activate, null = deactivate) */
  activeHook?: string | null;
  /** Chat metadata changes to propagate (name/summary updates via metadata tool) */
  chatMetadata?: { name?: string; summary?: string };
  /** Nested rendering groups from tool's internal work (transferred to ToolResultRenderBlock) */
  renderingGroups?: RenderingBlockGroup[];
  /** Token/cost totals incurred by this tool (e.g., minion sub-agent API costs) */
  tokenTotals?: import('./content').TokenTotals;
}

/**
 * Discriminated delta payload describing how a tool's `renderingGroups` change
 * frame-over-frame. The minion tool emits these instead of full per-chunk
 * snapshots; `agenticLoopGenerator` forwards them onto the wire as
 * `tool_groups_delta` events and `LoopRegistry` applies them server-side so
 * `attachChat` rehydration can emit a single `tool_groups_snapshot`.
 *
 *   - `init` carries the static `infoGroup` plus any seed state. Emitted once
 *     per tool call. The other delta kinds assume the receiver has applied an
 *     `init` first (or a `snapshot` from attach replay).
 *   - `append` is the bandwidth fast-path — only the trailing text/thinking
 *     block of `streamingGroups` grew, so we ship the suffix and nothing else.
 *   - `replace_streaming` covers structural changes (block count/type
 *     mismatch, block list shrunk) by re-shipping just the streaming portion.
 *     `accumulatedGroups` and `infoGroup` stay stable.
 *   - `message_finalized` rolls the in-flight `streamingGroups` into
 *     `accumulatedGroups` when a sub-message finalizes. Carries the
 *     authoritative `accumulatedGroups` and the next `streamingGroups`
 *     (usually empty — the next chunk will repopulate via `append`).
 */
export type ToolGroupsDelta =
  | {
      kind: 'init';
      infoGroup: RenderingBlockGroup;
      accumulatedGroups: RenderingBlockGroup[];
      streamingGroups: RenderingBlockGroup[];
    }
  | { kind: 'append'; target: 'last_text' | 'last_thinking'; text: string }
  | { kind: 'replace_streaming'; streamingGroups: RenderingBlockGroup[] }
  | {
      kind: 'message_finalized';
      accumulatedGroups: RenderingBlockGroup[];
      streamingGroups: RenderingBlockGroup[];
    };

/**
 * Event yielded by tool generators during execution.
 *
 *   - `groups_update` is the legacy full-snapshot path, kept for tools that
 *     don't justify the delta surface.
 *   - `groups_delta` is the bandwidth-conscious path used by the minion tool.
 *     `agenticLoopGenerator` translates these into wire-level
 *     `tool_groups_delta` events and `LoopRegistry` replays the assembled
 *     state on attach via `tool_groups_snapshot`.
 */
export type ToolStreamEvent =
  | { type: 'groups_update'; groups: RenderingBlockGroup[] }
  | { type: 'groups_delta'; delta: ToolGroupsDelta };

/**
 * Return type for ClientSideTool.execute.
 * Tools can return a simple Promise (no streaming) or an AsyncGenerator (with streaming updates).
 * Phase 3 will convert all tools to generators; during transition both are supported.
 */
export type ToolExecuteReturn =
  | Promise<ToolResult>
  | AsyncGenerator<ToolStreamEvent, ToolResult, void>;

// === Tool Option Types ===

/** Reference to a specific API definition and model */
export interface ModelReference {
  apiDefinitionId: string;
  modelId: string;
}

/** Tool option value types - boolean, number, string, model reference, or model reference list */
export type ToolOptionValue = boolean | number | string | ModelReference | ModelReference[];

/** Per-tool options - keyed by option ID */
export type ToolOptions = Record<string, ToolOptionValue>;

/** Base interface for all tool option definitions */
interface BaseToolOption {
  id: string;
  label: string;
  subtitle?: string;
  /** Only show this option when a sibling option matches the given value(s) */
  visibleWhen?: { optionId: string; value: ToolOptionValue | ToolOptionValue[] };
}

/** Boolean toggle option (existing behavior) */
export interface BooleanToolOption extends BaseToolOption {
  type: 'boolean';
  default: boolean;
}

/** Number option (inline number input) */
export interface NumberToolOption extends BaseToolOption {
  type: 'number';
  default: number;
  min?: number;
  max?: number;
}

/** Long text option (textarea with modal editor) */
export interface LongtextToolOption extends BaseToolOption {
  type: 'longtext';
  default: string;
  placeholder?: string;
}

/** Model selector option (API definition + model picker) */
export interface ModelToolOption extends BaseToolOption {
  type: 'model';
  // No default - prepopulated from project when tool first enabled
}

/** Model list option (multiple model references) */
export interface ModelListToolOption extends BaseToolOption {
  type: 'modellist';
}

/** Single-line text option (inline input) */
export interface TextToolOption extends BaseToolOption {
  type: 'text';
  default: string;
  placeholder?: string;
}

/** Select option (single choice from predefined values) */
export interface SelectToolOption extends BaseToolOption {
  type: 'select';
  default: string;
  choices: { value: string; label: string }[];
  /** Map legacy boolean option IDs to select values for backward compat */
  migrateFrom?: { optionId: string; whenTrue: string }[];
}

/** Discriminated union of all tool option types */
export type ToolOptionDefinition =
  | BooleanToolOption
  | NumberToolOption
  | TextToolOption
  | LongtextToolOption
  | ModelToolOption
  | ModelListToolOption
  | SelectToolOption;

/**
 * Type guard: check if option is a boolean option
 */
export function isBooleanOption(opt: ToolOptionDefinition): opt is BooleanToolOption {
  return opt.type === 'boolean';
}

/**
 * Type guard: check if option is a number option
 */
export function isNumberOption(opt: ToolOptionDefinition): opt is NumberToolOption {
  return opt.type === 'number';
}

/**
 * Type guard: check if option is a text option
 */
export function isTextOption(opt: ToolOptionDefinition): opt is TextToolOption {
  return opt.type === 'text';
}

/**
 * Type guard: check if option is a longtext option
 */
export function isLongtextOption(opt: ToolOptionDefinition): opt is LongtextToolOption {
  return opt.type === 'longtext';
}

/**
 * Type guard: check if option is a model option
 */
export function isModelOption(opt: ToolOptionDefinition): opt is ModelToolOption {
  return opt.type === 'model';
}

/**
 * Type guard: check if option is a model list option
 */
export function isModelListOption(opt: ToolOptionDefinition): opt is ModelListToolOption {
  return opt.type === 'modellist';
}

/**
 * Type guard: check if option is a select option
 */
export function isSelectOption(opt: ToolOptionDefinition): opt is SelectToolOption {
  return opt.type === 'select';
}

/**
 * Type guard: check if a value is a ModelReference (single, not array)
 */
export function isModelReference(value: ToolOptionValue): value is ModelReference {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'apiDefinitionId' in value &&
    'modelId' in value
  );
}

/**
 * Type guard: check if a value is a ModelReference array
 */
export function isModelReferenceArray(value: ToolOptionValue): value is ModelReference[] {
  return (
    Array.isArray(value) &&
    value.every(
      item =>
        typeof item === 'object' && item !== null && 'apiDefinitionId' in item && 'modelId' in item
    )
  );
}

/**
 * Initialize tool options with defaults, prepopulating model options from project.
 * Call this when a tool is first enabled or when accessing options.
 *
 * @param existing - Existing tool options (may be partial)
 * @param optionDefs - Tool's option definitions
 * @param project - Project for model option defaults
 * @returns Complete tool options with all defaults applied
 */
export function initializeToolOptions(
  existing: ToolOptions | undefined,
  optionDefs: ToolOptionDefinition[] | undefined,
  project: { apiDefinitionId: string | null; modelId: string | null }
): ToolOptions {
  if (!optionDefs?.length) return existing ?? {};

  const result: ToolOptions = { ...(existing ?? {}) };

  for (const opt of optionDefs) {
    if (result[opt.id] !== undefined) continue; // Already has value

    if (opt.type === 'model') {
      // Prepopulate from project (only if project has a model configured)
      if (project.apiDefinitionId && project.modelId) {
        result[opt.id] = {
          apiDefinitionId: project.apiDefinitionId,
          modelId: project.modelId,
        };
      }
      // If project has no model, leave undefined - UI will require selection
    } else if (opt.type === 'modellist') {
      result[opt.id] = [];
    } else if (opt.type === 'select' && opt.migrateFrom) {
      // Check legacy boolean keys before applying default
      let migrated = false;
      for (const rule of opt.migrateFrom) {
        if (result[rule.optionId] === true) {
          result[opt.id] = rule.whenTrue;
          migrated = true;
          break;
        }
      }
      if (!migrated) result[opt.id] = opt.default;
    } else {
      result[opt.id] = opt.default;
    }
  }

  return result;
}

/** Factory that creates a VfsAdapter for a given namespace */
export type VfsAdapterFactory = (
  namespace?: string
) => import('../../services/vfs/vfsAdapter').VfsAdapter;

/** Context passed to tool execute function */
export interface ToolContext {
  projectId: string;
  chatId?: string;
  namespace?: string;
  noLineNumbers?: boolean;
  /** Pre-bound adapter using the context's namespace */
  vfsAdapter: import('../../services/vfs/vfsAdapter').VfsAdapter;
  /** Factory to create adapters for other namespaces */
  createVfsAdapter: VfsAdapterFactory;
  /**
   * Hard-abort signal for the agentic loop. Tools should honor this when
   * doing long-running work. PR 5 wires it into agenticLoopGenerator and the
   * tool implementations. PR 3 threaded the field through.
   */
  signal: AbortSignal;
  /**
   * Identifier of the running loop, when one has been minted by the backend.
   * Tools that spawn sub-loops (e.g. `minionTool`) forward this as the child's
   * `parentLoopId` so the LoopRegistry can group parent/child runs.
   */
  loopId?: string;
  /**
   * Injected backend dependencies. Tools read storage / encryption / api /
   * tool registry from the context instead of importing module-level
   * singletons. The agentic loop's `ToolContext` construction site always
   * populates these from `options.deps` (which `GremlinServer.init()` builds
   * from its `InitParams`), so the worker-mode singleton init-order bug
   * cannot reach tools through this surface. Phase 3 of the singleton
   * encapsulation refactor migrates the API clients and `vfsService` next;
   * Phase 4 deletes the singleton exports entirely.
   */
  storage: import('../../services/storage/unifiedStorage').UnifiedStorage;
  encryption: import('../../services/encryption/encryptionCore').EncryptionCore;
  apiService: import('../../services/api/apiService').APIService;
  toolRegistry: import('../../services/tools/clientSideTools').ClientSideToolRegistry;
  /**
   * Per-server `LoopRegistry`. Tools that spawn child loops (`minionTool`)
   * register their child here so the sidebar Running Loops UI can show
   * them as indented rows under the parent and abort each one
   * independently. Forwarded from `BackendDeps.loopRegistry` by the
   * agentic loop's `ToolContext` construction site.
   */
  loopRegistry: import('../../engine/LoopRegistry').LoopRegistry;
}

/** Context passed to system prompt functions for dynamic generation */
export interface SystemPromptContext {
  projectId: string;
  /** Optional - undefined when running standalone/sub-agent loops */
  chatId?: string;
  apiDefinitionId: string;
  modelId: string;
  /** API type of the current API definition (optional for backward compat) */
  apiType?: APIType;
  /** VFS namespace for isolated minion personas */
  namespace?: string;
  /**
   * VFS adapter factory — uses correct backend (local/remote) for the
   * project. Always populated by the worker / backend before invoking a
   * system prompt generator. VFS access lives only in the worker, so any
   * tool that needs to read project files (memory, minion personas, hook
   * code) reaches them through this factory.
   */
  createVfsAdapter: VfsAdapterFactory;
}

/** Input schema type for tool definitions - includes index signature for SDK compatibility */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  [key: string]: unknown;
}

/**
 * Standard tool definition format (Anthropic-aligned).
 * API clients translate this to their provider-specific format.
 */
export interface StandardToolDefinition {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}

export interface ClientSideTool {
  name: string;
  /** Display name for UI (e.g., "JavaScript Execution"). Falls back to name if not provided. */
  displayName?: string;
  /** Short UI description shown below the tool toggle in ProjectSettings */
  displaySubtitle?: string;
  /** Internal tools are not shown in ProjectSettings UI (e.g., 'return' for minions) */
  internal?: boolean;
  /** Complex tools run in a later phase after simple tools complete (e.g., minion sub-agents) */
  complex?: boolean;
  /** Delay (ms) between launching parallel calls of this same tool. First call starts immediately. */
  parallelThrottleMs?: number;
  /**
   * Resolve the throttle group for one parallel call. Calls that resolve to the
   * same group are staggered by `parallelThrottleMs`; different groups launch
   * concurrently. Defaults to the tool name when omitted (every call shares one
   * group). Used by `minion` to scope its stagger to one upstream API definition
   * so unrelated providers don't delay each other.
   */
  getParallelThrottleGroup?(
    input: Record<string, unknown>,
    toolOptions: ToolOptions | undefined,
    context: ToolContext
  ): string | Promise<string>;
  /**
   * Opt this tool into the claude-agent SDK bridge. When set, a claude-agent
   * chat exposes the tool to the host `claude` CLI as an in-process MCP tool
   * (`mcp__gremlin__<name>`) and dispatches its calls through
   * `executeClientSideTool`. Tools whose `ToolResult` only carries
   * `content`/`isError`/`renderingGroups`/`tokenTotals` bridge cleanly; loop-
   * control tools (return/checkpoint/dummy) and chat-side-effect tools
   * (metadata) are intentionally left off — their `ToolResult` signals are
   * meaningful only to the GremlinOFA agentic loop, which the SDK bypasses.
   */
  claudeAgentBridgeable?: boolean;
  /** Tool description - can be static string or function for dynamic content */
  description: string | ((options: ToolOptions) => string);
  /** Input schema - can be static or function for dynamic content */
  inputSchema: ToolInputSchema | ((options: ToolOptions) => ToolInputSchema);
  /** Tool-specific boolean options the user can configure per-project */
  optionDefinitions?: ToolOptionDefinition[];
  /**
   * Execute the tool.
   * Returns Promise<ToolResult> for simple tools, or AsyncGenerator for streaming tools.
   * The generator yields ToolStreamEvent during execution and returns ToolResult on completion.
   */
  execute(
    input: Record<string, unknown>,
    toolOptions?: ToolOptions,
    context?: ToolContext
  ): ToolExecuteReturn;
  /**
   * Dynamic API overrides - returns provider-specific tool definition.
   * Return undefined to use standard definition (with resolved description/inputSchema).
   */
  getApiOverride?(
    apiType: APIType,
    toolOptions: ToolOptions
  ): Anthropic.Beta.BetaToolUnion | ChatCompletionTool | OpenAI.Responses.Tool | undefined;
  /**
   * System prompt to inject when tool is enabled.
   * Can be a static string or async function that receives context and toolOptions.
   * Skipped if getApiOverride() returns non-undefined for the current API type.
   */
  systemPrompt?:
    | string
    | ((context: SystemPromptContext, toolOptions: ToolOptions) => Promise<string> | string);
  /** Transform tool input for display in tool_use blocks. Default: JSON.stringify */
  renderInput?: (input: Record<string, unknown>) => string;
  /** Transform tool output for display in tool_result blocks. Default: show raw content */
  renderOutput?: (output: string, isError?: boolean) => string;
  /** Icon for tool_use blocks (emoji/unicode). Default: =' */
  iconInput?: string;
  /** Icon for tool_result blocks (emoji/unicode). Default:  or L based on error state */
  iconOutput?: string;
}

// Minion Chat types
export interface MinionChat {
  id: string;
  parentChatId: string; // The main chat that spawned this minion
  projectId: string;
  createdAt: Date;
  lastModifiedAt: Date;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalReasoningTokens?: number;
  totalCacheCreationTokens?: number;
  totalCacheReadTokens?: number;
  totalCost?: number;
  contextWindowUsage?: number;
  costUnreliable?: boolean;
  /** Last message ID of the last successful run (for rollback on retry) */
  savepoint?: string;
  /** Display name set by the LLM for UI labeling */
  displayName?: string;
  /** Persona name used for this minion chat */
  persona?: string;
  /** API definition ID of the model used (persisted for continuation) */
  apiDefinitionId?: string;
  /** Model ID used (persisted for continuation) */
  modelId?: string;
  /** Tools enabled for this minion (persisted for continuation) */
  enabledTools?: string[];
  /** Hook name in /hooks/ for verifying minion output before savepoint advances */
  verifyHook?: string;
  /** Override: enable/disable reasoning for this minion */
  enableReasoning?: boolean;
  /** Override: reasoning budget tokens */
  reasoningBudgetTokens?: number;
  /** Override: reasoning effort level */
  reasoningEffort?: ReasoningEffort;
  /** Override: temperature */
  temperature?: number;
  /** Override: max output tokens */
  maxOutputTokens?: number;
  /** Override: file injection mode (inline, separate-block, as-file) */
  fileInjectionMode?: string;
  /** Override: inline system prompt appended to minion prompt */
  systemPrompt?: string;
  /** Override: VFS path(s) to system prompt file(s). String or array of strings. */
  systemPromptFile?: string | string[];
  /** Override: thinking-nudge text appended to last user message. Empty string = explicitly off. */
  nudgeThinking?: string;
  /** Override: thinkingKeepTurns (forwarded to API as server-side context edit). */
  thinkingKeepTurns?: number;
  /** Override: prune thinking blocks client-side before the API call. */
  pruneThinkingBeforeApiCall?: boolean;
  /** Remote session ID for touch-grass backend (human delegation) */
  remoteSessionId?: string;
  /** Claude Agent SDK session ID (UUID v4). Set on first claude-agent turn. */
  claudeAgentSessionId?: string;
  /** SDK assistant UUID to rewind to on next minion send. Cleared after consumption. */
  claudeAgentResumeAt?: string;
}

// Virtual Filesystem (VFS) types
export interface VfsNode {
  type: 'file' | 'dir';
  fileId?: string; // only for type: 'file'
  deleted: boolean;
  createdAt: number; // Unix timestamp (ms)
  updatedAt: number; // Unix timestamp (ms)
  children?: Record<string, VfsNode>; // only for type: 'dir'
  isBinary?: boolean; // true for binary files, false for text, undefined for legacy
  mime?: string; // MIME type (text/plain for text, detected or application/octet-stream for binary)
}

export interface VfsOrphan {
  fileId: string;
  originalPath: string;
  orphanedAt: number; // Unix timestamp (ms)
}

export interface VfsTree {
  children: Record<string, VfsNode>;
  orphans: VfsOrphan[];
}

export interface VfsFile {
  content: string;
  version: number;
  createdAt: number; // Unix timestamp (ms)
  updatedAt: number; // Unix timestamp (ms)
  minStoredVersion?: number; // Minimum version still stored (1 if all versions exist)
}

export interface VfsVersion {
  content: string;
  version: number;
  createdAt: number; // Unix timestamp (ms)
}
