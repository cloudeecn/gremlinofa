import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMinionChat } from '../../hooks/useMinionChat';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useOverlay } from '../../hooks/useOverlay';
import { formatTokenGroup } from '../../lib/messageFormatters';
import { showAlert, showDestructiveConfirm } from '../../lib/alerts';
import MessageList from './MessageList';
import CloneMinionChatModal from './CloneMinionChatModal';
import type { RenderingBlockGroup } from '../../../shared/protocol/types/content';
import type { MessageAction } from './types';

/** Module-level so MessageList's memo holds across this view's re-renders. */
const NO_STREAMING_GROUPS: RenderingBlockGroup[] = [];
/** Edit and Fork have no minion-chat implementation; only rollback is offered. */
const MINION_ACTIONS: ReadonlySet<MessageAction> = new Set(['rollback']);
/** Why a human (Touch Grass) minion's overlay has no rollback or delete. */
const REMOTE_READ_ONLY_REASON =
  "A human answers this minion on the Touch Grass backend. Rollback and delete are off: they'd only change this copy, and the two transcripts would no longer match.";

interface MinionChatViewProps {
  minionChatId: string;
  /** The parent chat's loop is running: keep refetching (the minion may be working) */
  live?: boolean;
  /** The parent chat's Disable Math view option */
  disableMath?: boolean;
  onMenuPress?: () => void;
  onClose?: () => void;
}

