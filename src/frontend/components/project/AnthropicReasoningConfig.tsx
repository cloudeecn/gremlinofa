interface AnthropicReasoningConfigProps {
  reasoningBudgetTokens: string;
  setReasoningBudgetTokens: (value: string) => void;
  thinkingKeepTurns: string;
  setThinkingKeepTurns: (value: string) => void;
  pruneThinkingBeforeApiCall: boolean;
  setPruneThinkingBeforeApiCall: (value: boolean) => void;
  maxOutputTokens: string;
}

/**
 * Anthropic/Bedrock Claude reasoning configuration fields.
 * Embedded-only component for use within the unified Reasoning section.
 */
export default function AnthropicReasoningConfig({
  reasoningBudgetTokens,
  setReasoningBudgetTokens,
  thinkingKeepTurns,
  setThinkingKeepTurns,
  pruneThinkingBeforeApiCall,
  setPruneThinkingBeforeApiCall,
  maxOutputTokens,
}: AnthropicReasoningConfigProps) {
  const keepTurnsParsed = parseInt(thinkingKeepTurns);
  const keepTurnsValid =
    thinkingKeepTurns !== '' && !isNaN(keepTurnsParsed) && keepTurnsParsed >= 0;
  return (
    <div className="space-y-4">
      <BudgetTokensField
        value={reasoningBudgetTokens}
        onChange={setReasoningBudgetTokens}
        maxOutputTokens={maxOutputTokens}
      />
      <KeepThinkingTurnsField value={thinkingKeepTurns} onChange={setThinkingKeepTurns} />
      <PruneThinkingField
        value={pruneThinkingBeforeApiCall}
        onChange={setPruneThinkingBeforeApiCall}
        enabled={keepTurnsValid}
      />
    </div>
  );
}

function BudgetTokensField({
  value,
  onChange,
  maxOutputTokens,
}: {
  value: string;
  onChange: (value: string) => void;
  maxOutputTokens: string;
}) {
  const budgetNum = parseInt(value) || 0;
  const maxTokensNum = parseInt(maxOutputTokens) || 0;
  const showWarning = maxTokensNum <= budgetNum;
  const adjustedValue = budgetNum + 500;

  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-gray-900">Budget Tokens</label>
      {showWarning && (
        <p className="mb-2 text-xs text-yellow-700 italic">
          Max Output Tokens will be auto-adjusted to {adjustedValue} for Anthropic
        </p>
      )}
      <input
        type="number"
        min="0"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="1024"
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
      />
      <p className="mt-1 text-xs text-gray-500">
        Set to 0 for adaptive reasoning on supported models (Opus 4.6, Sonnet 4.6).
      </p>
    </div>
  );
}

function KeepThinkingTurnsField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-gray-900">Keep Thinking Turns</label>
      <p className="mb-2 text-xs text-gray-500">
        Opus 4.5 keeps all turns by default; other models keep 1 turn. Use -1 for "all".
      </p>
      <input
        type="number"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="Model default"
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
      />
    </div>
  );
}

function PruneThinkingField({
  value,
  onChange,
  enabled,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  enabled: boolean;
}) {
  return (
    <div>
      <label className="flex items-start gap-2 text-sm font-medium text-gray-900">
        <input
          type="checkbox"
          checked={enabled && value}
          disabled={!enabled}
          onChange={e => onChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        />
        <span className={enabled ? '' : 'text-gray-400'}>
          Prune thinking blocks before API call
        </span>
      </label>
      <p className="mt-1 ml-6 text-xs text-gray-500">
        {enabled
          ? 'Strip thinking blocks beyond Keep Thinking Turns locally so they aren’t sent. Useful for providers that bill input tokens before any server-side context edits.'
          : 'Set Keep Thinking Turns to a number (0 or higher) to enable client-side pruning.'}
      </p>
    </div>
  );
}
