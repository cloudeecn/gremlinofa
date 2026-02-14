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

export type APIType = 'anthropic' | 'chatgpt' | 'responses_api' | 'webllm' | 'bedrock';

/** Type-safe tool definition overrides for each API type */
export interface APIToolOverrides {
  anthropic?: Anthropic.Beta.BetaToolUnion;
  chatgpt?: ChatCompletionTool;
  responses_api?: OpenAI.Responses.Tool;
  webllm?: void;
  bedrock?: BedrockTool;
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

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined;
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

  // === Feature Support ===
  /** Accepts temperature parameter (some reasoning models ignore it) */
  supportsTemperature?: boolean;

  /** Supports function/tool calling */
  supportsTools?: boolean;

  // === WebLLM Specific ===
  /** VRAM requirement in bytes (WebLLM local models) */
  vramRequired?: number;

  /** Model download size in bytes (WebLLM local models) */
  downloadSize?: number;

  /** Can run on limited devices like Android phones (WebLLM) */
  lowResourceRequired?: boolean;
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
  // OpenAI/Responses API reasoning
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; // undefined = auto
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

  // === DEPRECATED tool fields (kept for migration only) ===
  /** @deprecated Use enabledTools.includes('memory') instead */
  memoryEnabled?: boolean;
  /** @deprecated Use toolOptions.memory.useSystemPrompt instead */
  memoryUseSystemPrompt?: boolean;
  /** @deprecated Use enabledTools.includes('javascript') instead */
  jsExecutionEnabled?: boolean;
  /** @deprecated Use toolOptions.javascript.loadLib instead */
  jsLibEnabled?: boolean;
  /** @deprecated Use enabledTools.includes('filesystem') instead */
  fsToolEnabled?: boolean;

  // Disable streaming (use non-streaming API calls)
  disableStream?: boolean;
  // Extended context window (1M tokens, Anthropic beta)
  extendedContext?: boolean;
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
  // Current context window usage (recalculated, can decrease)
  contextWindowUsage?: number;
  // Flag for one-time contextWindowUsage migration
  contextWindowUsageMigrated?: boolean;
  // True if any message has unreliable cost calculation
  costUnreliable?: boolean;
  // DEPRECATED: Sink costs kept for migration only, not used in calculations
  sinkInputTokens?: number;
  sinkOutputTokens?: number;
  sinkReasoningTokens?: number;
  sinkCacheCreationTokens?: number;
  sinkCacheReadTokens?: number;
  sinkCost?: number;
  // Fork tracking
  isForked?: boolean;
  forkedFromChatId?: string;
  forkedFromMessageId?: string; // Original message ID where fork occurred
  forkedAtMessageId?: string; // New message ID in this chat (last copied message)
  // Pending state for deferred operations
  pendingState?: ChatPendingState;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export interface MessageContent<T> {
  type: 'text';
  content: string; // Pure text for display (from StreamResult.textContent)
  modelFamily?: APIType; // Which API created this message
  fullContent?: T; // Provider-specific blocks (for caching/replay)
  renderingContent?: RenderingBlockGroup[]; // Pre-grouped blocks for UI rendering
  attachmentIds?: string[]; // References to attachment records
  originalAttachmentCount?: number; // Number of attachments when message was sent (for tracking deleted attachments)
  stopReason?: MessageStopReason; // Why message ended (end_turn, max_tokens, etc.)
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
}

export interface Message<T> {
  id: string;
  role: MessageRole;
  content: MessageContent<T>;
  timestamp: Date;
  metadata?: MessageMetadata;
  attachments?: MessageAttachment[]; // Loaded from storage when needed for API calls
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
  /** Nested rendering groups from tool's internal work (transferred to ToolResultRenderBlock) */
  renderingGroups?: RenderingBlockGroup[];
  /** Token/cost totals incurred by this tool (e.g., minion sub-agent API costs) */
  tokenTotals?: import('./content').TokenTotals;
}

/** Event yielded by tool generators during execution */
export type ToolStreamEvent = { type: 'groups_update'; groups: RenderingBlockGroup[] };

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

/** Tool option value types - boolean, string, model reference, or model reference list */
export type ToolOptionValue = boolean | string | ModelReference | ModelReference[];

/** Per-tool options - keyed by option ID */
export type ToolOptions = Record<string, ToolOptionValue>;

/** Base interface for all tool option definitions */
interface BaseToolOption {
  id: string;
  label: string;
  subtitle?: string;
  /** @deprecated Use subtitle instead */
  description?: string;
}

/** Boolean toggle option (existing behavior) */
export interface BooleanToolOption extends BaseToolOption {
  type: 'boolean';
  default: boolean;
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

/** Discriminated union of all tool option types */
export type ToolOptionDefinition =
  | BooleanToolOption
  | LongtextToolOption
  | ModelToolOption
  | ModelListToolOption;

/**
 * Type guard: check if option is a boolean option
 */
export function isBooleanOption(opt: ToolOptionDefinition): opt is BooleanToolOption {
  return opt.type === 'boolean';
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
    } else {
      result[opt.id] = opt.default;
    }
  }

  return result;
}

/** Context passed to tool execute function */
export interface ToolContext {
  projectId: string;
  chatId?: string;
  namespace?: string;
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

  // === DEPRECATED fields (kept for migration) ===
  /** @deprecated Use getApiOverride() instead */
  apiOverrides?: Partial<APIToolOverrides>;
  /** @deprecated No longer used - tools are included based on enabledTools list */
  alwaysEnabled?: boolean;
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
  /** Last message ID before this minion run started (for future rollback) */
  checkpoint?: string;
  /** Display name set by the LLM for UI labeling */
  displayName?: string;
  /** Persona name used for this minion chat */
  persona?: string;
  /** API definition ID of the model used (persisted for continuation) */
  apiDefinitionId?: string;
  /** Model ID used (persisted for continuation) */
  modelId?: string;
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
