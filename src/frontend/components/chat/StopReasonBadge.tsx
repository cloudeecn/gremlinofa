import type { MessageStopReason } from '../../../shared/protocol/types/content';

export interface StopReasonBadgeProps {
  stopReason: MessageStopReason;
}

/**
 * StopReasonBadge displays a badge for non-normal message endings.
 * Only shown when stop reason is not 'end_turn' (normal completion).
 */
export default function StopReasonBadge({ stopReason }: StopReasonBadgeProps) {
  // Don't show badge for normal completion
  if (stopReason === 'end_turn') return null;

  const { icon, label, className } = getStopReasonDisplay(stopReason);

  return (
    <span
      className={`stop-reason-badge inline-flex items-center gap-1 text-[10px] ${className}`}
      title={`Message stopped: ${stopReason}`}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </span>
  );
}

function getStopReasonDisplay(stopReason: MessageStopReason): {
  icon: string;
  label: string;
  className: string;
} {
  switch (stopReason) {
    case 'max_tokens':
      return {
        icon: '⚠️',
        label: 'Truncated',
        className: 'text-yellow-800',
      };
    case 'stop_sequence':
      return {
        icon: '🛑',
        label: 'Stop Sequence',
        className: 'text-orange-800',
      };
    case 'error':
      return {
        icon: '❌',
        label: 'Error',
        className: 'text-red-800',
      };
    case 'cancelled':
      return {
        icon: '⏹️',
        label: 'Cancelled',
        className: 'text-gray-800',
      };
    case 'end_turn':
      return {
        icon: '✅',
        label: 'Done',
        className: 'text-gray-800',
      };
    default:
      // Unknown stop reason - display as-is
      return {
        icon: 'ℹ️',
        label: stopReason,
        className: 'text-blue-800',
      };
  }
}
