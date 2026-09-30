import { memo, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { MessageAttachment } from '../../../shared/protocol/types';
import { useImeSafeEnter } from '../../hooks/useImeSafeEnter';
import { useIsTouchDevice } from '../../hooks/useIsTouchDevice';
import { useStableCallback } from '../../hooks/useStableCallback';
import { clipboardImageFiles, pickImageFiles } from '../../lib/imageFiles';
import Spinner from '../ui/Spinner';
import type { ChatInputProps } from './types';

/**
 * Memoized so a keystroke doesn't rebuild (and React doesn't re-compare) a
 * multi-megabyte `data:` URL for every staged image.
 */
const AttachmentThumbnail = memo(function AttachmentThumbnail({
  attachment,
  onRemove,
}: {
  attachment: MessageAttachment;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="relative h-20 w-20 overflow-hidden rounded-lg border border-gray-300">
      <img
        src={`data:${attachment.mimeType};base64,${attachment.data}`}
        alt="Attachment preview"
        className="h-full w-full object-cover"
      />
      <button
        onClick={() => onRemove(attachment.id)}
        className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs text-white hover:bg-red-600"
        title="Remove image"
      >
        ✕
      </button>
    </div>
  );
});

// Keeps a click on Send/Stop from moving focus out of the textarea, so the
// cursor (and a phone's keyboard) stays put across a send.
const keepTextareaFocus = (e: React.MouseEvent) => e.preventDefault();

export default function ChatInput({
  ref,
  value,
  onChange,
  onSend,
  sendDisabled,
  attachments,
  onFilesAdded,
  onRemoveAttachment,
  maxAttachments = 10,
  isProcessing = false,
  showSendSpinner = false,
  hasPendingToolCalls = false,
  hasCarriedFiles = false,
  softStopRequested = false,
  onRequestSoftStop,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isTouchDevice = useIsTouchDevice();
  const { onCompositionEnd, isImeEnter } = useImeSafeEnter();
  const [validationError, setValidationError] = useState<string>('');

  // Auto-resize to the content; the max-h classes cap it (taller on desktop)
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [value]);

  // The textarea stays enabled through a reply, so focus normally never
  // leaves it. If it did (the Send button swapped for Stop under the pointer),
  // bring it back when sending unblocks — on keyboard devices only, since
  // focusing on a phone would pop the keyboard.
  const wasSendDisabledRef = useRef(sendDisabled);
  useEffect(() => {
    const unblocked = wasSendDisabledRef.current && !sendDisabled;
    wasSendDisabledRef.current = sendDisabled;
    if (unblocked && !isTouchDevice && document.activeElement === document.body) {
      textareaRef.current?.focus();
    }
  }, [sendDisabled, isTouchDevice]);

  // One rule for Enter and the Send button
  const canSend =
    (value.trim() !== '' || attachments.length > 0 || hasPendingToolCalls || hasCarriedFiles) &&
    !sendDisabled &&
    !isProcessing &&
    !showSendSpinner;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeEnter(e)) return;

    // Touch devices (phone/tablet without keyboard): Enter inserts newline, send button to send
    // Keyboard devices (desktop, iPad + Magic Keyboard): Enter sends, Shift+Enter for newline
    if (e.key === 'Enter' && !e.shiftKey && !isTouchDevice) {
      e.preventDefault();
      if (canSend) {
        onSend();
      }
    }
  };

  const addFiles = useStableCallback((files: File[]) => {
    const { images, error } = pickImageFiles(files, attachments.length, maxAttachments);
    setValidationError(error ?? '');
    if (images.length > 0) onFilesAdded(images);
  });

  useImperativeHandle(ref, () => ({ addFiles }), [addFiles]);

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = clipboardImageFiles(e.clipboardData);
    if (images.length === 0) return;
    // Rich copies (a web page) carry text alongside the image: let the text paste too
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    addFiles(images);
  };

  const handleAttachClick = () => {
    if (attachments.length >= maxAttachments) {
      setValidationError(`Maximum ${maxAttachments} images allowed`);
      return;
    }
    fileInputRef.current?.click();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    addFiles(files);
    // Reset input so same file can be selected again
    e.target.value = '';
  };

  const handleRemoveAttachment = useStableCallback((id: string) => {
    onRemoveAttachment(id);
    setValidationError('');
  });

  // Clear validation error after 5 seconds
  useEffect(() => {
    if (validationError) {
      const timer = setTimeout(() => setValidationError(''), 5000);
      return () => clearTimeout(timer);
    }
  }, [validationError]);

  return (
    <div className="flex w-full flex-col">
      <div className="border-t border-gray-200 bg-white p-4">
        {/* Thumbnail Preview Grid - uses processed MessageAttachment data: URLs */}
        {attachments.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {attachments.map(attachment => (
              <AttachmentThumbnail
                key={attachment.id}
                attachment={attachment}
                onRemove={handleRemoveAttachment}
              />
            ))}
            {/* Processing indicator */}
            {isProcessing && (
              <div className="flex h-20 w-20 items-center justify-center rounded-lg border border-gray-300 bg-gray-100">
                <div className="text-xs text-gray-500">
                  <span className="bouncing-dot">.</span>
                  <span className="bouncing-dot">.</span>
                  <span className="bouncing-dot">.</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Validation Error */}
        {validationError && (
          <div className="mb-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
            {validationError}
          </div>
        )}

        {/* Input Area */}
        <div className="relative flex items-end gap-2">
          {/* Hidden File Input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />

          {/* Attach Button */}
          <button
            onClick={handleAttachClick}
            disabled={attachments.length >= maxAttachments || isProcessing}
            className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-300 disabled:hover:bg-transparent"
            title={
              attachments.length >= maxAttachments
                ? `Maximum ${maxAttachments} images`
                : 'Attach images'
            }
            aria-label="Attach images"
          >
            <span className="text-2xl">📎</span>
          </button>

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            onCompositionEnd={onCompositionEnd}
            value={value}
            onChange={e => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Type your message..."
            aria-label="Message"
            rows={1}
            className="max-h-[120px] min-h-12 flex-1 resize-none overflow-y-auto rounded-3xl border border-gray-300 px-4 py-3 pr-12 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none md:max-h-[40dvh]"
          />

          {/* Send / Stop Button */}
          {onRequestSoftStop ? (
            <button
              onClick={onRequestSoftStop}
              onMouseDown={keepTextareaFocus}
              disabled={softStopRequested}
              className={`absolute right-2 bottom-2 flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                softStopRequested
                  ? 'bg-gray-300 text-white'
                  : 'bg-red-600 text-white hover:bg-red-700'
              }`}
              title={softStopRequested ? 'Stopping...' : 'Stop after current step'}
              aria-label={softStopRequested ? 'Stopping' : 'Stop after current step'}
            >
              {softStopRequested ? (
                <Spinner size={16} colorClass="border-white" />
              ) : (
                <>
                  <Spinner size={30} colorClass="border-red-300" className="absolute" />
                  <span className="text-[10px]">&#x25A0;</span>
                </>
              )}
            </button>
          ) : (
            <button
              onClick={onSend}
              onMouseDown={keepTextareaFocus}
              disabled={!canSend}
              className="absolute right-2 bottom-2 flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
              title={
                hasPendingToolCalls
                  ? 'Resolve pending tool calls'
                  : isTouchDevice
                    ? 'Send message'
                    : 'Send message (Enter)'
              }
              aria-label={hasPendingToolCalls ? 'Resolve pending tool calls' : 'Send message'}
            >
              {showSendSpinner ? (
                <Spinner size={16} colorClass="border-white" />
              ) : (
                <span className="text-lg">➤</span>
              )}
            </button>
          )}
        </div>
      </div>
      {/* Safe Area Bottom Spacer — always rendered. On iOS,
        env(safe-area-inset-bottom) resolves to 0 while the keyboard is up,
        so this is visually equivalent to the previous conditional render
        without remounting a DOM node on every keyboard transition. */}
      <div className="safe-area-inset-bottom bg-white" />
    </div>
  );
}
