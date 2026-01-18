import type { Message, MessageAttachment } from '../../types';
import type { RenderingBlockGroup } from '../../types/content';

export interface MessageBubbleProps {
  message: Message<unknown>;
  onAction: (action: 'copy' | 'fork' | 'edit' | 'delete', messageId: string) => void;
  isVisible: boolean;
  onRegister: (messageId: string, element: HTMLElement | null) => void;
  onMeasureHeight: (messageId: string, height: number) => void;
  cachedHeight?: number;
}

export interface UserMessageBubbleProps {
  message: Message<unknown>;
  attachments: MessageAttachment[];
  onAction: (action: 'copy' | 'fork' | 'edit', messageId: string) => void;
}

export interface AssistantMessageBubbleProps {
  message: Message<unknown>;
  isVisible: boolean;
}

export interface LegacyAssistantBubbleProps {
  message: Message<unknown>;
}

export interface StreamingMessageProps {
  groups: RenderingBlockGroup[];
}

export interface MessageListProps {
  messages: Message<unknown>[];
  onAction: (action: 'copy' | 'fork' | 'edit' | 'delete', messageId: string) => void;
  isLoading: boolean;
  streamingGroups: RenderingBlockGroup[];
  currentApiDefId: string | null;
  currentModelId: string | null;
  /** Number of pending tool calls (for banner display) */
  pendingToolCount?: number;
  /** Current mode for resolving pending tool calls */
  pendingToolMode?: 'stop' | 'continue';
  /** Callback when tool mode changes */
  onPendingToolModeChange?: (mode: 'stop' | 'continue') => void;
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
}
