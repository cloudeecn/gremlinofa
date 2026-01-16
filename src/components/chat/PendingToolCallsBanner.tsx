interface PendingToolCallsBannerProps {
  toolCount: number;
  mode: 'stop' | 'continue';
  onModeChange: (mode: 'stop' | 'continue') => void;
}

/**
 * Banner shown when there are unresolved tool calls (e.g., due to token limit).
 * Allows user to choose between stopping (error response) or continuing (execute tools).
 */
export default function PendingToolCallsBanner({
  toolCount,
  mode,
  onModeChange,
}: PendingToolCallsBannerProps) {
  return (
    <div className="mx-4 mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
      <div className="mb-2 text-sm text-amber-800">
        <span className="font-medium">
          ⚠️ {toolCount} pending tool call{toolCount > 1 ? 's' : ''}
        </span>
        <span className="ml-1 text-amber-600">— send a message to resolve</span>
      </div>
      <div className="flex items-center gap-4">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name="toolMode"
            checked={mode === 'stop'}
            onChange={() => onModeChange('stop')}
            className="h-4 w-4 text-amber-600 focus:ring-amber-500"
          />
          <span className="text-sm text-gray-700">Skip (skip tools)</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name="toolMode"
            checked={mode === 'continue'}
            onChange={() => onModeChange('continue')}
            className="h-4 w-4 text-amber-600 focus:ring-amber-500"
          />
          <span className="text-sm text-gray-700">Run (run tools)</span>
        </label>
      </div>
    </div>
  );
}
