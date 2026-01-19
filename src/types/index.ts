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
  ErrorRenderBlock,
} from './content';
export { categorizeBlock, groupAndConsolidateBlocks } from './content';
import type { RenderingBlockGroup, MessageStopReason } from './content';

import type Anthropic from '@anthropic-ai/sdk';
import type { ChatCompletionTool } from 'openai/resources/index.mjs';
import type OpenAI from 'openai';

export type APIType = 'anthropic' | 'chatgpt' | 'responses_api' | 'webllm';

/** Type-safe tool definition overrides for each API type */
export interface APIToolOverrides {
  anthropic?: Anthropic.Beta.BetaToolUnion;
  chatgpt?: ChatCompletionTool;
  responses_api?: OpenAI.Responses.Tool;
  webllm?: void;
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

  // Memory tool
  memoryEnabled?: boolean;
  // JavaScript execution tool
  jsExecutionEnabled?: boolean;
  jsLibEnabled?: boolean; // Auto-load /lib/*.js scripts when JS session starts
  // Filesystem tool
  fsToolEnabled?: boolean;
  // Disable streaming (use non-streaming API calls)
  disableStream?: boolean;
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
}

export interface ClientSideTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  execute(input: Record<string, unknown>): Promise<ToolResult>;
  /** API-specific definition overrides (e.g., Anthropic's memory_20250818 shorthand) */
  apiOverrides?: Partial<APIToolOverrides>;
  /** Tools with alwaysEnabled: true are included regardless of enabledTools list */
  alwaysEnabled?: boolean;
  /** System prompt to inject when tool is enabled. Skipped if apiOverrides is used for the current API type. */
  systemPrompt?: string;
  /** Transform tool input for display in tool_use blocks. Default: JSON.stringify */
  renderInput?: (input: Record<string, unknown>) => string;
  /** Transform tool output for display in tool_result blocks. Default: show raw content */
  renderOutput?: (output: string, isError?: boolean) => string;
  /** Icon for tool_use blocks (emoji/unicode). Default: =' */
  iconInput?: string;
  /** Icon for tool_result blocks (emoji/unicode). Default:  or L based on error state */
  iconOutput?: string;
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
}

export interface VfsVersion {
  content: string;
  version: number;
  createdAt: number; // Unix timestamp (ms)
}
