import { useEffect, useRef, useState } from 'react';
import type { VfsAdapter } from '../../../../shared/protocol/types/vfs';
import VfsPathPickerModal from '../../project/VfsPathPickerModal';

interface PromptFileListProps {
  paths: string[];
  adapter: VfsAdapter;
  onChange: (paths: string[]) => void;
}

const EXISTS_DEBOUNCE_MS = 400;

/**
 * Editable, ordered list of VFS prompt-file paths.
 *
 * Free text rather than picker-only: paths are recipes resolved at send time,
 * so a file that doesn't exist yet is a legitimate thing to type. The
 * existence badge tells you which of your paths is a typo without turning
 * "not yet" into an error.
 *
 * Order matters — the resolver reads and appends in list order — hence the
 * move buttons rather than a set.
 */
export default function PromptFileList({ paths, adapter, onChange }: PromptFileListProps) {
  const [pickerIndex, setPickerIndex] = useState<number | null>(null);
  const [exists, setExists] = useState<Record<string, boolean>>({});
  const pending = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => {
      let cancelled = false;
      Promise.all(
        paths
          .filter(p => p.trim())
          .map(async p => [p, await adapter.exists(p).catch(() => false)] as const)
      ).then(results => {
        if (!cancelled) setExists(Object.fromEntries(results));
      });
      return () => {
        cancelled = true;
      };
    }, EXISTS_DEBOUNCE_MS);
    return () => window.clearTimeout(pending.current);
  }, [paths, adapter]);

  const replaceAt = (index: number, value: string) =>
    onChange(paths.map((p, i) => (i === index ? value : p)));

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= paths.length) return;
    const next = [...paths];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {paths.map((path, index) => (
        <div key={index} className="flex items-center gap-1">
          <input
            type="text"
            value={path}
            placeholder="/prompts/style.md"
            onChange={e => replaceAt(index, e.target.value)}
            aria-label={`Prompt file ${index + 1}`}
            className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 font-mono text-base focus:border-blue-500 focus:outline-none"
          />
          <span className="w-6 shrink-0 text-center text-sm">
            {path.trim() === '' ? null : exists[path] === undefined ? (
              <span className="text-gray-300">·</span>
            ) : exists[path] ? (
              <span className="text-green-600" title="File exists">
                ✓
              </span>
            ) : (
              <span className="text-gray-400" title="Not found — it will fail at send time">
                ⚠
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => setPickerIndex(index)}
            aria-label={`Browse for prompt file ${index + 1}`}
            className="flex h-11 w-9 shrink-0 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100"
          >
            📁
          </button>
          <button
            type="button"
            onClick={() => move(index, -1)}
            disabled={index === 0}
            aria-label={`Move prompt file ${index + 1} up`}
            className="flex h-11 w-7 shrink-0 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 disabled:opacity-30"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => move(index, 1)}
            disabled={index === paths.length - 1}
            aria-label={`Move prompt file ${index + 1} down`}
            className="flex h-11 w-7 shrink-0 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 disabled:opacity-30"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={() => onChange(paths.filter((_, i) => i !== index))}
            aria-label={`Remove prompt file ${index + 1}`}
            className="flex h-11 w-7 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100"
          >
            ✕
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={() => onChange([...paths, ''])}
        className="h-11 rounded-lg border border-dashed border-gray-300 px-3 text-sm text-gray-600 hover:bg-gray-50"
      >
        + Add file
      </button>

      {pickerIndex !== null && (
        <VfsPathPickerModal
          isOpen
          adapter={adapter}
          initialPath={paths[pickerIndex] || undefined}
          title="Choose a prompt file"
          onCancel={() => setPickerIndex(null)}
          onSelect={path => {
            replaceAt(pickerIndex, path);
            setPickerIndex(null);
          }}
        />
      )}
    </div>
  );
}
