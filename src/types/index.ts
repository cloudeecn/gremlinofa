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

// API Type - represents the protocol/client template (ChatGPT, Anthropic, Responses API, WebLLM)
export const APIType = {
  CHATGPT: 'chatgpt',
  ANTHROPIC: 'anthropic',
  RESPONSES_API: 'responses_api',
  WEBLLM: 'webllm',
} as const;

export type APIType = (typeof APIType)[keyof typeof APIType];

/** Type-safe tool definition overrides for each API type */
export interface APIToolOverrides {
  [APIType.ANTHROPIC]?: Anthropic.Beta.BetaToolUnion;
  [APIType.CHATGPT]?: ChatCompletionTool;
  [APIType.RESPONSES_API]?: OpenAI.Responses.Tool;
  [APIType.WEBLLM]?: void;
}

// For backward compatibility during transition
export const APIProvider = APIType;
export type APIProvider = APIType;

export interface APIDefinition {
  id: string;
  apiType: APIType;
  name: string; // User-given display name (e.g., "xAI", "My OpenAI")
  baseUrl: string; // Empty means use apiType default
  apiKey: string;
  isDefault?: boolean; // Mark as default (non-deletable) definition
  isLocal?: boolean; // Local provider - API key is optional (e.g., Ollama, LM Studio)
  createdAt: Date;
  updatedAt: Date;
}

// Model types
export interface Model {
  id: string;
  name: string;
  apiType: APIType;
  contextWindow: number;
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

// Message types
export const MessageRole = {
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
} as const;

export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole];

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

  // Feature 1: Pricing - total cost calculated at message creation time
  messageCost?: number; // Total calculated cost at message time
  contextWindow?: number; // Model's max context window in tokens
  contextWindowUsage?: number; // Model's context window usage in tokens
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
