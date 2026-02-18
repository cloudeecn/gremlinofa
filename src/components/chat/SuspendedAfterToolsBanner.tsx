import { useState } from 'react';

interface SuspendedAfterToolsBannerProps {
  onContinue: () => void;
}

/**
 * Banner shown when the agentic loop was soft-stopped after tool execution.
 * Tool results are persisted — user can continue or send a message instead.
 */
export default function SuspendedAfterToolsBanner({ onContinue }: SuspendedAfterToolsBannerProps) {
  const [acting, setActing] = useState(false);

  return (
    <div className="mx-4 mb-3 rounded-lg border border-blue-300 bg-blue-50 p-3">
      <div className="mb-2 text-sm text-blue-800">
        <span className="font-medium">⏸ Loop paused</span>
        <span className="ml-1 text-blue-600">— tool results ready, or send a message</span>
      </div>
      <button
        onClick={() => {
          setActing(true);
          onContinue();
        }}
        disabled={acting}
        className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Continue
      </button>
    </div>
  );
}
