import { useState, useCallback } from 'react';
import Modal from '../ui/Modal';
import {
  clearDraft,
  clearDraftDifference,
  useDraftPersistence,
} from '../../hooks/useDraftPersistence';

interface SystemPromptModalProps {
  isOpen: boolean;
  projectId: string;
  initialValue: string; // From DB
  onSave: (value: string) => void;
  onCancel: () => void;
}

/**
 * Get initial value for system prompt, checking for draft first.
 */
function getInitialSystemPrompt(projectId: string, dbValue: string): string {
  const draftKey = `draft_system-prompt-modal_${projectId}`;
  const stored = localStorage.getItem(draftKey);
  if (stored) {
    // Draft exists for this project, will be restored by useDraftPersistence
    // Return dbValue as placeholder; onChange will update it
    return dbValue;
  }
  return dbValue;
}

export default function SystemPromptModal({
  isOpen,
  projectId,
  initialValue,
  onSave,
  onCancel,
}: SystemPromptModalProps) {
  // Use key to force remount when modal opens with different project
  // This avoids setState in useEffect for reset behavior
  const [systemPrompt, setSystemPrompt] = useState(() =>
    getInitialSystemPrompt(projectId, initialValue)
  );

  // Draft persistence with difference detection
  const { hasDraftDifference } = useDraftPersistence({
    place: 'system-prompt-modal',
    contextId: projectId,
    value: systemPrompt,
    onChange: setSystemPrompt,
    enabled: isOpen,
    initialDbValue: initialValue,
  });

  const handleSave = useCallback(() => {
    clearDraft('system-prompt-modal', projectId);
    clearDraftDifference('system-prompt-modal', projectId);
    onSave(systemPrompt);
  }, [systemPrompt, projectId, onSave]);

  const handleCancel = useCallback(() => {
    // Keep draft in localStorage for next time
    onCancel();
  }, [onCancel]);

  const handleDiscardDraft = useCallback(() => {
    clearDraft('system-prompt-modal', projectId);
    clearDraftDifference('system-prompt-modal', projectId);
    setSystemPrompt(initialValue);
  }, [projectId, initialValue]);

  return (
    <Modal isOpen={isOpen} onClose={onCancel} size="xl" position="bottom">
      <div className="flex max-h-[85vh] flex-col rounded-t-2xl bg-white md:max-h-[700px] md:rounded-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 p-4">
          <h2 className="text-lg font-semibold text-gray-900">System Prompt</h2>
          <button
            onClick={handleCancel}
            className="flex h-11 w-11 items-center justify-center text-gray-600 transition-colors hover:text-gray-900"
          >
            <span className="text-2xl leading-none">✕</span>
          </button>
        </div>

        {/* Draft Warning Banner */}
        {hasDraftDifference && (
          <div className="flex items-center justify-between border-b border-yellow-200 bg-yellow-50 px-4 py-2">
            <span className="text-sm text-yellow-800">📝 Draft loaded (differs from saved)</span>
            <button
              onClick={handleDiscardDraft}
              className="text-sm font-medium text-yellow-700 hover:text-yellow-900"
            >
              Discard
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
            autoFocus
          />
        </div>

        {/* Footer */}
        <div className="flex gap-3 rounded-b-2xl border-t border-gray-200 bg-white p-4">
          <button
            onClick={handleCancel}
            className="flex-1 rounded-lg border border-gray-300 px-4 py-3 font-semibold text-gray-700 transition-colors hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex-1 rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white transition-colors hover:bg-blue-700"
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
