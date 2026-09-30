import type { Ref } from 'react';
import type { Message, MessageAttachment } from '../../../shared/protocol/types';
import type { RenderingBlockGroup } from '../../../shared/protocol/types/content';
import type { DummyHookStatus } from '../../hooks/useChat';

export type MessageAction = 'fork' | 'edit' | 'rollback';

export interface MessageBubbleProps {
  message: Message<unknown>;
  onAction?: (action: MessageAction, messageId: string) => void;
  /** Actions the list supports; all of them when omitted. Keep the Set stable (module const). */
  actions?: ReadonlySet<MessageAction>;
  onDeleteMessage?: (messageId: string) => void;
  /** Outside the virtual-scroll buffer: render a placeholder if a height was measured */
  isHidden: boolean;
  onRegister: (messageId: string, element: HTMLElement | null) => void;
  onMeasureHeight: (messageId: string, height: number) => void;
  getHeight: (messageId: string) => number | undefined;
  focusMode?: boolean;
  expandMinions?: boolean;
  disableMath?: boolean;
  isLastMessage?: boolean;
  /** True for chats backed by the Claude Agent SDK — hides Fork and user-message Rollback. */
  isClaudeAgentChat?: boolean;
  /** Backstage groups that start expanded (handed over from the live reply) */
  expandedGroups?: ReadonlySet<number>;
}

export interface UserMessageBubbleProps {
  message: Message<unknown>;
  attachments: MessageAttachment[];
  /** Attachments still being fetched; that many placeholder tiles hold their space */
  loadingAttachmentCount?: number;
  onAction?: (action: MessageAction, messageId: string) => void;
  actions?: ReadonlySet<MessageAction>;
  onDeleteMessage?: (messageId: string) => void;
  focusMode?: boolean;
  isLastMessage?: boolean;
  /** True for chats backed by the Claude Agent SDK — hides Fork and Rollback. */
  isClaudeAgentChat?: boolean;
}

export interface AssistantMessageBubbleProps {
  message: Message<unknown>;
  onAction?: (action: 'rollback', messageId: string) => void;
  onDeleteMessage?: (messageId: string) => void;
  focusMode?: boolean;
  disableMath?: boolean;
  isLastMessage?: boolean;
  expandedGroups?: ReadonlySet<number>;
}

export interface StreamingMessageProps {
  groups: RenderingBlockGroup[];
  focusMode?: boolean;
  disableMath?: boolean;
  dummyHookStatus?: DummyHookStatus | null;
  expandedGroups?: ReadonlySet<number>;
  onGroupExpandedChange?: (groupIndex: number, expanded: boolean) => void;
}

export interface MessageListHandle {
  /** Mount the latest messages, scroll to the bottom and follow new output. */
  jumpToLatest: (behavior?: ScrollBehavior) => void;
}

export interface MessageListProps {
  ref?: Ref<MessageListHandle>;
  messages: Message<unknown>[];
  onAction?: (action: MessageAction, messageId: string) => void;
  /** Actions this list supports; all of them when omitted. Keep the Set stable (module const). */
  actions?: ReadonlySet<MessageAction>;
  onDeleteMessage?: (messageId: string) => void;
  isLoading: boolean;
  streamingGroups: RenderingBlockGroup[];
  currentApiDefId: string | null;
  currentModelId: string | null;
  focusMode?: boolean;
  expandMinions?: boolean;
  disableMath?: boolean;
  alwaysAutoScroll?: boolean;
  /** True for chats backed by the Claude Agent SDK — hides Fork and user-message Rollback. */
  isClaudeAgentChat?: boolean;
  /** Number of pending tool calls (for banner display) */
  pendingToolCount?: number;
  /** Callback when user clicks Reject on pending tool calls */
  onPendingToolReject?: () => void;
  /** Callback when user clicks Accept on pending tool calls */
  onPendingToolAccept?: () => void;
  /** Whether the loop is suspended after tool execution */
  suspendedAfterTools?: boolean;
  /** Callback to continue after tool-stop suspension */
  onContinueAfterToolStop?: () => void;
  /** True while snapshot replay is in progress — suppresses auto-scroll and banners */
  snapshotLoading?: boolean;
  /** DUMMY System hook status during streaming */
  dummyHookStatus?: DummyHookStatus | null;
}

export interface ChatInputHandle {
  /** Stage files dropped elsewhere in the chat (same checks as the 📎 picker). */
  addFiles: (files: File[]) => void;
}

export interface ChatInputProps {
  ref?: Ref<ChatInputHandle>;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** Sending is blocked (loop running, snapshot replay, locked tail). Typing and attaching still work. */
  sendDisabled: boolean;
  // Attachment props - uses processed MessageAttachment[] for efficient display
  attachments: MessageAttachment[];
  onFilesAdded: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  maxAttachments?: number;
  /** Whether image processing is in progress */
  isProcessing?: boolean;
  /** Show spinner on send button (waiting for first stream chunk) */
  showSendSpinner?: boolean;
  /** Whether there are pending tool calls (enables send button even with empty input) */
  hasPendingToolCalls?: boolean;
  /** Whether the message carries injected files (enables send button even with empty input) */
  hasCarriedFiles?: boolean;
  /** Whether a soft stop has been requested */
  softStopRequested?: boolean;
  /** Callback to request soft stop of the agentic loop */
  onRequestSoftStop?: () => void;
}