export default function MinionChatView({
  minionChatId,
  live = false,
  disableMath,
  onMenuPress,
  onClose,
}: MinionChatViewProps) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const {
    minionChat,
    messages,
    isLoading,
    tokenUsage,
    isRemote,
    deleteMessage,
    rollbackToMessage,
    cloneToChat,
    isCloning,
  } = useMinionChat(minionChatId, { live });
  const [isCloneModalOpen, setIsCloneModalOpen] = useState(false);

  // As an overlay inside ChatView, Escape closes it (one layer at a time)
  const rootRef = useRef<HTMLDivElement>(null);
  useOverlay({ active: !!onClose, onEscape: () => onClose?.(), containerRef: rootRef });

  // claude-agent minions can't splice out a single message or rewind to a user
  // turn — the SDK only resumes at assistant UUIDs. Hide ❌ delete + user-message
  // ⏪/🔀, matching how ChatView treats claude-agent. Assistant/tool ⏪ rollback
  // stays (it persists the SDK resumeAt server-side).
  const isClaudeAgent = !!minionChat?.claudeAgentSessionId;

  const handleBack = () => {
    if (onClose) {
      onClose();
    } else if (minionChat?.parentChatId) {
      navigate(`/chat/${minionChat.parentChatId}`);
    } else {
      navigate('/');
    }
  };

  const handleClose = () => {
    if (onClose) {
      onClose();
    } else if (minionChat?.parentChatId) {
      navigate(`/chat/${minionChat.parentChatId}`);
    } else {
      navigate('/');
    }
  };

  const handleClone = useCallback(
    async (name: string) => {
      try {
        const { newChatId, notes } = await cloneToChat(name);
        setIsCloneModalOpen(false);
        // Close the overlay before navigating: ChatView is keyed by chatId, so
        // the new chat remounts anyway, and leaving the overlay up for a frame
        // flashes the old minion over the new chat.
        onClose?.();
        navigate(`/chat/${newChatId}`);
        if (notes.length > 0) {
          await showAlert('Cloned', notes.join('\n\n'));
        }
      } catch (error) {
        console.debug('[MinionChatView] clone failed:', error);
        await showAlert(
          'Clone failed',
          error instanceof Error ? error.message : 'Could not clone this minion chat.'
        );
      }
    },
    [cloneToChat, navigate, onClose]
  );

  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      const confirmed = await showDestructiveConfirm(
        'Delete Message',
        'Delete this message from the minion chat?',
        'Delete'
      );
      if (confirmed) {
        await deleteMessage(messageId);
      }
    },
    [deleteMessage]
  );

  const handleAction = useCallback(
    async (action: MessageAction, messageId: string) => {
      if (action === 'rollback') {
        const confirmed = await showDestructiveConfirm(
          'Roll Back',
          'This will delete all messages after this one.',
          'Roll Back'
        );
        if (confirmed) {
          await rollbackToMessage(messageId);
        }
      }
    },
    [rollbackToMessage]
  );

  const title = minionChat?.displayName || minionChat?.persona || 'Minion chat';
  const subtitle =
    title === 'Minion chat'
      ? undefined
      : minionChat?.displayName && minionChat.persona
        ? `Minion chat · ${minionChat.persona}`
        : 'Minion chat';

  return (
    <div ref={rootRef} tabIndex={-1} className="flex h-full flex-col bg-white outline-none">
      {/* Header */}
      <div className="border-b border-gray-200 bg-white">
        <div className="flex h-14 items-center px-4">
          {isMobile && onMenuPress && (
            <button
              onClick={onMenuPress}
              aria-label="Open menu"
              className="-ml-2 flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-gray-100"
            >
              <span className="text-2xl text-gray-700">☰</span>
            </button>
          )}
          <button
            onClick={handleBack}
            className="flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-gray-100"
            title="Back to parent chat"
          >
            <span className="text-xl text-gray-700">←</span>
          </button>
          <div className="flex min-w-0 flex-1 flex-col justify-center">
            <h1 className="truncate text-lg font-semibold text-gray-900" title={minionChatId}>
              {title}
            </h1>
            {subtitle && <span className="truncate text-xs text-gray-500">{subtitle}</span>}
          </div>
          <button
            onClick={() => setIsCloneModalOpen(true)}
            disabled={isCloning || isLoading}
            aria-label="Clone to a chat"
            title="Clone to a chat"
            className="flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-gray-100 disabled:opacity-40"
          >
            <span className="text-xl text-gray-700">⧉</span>
          </button>
          <button
            onClick={handleClose}
            aria-label="Close"
            className="-mr-2 flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-gray-100"
          >
            <span className="text-2xl text-gray-600">✕</span>
          </button>
        </div>
      </div>

      {/* Info Bar */}
      <div className="flex items-center justify-end gap-2 border-b border-gray-200 bg-white px-4 py-1">
        {isRemote && (
          <span
            className="mr-auto truncate text-[10px] text-gray-600"
            title={REMOTE_READ_ONLY_REASON}
          >
            👤 Human minion · read-only
          </span>
        )}
        <div className="text-[10px] text-gray-600">
          {formatTokenGroup('↑', tokenUsage.input, [
            { prefix: 'C↑', value: tokenUsage.cacheCreation },
            { prefix: 'C↓', value: tokenUsage.cacheRead },
          ])}{' '}
          {formatTokenGroup('↓', tokenUsage.output, [
            { prefix: 'R:', value: tokenUsage.reasoning },
          ])}{' '}
          ${tokenUsage.cost?.toFixed(3) || '0.000'}
          {minionChat?.costUnreliable && (
            <span className="ml-1 text-yellow-600" title="Cost calculation may be inaccurate">
              (unreliable)
            </span>
          )}
        </div>
      </div>

      {/* Message List */}
      <MessageList
        messages={messages}
        onAction={isRemote ? undefined : handleAction}
        actions={MINION_ACTIONS}
        onDeleteMessage={isClaudeAgent || isRemote ? undefined : handleDeleteMessage}
        isLoading={false}
        snapshotLoading={isLoading}
        streamingGroups={NO_STREAMING_GROUPS}
        currentApiDefId={null}
        currentModelId={null}
        isClaudeAgentChat={isClaudeAgent}
        disableMath={disableMath}
      />

      {isCloneModalOpen && (
        <CloneMinionChatModal
          minionChat={minionChat}
          messageCount={messages.length}
          isCloning={isCloning}
          onCancel={() => setIsCloneModalOpen(false)}
          onConfirm={handleClone}
        />
      )}
    </div>
  );
}
