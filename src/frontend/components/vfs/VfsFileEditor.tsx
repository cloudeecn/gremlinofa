import Spinner from '../ui/Spinner';
import VfsButton from './VfsButton';

interface VfsFileEditorProps {
  value: string;
  onChange: (value: string) => void;
  isDirty: boolean;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
}

/** Plain-text editor body. The file panel owns the draft and the save. */
export default function VfsFileEditor({
  value,
  onChange,
  isDirty,
  saving,
  error,
  onSave,
  onDiscard,
}: VfsFileEditorProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && (
        <div
          role="alert"
          className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1 bg-gray-50 p-3">
        <textarea
          aria-label="File content"
          className="ios-scroll min-h-[240px] w-full flex-1 resize-none overscroll-y-contain rounded-lg border border-gray-300 bg-white p-3 font-mono text-base text-gray-800 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none md:text-sm"
          value={value}
          onChange={event => onChange(event.target.value)}
          onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
              event.preventDefault();
              if (isDirty && !saving) onSave();
            }
          }}
          readOnly={saving}
          spellCheck={false}
        />
      </div>

      <div className="flex items-center gap-3 border-t border-gray-200 bg-white px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <span className="min-w-0 flex-1 truncate text-sm text-gray-500" aria-live="polite">
          {isDirty ? 'Unsaved draft' : 'No changes'}
        </span>
        <VfsButton label="Discard" disabled={!isDirty || saving} onClick={onDiscard} />
        <button
          type="button"
          onClick={onSave}
          disabled={!isDirty || saving}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
        >
          {saving && <Spinner size={14} colorClass="border-white" />}
          Save
        </button>
      </div>
    </div>
  );
}
