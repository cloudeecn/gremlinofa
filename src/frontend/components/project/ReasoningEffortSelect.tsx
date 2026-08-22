import type { ReasoningEffort } from '../../../shared/protocol/types';

interface ReasoningEffortSelectProps {
  value: ReasoningEffort | undefined;
  onChange: (value: ReasoningEffort | undefined) => void;
  /** Label above the select; pass '' to render none (the chat panel supplies its own). */
  label?: string;
  hint?: string;
  id?: string;
}

/**
 * Effort dropdown shared by project settings and the chat settings panel.
 * `''` is the "(default)" sentinel — the value is `undefined`, not a level.
 */
export default function ReasoningEffortSelect({
  value,
  onChange,
  label = 'Reasoning Effort',
  hint = 'Used by OpenAI/Nova models directly. For Anthropic adaptive reasoning (budget = 0), maps to output effort.',
  id,
}: ReasoningEffortSelectProps) {
  return (
    <div>
      {label && (
        <label htmlFor={id} className="mb-2 block text-sm font-medium text-gray-900">
          {label}
        </label>
      )}
      <select
        id={id}
        value={value ?? ''}
        onChange={e =>
          onChange(e.target.value === '' ? undefined : (e.target.value as ReasoningEffort))
        }
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
      >
        <option value="">(default)</option>
        <option value="none">None</option>
        <option value="minimal">Minimal</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
        <option value="xhigh">Extra High</option>
        <option value="max">Max</option>
      </select>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}
