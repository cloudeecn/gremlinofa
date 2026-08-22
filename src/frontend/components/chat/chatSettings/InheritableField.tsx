import type { ReactNode } from 'react';

interface InheritableFieldProps {
  label: string;
  hint?: string;
  /** The project's value, shown while inheriting so the choice is informed. */
  inheritedValue: ReactNode;
  isOverridden: boolean;
  onToggle: (override: boolean) => void;
  /** Rendered only while overriding. */
  children: ReactNode;
  /** Muted note for knobs the active provider ignores. */
  note?: string;
}

/**
 * One row of the chat settings form: a label, the project's value, and a
 * two-state segmented control choosing between them.
 *
 * `undefined` means inherit everywhere in `ChatAgentConfig`, so the toggle is
 * the only place that distinction becomes visible — without it, "0.7 because
 * the project says so" and "0.7 because I typed it" look identical, and the
 * user can't tell which one follows a later project change.
 */
export default function InheritableField({
  label,
  hint,
  inheritedValue,
  isOverridden,
  onToggle,
  children,
  note,
}: InheritableFieldProps) {
  const describedById = `${label.replace(/\W+/g, '-').toLowerCase()}-inherited`;

  return (
    <div className="border-t border-gray-100 py-3 first:border-t-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-gray-900">{label}</div>
          {hint && <p className="mt-0.5 text-xs text-gray-500">{hint}</p>}
          {!isOverridden && (
            <p id={describedById} className="mt-1 truncate text-xs text-gray-400">
              Project: {inheritedValue}
            </p>
          )}
          {note && <p className="mt-1 text-xs text-gray-400 italic">{note}</p>}
        </div>
        <div
          role="radiogroup"
          aria-label={`${label} source`}
          className="flex shrink-0 rounded-lg border border-gray-300"
        >
          <button
            type="button"
            role="radio"
            aria-checked={!isOverridden}
            onClick={() => onToggle(false)}
            className={`h-11 rounded-l-lg px-3 text-xs transition-colors ${
              isOverridden ? 'text-gray-600 hover:bg-gray-50' : 'bg-blue-600 text-white'
            }`}
          >
            Inherit
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={isOverridden}
            onClick={() => onToggle(true)}
            className={`h-11 rounded-r-lg border-l border-gray-300 px-3 text-xs transition-colors ${
              isOverridden ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            Override
          </button>
        </div>
      </div>
      {isOverridden && (
        <div className="mt-2" aria-describedby={describedById}>
          {children}
        </div>
      )}
    </div>
  );
}
