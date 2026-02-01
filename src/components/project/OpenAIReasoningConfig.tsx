import type { ReasoningEffort, ReasoningSummary } from '../../types';

interface OpenAIReasoningConfigProps {
  reasoningEffort: ReasoningEffort;
  setReasoningEffort: (value: ReasoningEffort) => void;
  reasoningSummary: ReasoningSummary;
  setReasoningSummary: (value: ReasoningSummary) => void;
}

/**
 * OpenAI/Responses/Nova reasoning configuration fields.
 * Embedded-only component for use within the unified Reasoning section.
 */
export default function OpenAIReasoningConfig({
  reasoningEffort,
  setReasoningEffort,
  reasoningSummary,
  setReasoningSummary,
}: OpenAIReasoningConfigProps) {
  return (
    <div className="space-y-4">
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-900">Reasoning Effort</label>
        <select
          value={reasoningEffort ?? ''}
          onChange={e =>
            setReasoningEffort(
              e.target.value === '' ? undefined : (e.target.value as ReasoningEffort)
            )
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
        </select>
        <p className="mt-1 text-xs text-gray-500">Higher effort preferred for complex tasks</p>
      </div>
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-900">Reasoning Summary</label>
        <select
          value={reasoningSummary ?? ''}
          onChange={e =>
            setReasoningSummary(
              e.target.value === '' ? undefined : (e.target.value as ReasoningSummary)
            )
          }
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
        >
          <option value="">(default)</option>
          <option value="auto">Auto</option>
          <option value="concise">Concise</option>
          <option value="detailed">Detailed</option>
        </select>
      </div>
    </div>
  );
}
