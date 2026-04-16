import type { Message, MessageAttachment } from '../../../shared/protocol/types';
import type { RenderingBlockGroup } from '../../../shared/protocol/types/content';
import type { DummyHookStatus } from '../../hooks/useChat';
export interface MessageBubbleProps {
  message: Message<unknown>;
  onAction?: (action: 'copy' | 'fork' | 'edit' | 'delete' | 'resend', messageId: string) => void;
  onDeleteMessage?: (messageId: string) => void;
  isVisible: boolean;
  onRegister: (messageId: string, element: HTMLElement | null) => void;
  onMeasureHeight: (messageId: string, height: number) => void;
  cachedHeight?: number;
  focusMode?: boolean;
  expandMinions?: boolean;
  disableMath?: boolean;
}

export interface UserMessageBubbleProps {
  message: Message<unknown>;
  attachments: MessageAttachment[];
  onAction?: (action: 'copy' | 'fork' | 'edit' | 'resend', messageId: string) => void;
  onDeleteMessage?: (messageId: string) => void;
  focusMode?: boolean;
}

export interface AssistantMessageBubbleProps {
  message: Message<unknown>;
  onDeleteMessage?: (messageId: string) => void;
  isVisible: boolean;
  focusMode?: boolean;
  disableMath?: boolean;
}

export interface StreamingMessageProps {
  groups: RenderingBlockGroup[];
  focusMode?: boolean;
  disableMath?: boolean;
  dummyHookStatus?: DummyHookStatus | null;
}

export interface MessageListProps {
  messages: Message<unknown>[];
  onAction?: (action: 'copy' | 'fork' | 'edit' | 'delete' | 'resend', messageId: string) => void;
  onDeleteMessage?: (messageId: string) => void;
  isLoading: boolean;
  streamingGroups: RenderingBlockGroup[];
  currentApiDefId: string | null;
  currentModelId: string | null;
  focusMode?: boolean;
  expandMinions?: boolean;
  disableMath?: boolean;
  alwaysAutoScroll?: boolean;
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
  /** DUMMY System hook status during streaming */
  dummyHookStatus?: DummyHookStatus | null;
}

export interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
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
  /** Whether a soft stop has been requested */
  softStopRequested?: boolean;
  /** Callback to request soft stop of the agentic loop */
  onRequestSoftStop?: () => void;
}
