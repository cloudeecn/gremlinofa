import type { Message, MessageAttachment } from '../../types';
import type { RenderingBlockGroup } from '../../types/content';

export interface MessageBubbleProps {
  message: Message<unknown>;
  onAction: (action: 'copy' | 'fork' | 'edit', messageId: string) => void;
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
  lastEvent?: string;
}

export interface MessageListProps {
  messages: Message<unknown>[];
  onAction: (action: 'copy' | 'fork' | 'edit', messageId: string) => void;
  isLoading: boolean;
  streamingGroups: RenderingBlockGroup[];
  streamingLastEvent?: string;
  currentApiDefId: string | null;
  currentModelId: string | null;
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
}
