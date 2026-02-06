import { useState } from 'react';
import type { MessageAttachment, RenderingBlockGroup } from '../../types';
import type { TextRenderBlock } from '../../types/content';
import { stripMetadata, formatTimestamp } from '../../utils/messageFormatters';
import { showAlert } from '../../utils/alerts';
import ImageLightbox from '../ui/ImageLightbox';
import type { UserMessageBubbleProps } from './types';

export default function UserMessageBubble({
  message,
  attachments,
  onAction,
}: UserMessageBubbleProps) {
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  // Extract display content from renderingContent if available, fall back to stripMetadata
  const displayContent = message.content.renderingContent
    ? (message.content.renderingContent as RenderingBlockGroup[])
        .flatMap(g => g.blocks)
        .filter((b): b is TextRenderBlock => b.type === 'text')
        .map(b => b.text)
        .join('')
    : stripMetadata(message.content.content);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(displayContent);
      showAlert('Copied', 'Message copied to clipboard');
    } catch (_error) {
      showAlert('Error', 'Failed to copy message');
    }
  };

  const handleDumpMessage = async () => {
    try {
      const messageJson = JSON.stringify(message, null, 2);
      await navigator.clipboard.writeText(messageJson);
      showAlert('Copied', 'Message JSON copied to clipboard');
    } catch (_error) {
      showAlert('Error', 'Failed to copy message JSON');
    }
  };

  const handleFork = () => {
    onAction('fork', message.id);
  };

  const handleEdit = () => {
    onAction('edit', message.id);
  };

  const handleResend = () => {
    onAction('resend', message.id);
  };

  return (
    <div className="flex flex-col items-end">
      {/* User message bubble */}
      <div className={'max-w-[90%] rounded-2xl bg-blue-600 px-4 py-3 text-white shadow-sm'}>
        {/* Image thumbnails with click-to-preview */}
        {attachments.length > 0 && (
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
          </div>
        )}
        <div className="text-[15px] leading-relaxed whitespace-pre-wrap">{displayContent}</div>
      </div>

      {/* User metadata line */}
      <div
        className={`mt-1 flex max-w-[85%] items-center justify-end gap-2 text-[10px] text-gray-500`}
      >
        <button
          onClick={handleEdit}
          className="transition-colors hover:text-gray-700"
          title="Edit message"
        >
          📝 Edit
        </button>
        <button
          onClick={handleFork}
          className="transition-colors hover:text-gray-700"
          title="Fork chat from here"
        >
          🔀 Fork
        </button>
        <button
          onClick={handleResend}
          className="transition-colors hover:text-blue-600"
          title="Resend from here"
        >
          🔄 Resend
        </button>
        <button
          onClick={handleCopy}
          className="transition-colors hover:text-gray-700"
          title="Copy message"
        >
          📋 Copy
        </button>
        <button
          onClick={handleDumpMessage}
          className="transition-colors hover:text-gray-700"
          title="Copy message JSON"
        >
          🔍
        </button>
        <span>{formatTimestamp(message.timestamp)}</span>
      </div>

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
