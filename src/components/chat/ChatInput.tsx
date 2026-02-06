import { useEffect, useRef, useState, useCallback } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useIsKeyboardVisible } from '../../hooks/useIsKeyboardVisible';
import Spinner from '../ui/Spinner';
import type { ChatInputProps } from './types';

export default function ChatInput({
  value,
  onChange,
  onSend,
  disabled,
  attachments,
  onFilesAdded,
  onRemoveAttachment,
  maxAttachments = 10,
  isProcessing = false,
  showSendSpinner = false,
  hasPendingToolCalls = false,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();
  const keyboardVisible = useIsKeyboardVisible();
  const [validationError, setValidationError] = useState<string>('');

  // Auto-resize textarea based on content
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // On mobile, let Enter key insert newline naturally (like RN version)
    // On desktop, send on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault();
      if (value.trim() && !disabled && !isProcessing) {
        onSend();
      }
    }
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

    setValidationError('');

    // Check total count
    const totalCount = attachments.length + files.length;
    if (totalCount > maxAttachments) {
      setValidationError(
        `Maximum ${maxAttachments} images allowed. You can add ${maxAttachments - attachments.length} more.`
      );
      return;
    }

    // Filter for image files only
    const imageFiles = files.filter(file => file.type.startsWith('image/'));
    if (imageFiles.length < files.length) {
      setValidationError('Only image files are allowed');
    }

    if (imageFiles.length > 0) {
      // Pass files to parent for processing
      onFilesAdded(imageFiles);
    }

    // Reset input so same file can be selected again
    e.target.value = '';
  };

  const handleRemoveAttachment = (id: string) => {
    onRemoveAttachment(id);
    setValidationError('');
  };

  // Clear validation error after 5 seconds
  useEffect(() => {
    if (validationError) {
      const timer = setTimeout(() => setValidationError(''), 5000);
      return () => clearTimeout(timer);
    }
  }, [validationError]);

  // iOS keyboard fix: scroll textarea into view after focus
  // Delays slightly to let iOS finish keyboard animation
  const handleFocus = useCallback(() => {
    if (!textareaRef.current) return;

    // Small delay to let iOS keyboard appear and visualViewport update
    setTimeout(() => {
      textareaRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }, 100);
  }, []);

  return (
    <div className="flex w-full flex-col">
      <div className="border-t border-gray-200 bg-white p-4">
        {/* Thumbnail Preview Grid - uses processed MessageAttachment data: URLs */}
        {attachments.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {attachments.map(attachment => (
              <div
                key={attachment.id}
                className="relative h-20 w-20 overflow-hidden rounded-lg border border-gray-300"
              >
                <img
                  src={`data:${attachment.mimeType};base64,${attachment.data}`}
                  alt="Attachment preview"
                  className="h-full w-full object-cover"
                />
                <button
                  onClick={() => handleRemoveAttachment(attachment.id)}
                  className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs text-white hover:bg-red-600"
                  title="Remove image"
                >
                  ✕
                </button>
              </div>
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
            disabled={disabled || attachments.length >= maxAttachments || isProcessing}
            className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-300 disabled:hover:bg-transparent"
            title={
              attachments.length >= maxAttachments
                ? `Maximum ${maxAttachments} images`
                : 'Attach images'
            }
          >
            <span className="text-2xl">📎</span>
          </button>

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={e => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={handleFocus}
            placeholder="Type your message..."
            disabled={disabled}
            rows={1}
            className="flex-1 resize-none rounded-3xl border border-gray-300 px-4 py-3 pr-12 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none disabled:bg-gray-100 disabled:text-gray-500"
            style={{ minHeight: '48px', maxHeight: '120px' }}
          />

          {/* Send Button */}
          <button
            onClick={onSend}
            disabled={
              (!value.trim() && attachments.length === 0 && !hasPendingToolCalls) ||
              disabled ||
              isProcessing ||
              showSendSpinner
            }
            className="absolute right-2 bottom-2 flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            title={hasPendingToolCalls ? 'Resolve pending tool calls' : 'Send message (Enter)'}
          >
            {showSendSpinner ? (
              <Spinner size={16} colorClass="border-white" />
            ) : (
              <span className="text-lg">➤</span>
            )}
          </button>
        </div>
      </div>
      {/* Safe Area Bottom Spacer - hidden when keyboard covers home indicator */}
      {!keyboardVisible && <div className="safe-area-inset-bottom bg-white" />}
    </div>
  );
}
