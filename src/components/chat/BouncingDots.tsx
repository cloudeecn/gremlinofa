/**
 * Bouncing dots component for streaming/loading indicators.
 * Uses CSS animation defined in index.css.
 */
export default function BouncingDots() {
  return (
    <div className="flex gap-1">
      <span className="bouncing-dot text-gray-500">•</span>
      <span className="bouncing-dot text-gray-500">•</span>
      <span className="bouncing-dot text-gray-500">•</span>
    </div>
  );
}
