import { useState } from 'react';

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
  const [acting, setActing] = useState(false);

  return (
    <div className="mx-4 mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
      <div className="mb-2 text-sm text-amber-800">
        <span className="font-medium">
          ⏸ Loop paused — {toolCount} pending tool call{toolCount > 1 ? 's' : ''}
        </span>
        <span className="ml-1 text-amber-600">— send a message to reject with context</span>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={() => {
            setActing(true);
            onReject();
          }}
          disabled={acting}
          className="rounded-lg border border-gray-300 bg-white px-4 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reject &amp; Continue
        </button>
        <button
          onClick={() => {
            setActing(true);
            onAccept();
          }}
          disabled={acting}
          className="rounded-lg bg-amber-600 px-4 py-1.5 text-sm text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Accept &amp; Continue
        </button>
      </div>
    </div>
  );
}
