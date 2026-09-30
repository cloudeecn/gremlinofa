import type { CarriedInjection } from '../../../shared/protocol/types';

type Side = 'before' | 'after';

/**
 * The injected files the composer will send with the message, one removable
 * chip each. Files come from an edited message; removing one is the only way
 * to drop it.
 */
export default function CarriedFilesStrip({
  injection,
  onRemove,
}: {
  injection: CarriedInjection;
  onRemove: (side: Side, index: number) => void;
}) {
  const row = (side: Side, label: string) => {
    const files = injection[side];
    if (files.length === 0) return null;
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-gray-500">{label}</span>
        {files.map((file, index) => (
          <span
            key={`${side}-${index}`}
            className="inline-flex max-w-full items-center rounded border border-gray-200 bg-white pl-2 text-gray-700"
          >
            <span className="truncate">📄 {file.path}</span>
            <button
              onClick={() => onRemove(side, index)}
              aria-label={`Remove ${file.path}`}
              className="flex h-7 w-7 shrink-0 items-center justify-center text-gray-400 hover:text-red-600"
            >
              ×
            </button>
          </span>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-1 border-t border-gray-200 bg-gray-50 px-4 py-2 text-xs">
      {row('before', 'Files before your text:')}
      {row('after', 'Files after your text:')}
    </div>
  );
}
