interface AnthropicReasoningConfigProps {
  enableReasoning: boolean;
  setEnableReasoning: (value: boolean) => void;
  reasoningBudgetTokens: string;
  setReasoningBudgetTokens: (value: string) => void;
  thinkingKeepTurns: string;
  setThinkingKeepTurns: (value: string) => void;
  maxOutputTokens: string;
  /** Show as collapsible section with toggle header */
  showHeader?: boolean;
}

export default function AnthropicReasoningConfig({
  enableReasoning,
  setEnableReasoning,
  reasoningBudgetTokens,
  setReasoningBudgetTokens,
  thinkingKeepTurns,
  setThinkingKeepTurns,
  maxOutputTokens,
  showHeader = true,
}: AnthropicReasoningConfigProps) {
  if (showHeader) {
    return (
      <div className="overflow-hidden rounded-lg border border-gray-200">
        {/* Section Header - full width clickable */}
        <label className="flex w-full cursor-pointer items-center justify-between bg-gray-50 px-4 py-3">
          <span className="text-sm font-semibold text-gray-900">Reasoning</span>
          <input
            type="checkbox"
            checked={enableReasoning}
            onChange={e => setEnableReasoning(e.target.checked)}
            className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
          />
        </label>
        {/* Section Content */}
        {enableReasoning && (
          <div className="space-y-4 bg-white p-4">
            <BudgetTokensField
              value={reasoningBudgetTokens}
              onChange={setReasoningBudgetTokens}
              maxOutputTokens={maxOutputTokens}
            />
            <KeepThinkingTurnsField value={thinkingKeepTurns} onChange={setThinkingKeepTurns} />
          </div>
        )}
      </div>
    );
  }

  // Without header - just the fields for embedding in Other Provider Config
  return (
    <div className="space-y-4">
      <label className="flex w-full cursor-pointer items-center justify-between">
        <span className="text-sm font-medium text-gray-900">Enable Reasoning</span>
        <input
          type="checkbox"
          checked={enableReasoning}
          onChange={e => setEnableReasoning(e.target.checked)}
          className="h-5 w-5 cursor-pointer rounded text-blue-600 focus:ring-2 focus:ring-blue-500"
        />
      </label>
      {enableReasoning && (
        <>
          <BudgetTokensField
            value={reasoningBudgetTokens}
            onChange={setReasoningBudgetTokens}
            maxOutputTokens={maxOutputTokens}
          />
          <KeepThinkingTurnsField value={thinkingKeepTurns} onChange={setThinkingKeepTurns} />
        </>
      )}
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
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="1024"
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
      />
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
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none"
      />
    </div>
  );
}
