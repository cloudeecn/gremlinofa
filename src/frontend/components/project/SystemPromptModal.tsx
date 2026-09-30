import { useState, useCallback } from 'react';
import Spinner from '../ui/Spinner';
import Modal from '../ui/Modal';
import { clearDraft, useDraftPersistence } from '../../hooks/useDraftPersistence';

const ignoreClose = () => {};

interface SystemPromptModalProps {
  isOpen: boolean;
  /**
   * Draft-persistence key, nothing more — a project id from project settings,
   * a chat id from the chat settings panel. Named for what it does so a
   * non-project caller isn't forced to lie about it.
   */
  contextId: string;
  initialValue: string; // From DB
  title?: string;
  /** True once saved; false keeps the modal open with its draft (the caller reports why). */
  onSave: (value: string) => Promise<boolean>;
  onCancel: () => void;
}

/**
 * Modal for editing a system prompt with draft persistence.
 *
 * IMPORTANT: Parent component must use `key={contextId}` on this component
 * to ensure proper state reset when switching between contexts.
 */
export default function SystemPromptModal({
  isOpen,
  contextId,
  initialValue,
  title = 'System Prompt',
  onSave,
  onCancel,
}: SystemPromptModalProps) {
  const [systemPrompt, setSystemPrompt] = useState(initialValue);
  const [isSaving, setIsSaving] = useState(false);

  const isDirty = systemPrompt !== initialValue;

  useDraftPersistence({
    place: 'system-prompt-modal',
    contextId,
    value: systemPrompt,
    onChange: setSystemPrompt,
    enabled: isOpen,
  });

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      if (await onSave(systemPrompt)) clearDraft('system-prompt-modal', contextId);
    } finally {
      setIsSaving(false);
    }
  }, [systemPrompt, contextId, onSave]);

  const handleCancel = useCallback(() => {
    // Keep draft in localStorage for next time
    onCancel();
  }, [onCancel]);

  const handleRevert = useCallback(() => {
    clearDraft('system-prompt-modal', contextId);
    setSystemPrompt(initialValue);
  }, [contextId, initialValue]);

  return (
    // While a save is in flight every close path waits: closing wouldn't stop it
    <Modal isOpen={isOpen} onClose={isSaving ? ignoreClose : onCancel} size="xl" position="bottom">
      <div className="flex max-h-[85dvh] flex-col rounded-t-2xl bg-white md:max-h-[700px] md:rounded-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 p-4">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button
            onClick={handleCancel}
            disabled={isSaving}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center text-gray-600 transition-colors hover:text-gray-900 disabled:opacity-50"
          >
            <span className="text-2xl leading-none">✕</span>
          </button>
        </div>

        {/* Draft Warning Banner */}
        {isDirty && (
          <div className="flex items-center justify-between border-b border-yellow-200 bg-yellow-50 px-4 py-2">
            <span className="text-sm text-yellow-800">Unsaved changes</span>
            <button
              onClick={handleRevert}
              className="text-sm font-medium text-yellow-700 hover:text-yellow-900"
            >
              Revert
            </button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          <textarea
            value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
            placeholder="Enter system prompt to define the assistant's behavior..."
            className="ios-scroll h-full min-h-[300px] w-full resize-none overflow-y-auto overscroll-y-contain rounded-lg border border-gray-300 bg-white px-3 py-2 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none md:min-h-[400px]"
          />
        </div>

        {/* Footer */}
        <div className="flex gap-3 rounded-b-2xl border-t border-gray-200 bg-white p-4">
          <button
            onClick={handleCancel}
            disabled={isSaving}
            className="flex-1 rounded-lg border border-gray-300 px-4 py-3 font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
          >
            {isSaving && <Spinner size={16} colorClass="border-white" />}
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
