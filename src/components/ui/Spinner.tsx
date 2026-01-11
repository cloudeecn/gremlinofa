/**
 * Inline spinner component for buttons and loading states.
 * Uses CSS animation (Tailwind's animate-spin).
 */

interface SpinnerProps {
  /** Size in pixels (default: 16) */
  size?: number;
  /** Color class (default: 'border-current') */
  colorClass?: string;
  /** Additional classes */
  className?: string;
}

export default function Spinner({
  size = 16,
  colorClass = 'border-current',
  className = '',
}: SpinnerProps) {
  return (
    <div
      className={`animate-spin rounded-full border-2 border-t-transparent ${colorClass} ${className}`}
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
    />
  );
}
