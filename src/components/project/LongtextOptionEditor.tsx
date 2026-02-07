import { useState, useCallback } from 'react';
import Spinner from '../ui/Spinner';
import Modal from '../ui/Modal';
import { clearDraft, useDraftPersistence } from '../../hooks/useDraftPersistence';

interface LongtextOptionEditorProps {
  isOpen: boolean;
  title: string;
  value: string;
  placeholder?: string;
  /** Project ID for draft persistence context */
  projectId: string;
  /** Tool name for draft persistence key */
  toolName: string;
  /** Option ID for draft persistence key */
  optionId: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}

/**
 * Build the context ID for draft persistence.
 * Format: projectId|toolName|optionId
 */
function buildContextId(projectId: string, toolName: string, optionId: string): string {
  return `${projectId}|${toolName}|${optionId}`;
}

/**
 * Modal for editing longtext tool options (like system prompts for tools).
 * Integrates with draft persistence for auto-save/restore functionality.
 */
export default function LongtextOptionEditor({
  isOpen,
  title,
  value: initialValue,
  placeholder,
  projectId,
  toolName,
  optionId,
  onSave,
  onCancel,
}: LongtextOptionEditorProps) {
  const [value, setValue] = useState(initialValue);
  const [isSaving, setIsSaving] = useState(false);

  const contextId = buildContextId(projectId, toolName, optionId);

  const isDirty = value !== initialValue;

  useDraftPersistence({
    place: 'tool-option-longtext',
    contextId,
    value,
    onChange: setValue,
    enabled: isOpen,
  });

  const handleSave = useCallback(() => {
    setIsSaving(true);
    try {
      clearDraft('tool-option-longtext', contextId);
      onSave(value);
    } finally {
      setIsSaving(false);
    }
  }, [value, contextId, onSave]);

  const handleCancel = useCallback(() => {
    // Keep draft in localStorage for next time
    onCancel();
  }, [onCancel]);

  const handleRevert = useCallback(() => {
    clearDraft('tool-option-longtext', contextId);
    setValue(initialValue);
  }, [contextId, initialValue]);

  return (
    <Modal isOpen={isOpen} onClose={onCancel} size="xl" position="bottom">
      <div className="flex max-h-[85vh] flex-col rounded-t-2xl bg-white md:max-h-[700px] md:rounded-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 p-4">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button
            onClick={handleCancel}
            className="flex h-11 w-11 items-center justify-center text-gray-600 transition-colors hover:text-gray-900"
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
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder={placeholder}
            className="ios-scroll h-full min-h-[300px] w-full resize-none overflow-y-auto overscroll-y-contain rounded-lg border border-gray-300 bg-white px-3 py-2 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none md:min-h-[400px]"
            autoFocus
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
