import { useState, useCallback } from 'react';
import Spinner from '../ui/Spinner';
import Modal from '../ui/Modal';

interface LongtextOptionEditorProps {
  isOpen: boolean;
  title: string;
  value: string;
  placeholder?: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}

/**
 * Modal for editing longtext tool options (like system prompts for tools).
 */
export default function LongtextOptionEditor({
  isOpen,
  title,
  value: initialValue,
  placeholder,
  onSave,
  onCancel,
}: LongtextOptionEditorProps) {
  const [value, setValue] = useState(initialValue);
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = useCallback(() => {
    setIsSaving(true);
    try {
      onSave(value);
    } finally {
      setIsSaving(false);
    }
  }, [value, onSave]);

  return (
    <Modal isOpen={isOpen} onClose={onCancel} size="xl" position="bottom">
      <div className="flex max-h-[85vh] flex-col rounded-t-2xl bg-white md:max-h-[700px] md:rounded-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 p-4">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button
            onClick={onCancel}
            className="flex h-11 w-11 items-center justify-center text-gray-600 transition-colors hover:text-gray-900"
          >
            <span className="text-2xl leading-none">✕</span>
          </button>
        </div>

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
            onClick={onCancel}
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
