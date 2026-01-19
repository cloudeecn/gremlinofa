interface PendingToolCallsBannerProps {
  toolCount: number;
  onReject: () => void;
  onAccept: () => void;
}

/**
 * Banner shown when there are unresolved tool calls (e.g., due to token limit).
 * Provides Reject/Accept buttons, or user can send a message to reject with context.
 */
export default function PendingToolCallsBanner({
  toolCount,
  onReject,
  onAccept,
}: PendingToolCallsBannerProps) {
  return (
    <div className="mx-4 mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
      <div className="mb-2 text-sm text-amber-800">
        <span className="font-medium">
          ⚠️ {toolCount} pending tool call{toolCount > 1 ? 's' : ''}
        </span>
        <span className="ml-1 text-amber-600">— choose an action or send a message to reject</span>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={onReject}
          className="rounded-lg border border-gray-300 bg-white px-4 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-50"
        >
          Reject
        </button>
        <button
          onClick={onAccept}
          className="rounded-lg bg-amber-600 px-4 py-1.5 text-sm text-white transition-colors hover:bg-amber-700"
        >
          Accept
        </button>
      </div>
    </div>
  );
}
