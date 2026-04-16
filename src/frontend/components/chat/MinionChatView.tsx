import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMinionChat } from '../../hooks/useMinionChat';
import { useIsMobile } from '../../hooks/useIsMobile';
import { formatTokenGroup } from '../../lib/messageFormatters';
import { showDestructiveConfirm } from '../../lib/alerts';
import MessageList from './MessageList';

interface MinionChatViewProps {
  minionChatId: string;
  onMenuPress?: () => void;
  onClose?: () => void;
}

export default function MinionChatView({
  minionChatId,
  onMenuPress,
  onClose,
}: MinionChatViewProps) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { minionChat, messages, isLoading, tokenUsage, deleteMessage } =
    useMinionChat(minionChatId);

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

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Header */}
      <div className="border-b border-gray-200 bg-white">
        <div className="flex h-14 items-center px-4">
          {isMobile && onMenuPress && (
            <button
              onClick={onMenuPress}
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
            <h1 className="truncate text-lg font-semibold text-gray-900">Minion Chat</h1>
            <span className="truncate text-xs text-gray-500">{minionChatId}</span>
          </div>
          <button
            onClick={handleClose}
            className="-mr-2 flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-gray-100"
          >
            <span className="text-2xl text-gray-600">✕</span>
          </button>
        </div>
      </div>

      {/* Info Bar */}
      <div className="flex items-center justify-end border-b border-gray-200 bg-white px-4 py-1">
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
        onDeleteMessage={handleDeleteMessage}
        isLoading={isLoading}
        streamingGroups={[]}
        currentApiDefId={null}
        currentModelId={null}
      />
    </div>
  );
}
