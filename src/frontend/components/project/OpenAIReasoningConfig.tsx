import type { ReasoningSummary } from '../../../shared/protocol/types';

interface OpenAIReasoningConfigProps {
  reasoningSummary: ReasoningSummary;
  setReasoningSummary: (value: ReasoningSummary) => void;
}

/**
 * Reasoning summary control (shared across providers).
 * - OpenAI/Responses: maps to `reasoning.summary` (auto/concise/detailed).
 * - Anthropic/Bedrock Claude: any non-default value opts into `thinking.display: summarized`
 *   so thinking content is returned. Required on Opus 4.7+ (server default is `omitted`).
 */
export default function OpenAIReasoningConfig({
  reasoningSummary,
  setReasoningSummary,
}: OpenAIReasoningConfigProps) {
  return (
    <div className="space-y-4">
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
        <p className="mt-1 text-xs text-gray-500">
          OpenAI/Responses: summary granularity. Anthropic: any value opts into summarized thinking
          (Opus 4.7 hides it by default).
        </p>
      </div>
    </div>
  );
}
