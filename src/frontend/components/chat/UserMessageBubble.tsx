import { useState } from 'react';
import type { MessageAttachment } from '../../../shared/protocol/types';
import { splitInjectedFileBlocks } from '../../../shared/protocol/carriedInjection';
import { userMessageText } from '../../lib/messageFormatters';
import CopyButton from '../ui/CopyButton';
import ImageLightbox from '../ui/ImageLightbox';
import { InjectedFilesList } from './InjectedFilesList';
import MessageInfoBar, { INFO_BAR_BUTTON } from './MessageInfoBar';
import type { UserMessageBubbleProps } from './types';

export default function UserMessageBubble({
  message,
  attachments,
  loadingAttachmentCount = 0,
  onAction,
  actions,
  onDeleteMessage,
  isLastMessage,
  isClaudeAgentChat,
}: UserMessageBubbleProps) {
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  const displayContent = userMessageText(message);

  // Bars render on the same side of the bubble as their content sat in what
  // the model received: injectFiles above, injectFilesAfter below.
  const { before: injectedFiles, after: injectedFilesAfter } = splitInjectedFileBlocks(
    message.content.renderingContent
  );

  // Attachments load asynchronously; reserve their tiles up front so the bubble
  // doesn't grow after mount (it would shift content when mounted above the viewport).
  const hasAttachments = attachments.length > 0 || loadingAttachmentCount > 0;

  const canEdit = onAction && (!actions || actions.has('edit'));
  // Fork would split an SDK session in two, which claude-agent doesn't support
  const canFork = onAction && !isClaudeAgentChat && (!actions || actions.has('fork'));
  // claude-agent can only rewind to assistant message UUIDs; use the rollback
  // on the assistant message above instead
  const canRollback =
    onAction && !isLastMessage && !isClaudeAgentChat && (!actions || actions.has('rollback'));

  const handleFork = () => {
    onAction?.('fork', message.id);
  };

  const handleEdit = () => {
    onAction?.('edit', message.id);
  };

  const handleRollback = () => {
    onAction?.('rollback', message.id);
  };

  return (
    <div className="flex flex-col items-end">
      {/* Injected files shown as expandable bars above the bubble */}
      {injectedFiles.length > 0 && (
        <div className="mb-1 w-full max-w-[90%]">
          <InjectedFilesList files={injectedFiles} />
        </div>
      )}

      {/* User message bubble — omitted for an inject-only minion message,
          whose whole content is the file bars around it */}
      {(displayContent.trim() !== '' || hasAttachments) && (
        <div className={'max-w-[90%] rounded-2xl bg-blue-600 px-4 py-3 text-white shadow-sm'}>
          {/* Image thumbnails with click-to-preview */}
          {hasAttachments && (
            <div className="mb-2 grid grid-cols-3 gap-2">
              {attachments.map((attachment: MessageAttachment) => (
                <button
                  key={attachment.id}
                  onClick={() =>
                    setLightboxImage(`data:${attachment.mimeType};base64,${attachment.data}`)
                  }
                  className="cursor-pointer overflow-hidden rounded transition-opacity hover:opacity-80"
                >
                  <img
                    src={`data:${attachment.mimeType};base64,${attachment.data}`}
                    alt="Attachment"
                    className="h-24 w-full object-cover"
                  />
                </button>
              ))}
              {Array.from({ length: loadingAttachmentCount }, (_, index) => (
                <div
                  key={`pending-${index}`}
                  className="h-24 w-full rounded bg-blue-500/60"
                  data-testid="attachment-placeholder"
                  aria-hidden="true"
                />
              ))}
            </div>
          )}
          <div className="text-[15px] leading-relaxed break-all whitespace-pre-wrap">
            {displayContent}
          </div>
        </div>
      )}

      {/* Trailing injected files (injectFilesAfter) below the bubble */}
      {injectedFilesAfter.length > 0 && (
        <div className="mt-1 w-full max-w-[90%]">
          <InjectedFilesList files={injectedFilesAfter} />
        </div>
      )}

      <MessageInfoBar
        timestamp={message.timestamp}
        align="end"
        quickActions={
          <>
            <CopyButton
              getText={() => displayContent}
              label="📋"
              title="Copy message"
              className={`${INFO_BAR_BUTTON} hover:text-gray-700`}
            />
            {/* Edit works for claude-agent too: sending the edit rewinds the
                  SDK to the prior assistant turn. */}
            {canEdit && (
              <button
                onClick={handleEdit}
                className={`${INFO_BAR_BUTTON} hover:text-gray-700`}
                title="Edit message"
                aria-label="Edit message"
              >
                📝
              </button>
            )}
          </>
        }
        actions={
          <>
            {canFork && (
              <button
                onClick={handleFork}
                className={`${INFO_BAR_BUTTON} hover:text-gray-700`}
                title="Fork chat from here"
              >
                🔀 Fork
              </button>
            )}
            {canRollback && (
              <button
                onClick={handleRollback}
                className={`${INFO_BAR_BUTTON} hover:text-orange-600`}
                title="Roll back to here"
              >
                ⏪ Rollback
              </button>
            )}
            <CopyButton
              getText={() => JSON.stringify(message, null, 2)}
              label="🔍"
              title="Copy message JSON"
              className={`${INFO_BAR_BUTTON} hover:text-gray-700`}
            />
            {onDeleteMessage && (
              <button
                onClick={() => onDeleteMessage(message.id)}
                className={`${INFO_BAR_BUTTON} hover:text-red-600`}
                title="Delete this message"
              >
                ❌
              </button>
            )}
          </>
        }
      />

      {/* Image lightbox */}
      {lightboxImage && (
        <ImageLightbox
          src={lightboxImage}
          alt="Attachment preview"
          onClose={() => setLightboxImage(null)}
        />
      )}
    </div>
  );
}
