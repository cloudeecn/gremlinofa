import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { activeLoopsStore } from '../../client';
import type { ActiveLoop } from '../../../shared/protocol/protocol';

interface ActiveLoopRowProps {
  loop: ActiveLoop;
  /** True for minion sub-loops; renders with a left indent + tree marker. */
  isChild?: boolean;
  /** Click target for the chat name — usually navigates to the chat. */
  chatLabel: string;
  /** Optional close handler so mobile sidebar overlays dismiss after navigate. */
  onAfterNavigate?: () => void;
}

/**
 * One row in the Running Loops sidebar section. Shows chat/persona name,
 * model, elapsed time, and a hard-abort button. Renders subtly different
 * for parent vs child (minion) loops so the parent/child structure reads
 * at a glance.
 *
 * The elapsed counter ticks every second. We don't bother memoizing it —
 * the row count is small (at most a handful of running loops at once) and
 * the re-render is cheap.
 */
export default function ActiveLoopRow({
  loop,
  isChild,
  chatLabel,
  onAfterNavigate,
}: ActiveLoopRowProps) {
  const navigate = useNavigate();
  const [elapsedSec, setElapsedSec] = useState(() =>
    Math.floor((Date.now() - loop.startedAt) / 1000)
  );

  useEffect(() => {
    const id = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - loop.startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [loop.startedAt]);

  const handleNavigate = () => {
    navigate(`/chat/${loop.chatId}`);
    onAfterNavigate?.();
  };

  const handleAbort = (e: React.MouseEvent) => {
    e.stopPropagation();
    void activeLoopsStore.abort(loop.loopId);
  };

  const elapsedLabel = formatElapsed(elapsedSec);
  const aborting = loop.status === 'aborting';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleNavigate}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleNavigate();
        }
      }}
      className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-gray-800 ${
        isChild ? 'ml-3 border-l border-gray-700 pl-3' : ''
      } ${aborting ? 'opacity-60' : ''}`}
    >
      {/* Status pip */}
      <span
        className={`h-2 w-2 flex-shrink-0 rounded-full ${
          aborting ? 'animate-pulse bg-yellow-500' : 'animate-pulse bg-green-500'
        }`}
        aria-label={aborting ? 'Aborting' : 'Running'}
      />

      {/* Label + model */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-gray-200">{loop.displayName ?? chatLabel}</div>
        <div className="truncate text-[10px] text-gray-500">
          {loop.modelId} · {elapsedLabel}
        </div>
      </div>

      {/* Hard-abort button — disabled while already aborting */}
      <button
        onClick={handleAbort}
        disabled={aborting}
        className="flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-900/50 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
        title={aborting ? 'Abort already in progress' : 'Hard abort this loop'}
      >
        {aborting ? '...' : 'STOP'}
      </button>
    </div>
  );
}

/** Format an elapsed-second count as `12s`, `2m 14s`, or `1h 03m`. */
function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s.toString().padStart(2, '0')}s`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}
