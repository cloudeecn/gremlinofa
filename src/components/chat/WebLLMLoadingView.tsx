/**
 * WebLLM Model Loading View
 *
 * Displays progress while downloading and initializing local models.
 * Shows download progress, status text, and model size info.
 */

import { formatSize } from '../../services/api/webllmModelInfo';
import { useIsMobile } from '../../hooks/useIsMobile';

export interface WebLLMLoadingProgress {
  /** Status text from WebLLM (e.g., "Downloading model...", "Loading model...") */
  text: string;
  /** Progress percentage (0-100), -1 if unknown */
  progress: number;
  /** Time remaining estimate in seconds, if available */
  timeRemaining?: number;
}

interface WebLLMLoadingViewProps {
  /** Model display name */
  modelName: string;
  /** Model download size in bytes */
  downloadSize?: number;
  /** Current loading progress */
  progress: WebLLMLoadingProgress;
}

export default function WebLLMLoadingView({
  modelName,
  downloadSize,
  progress,
}: WebLLMLoadingViewProps) {
  const isMobile = useIsMobile();

  // Parse progress text to determine phase
  const isDownloading = progress.text.toLowerCase().includes('download');
  const isLoading = progress.text.toLowerCase().includes('load');
  const progressPercent =
    progress.progress >= 0 ? Math.min(100, Math.max(0, progress.progress)) : 0;
  const hasProgress = progress.progress >= 0;

  // Format time remaining
  const formatTimeRemaining = (seconds: number): string => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${Math.round(seconds / 3600)}h`;
  };

  return (
    <div className="mb-4 px-4">
      <div className={`${isMobile ? 'w-full' : 'max-w-[85%]'}`}>
        <div
          className={
            isMobile
              ? 'rounded-xl bg-blue-50 p-4'
              : 'rounded-2xl bg-gradient-to-r from-blue-50 to-indigo-50 px-5 py-4 shadow-sm'
          }
        >
          {/* Header */}
          <div className="mb-3 flex items-center">
            <span className="mr-2 text-xl">🏠</span>
            <div className="flex-1">
              <div className="text-sm font-semibold text-gray-900">Loading Local Model</div>
              <div className="text-xs text-gray-600">{modelName}</div>
            </div>
            {downloadSize && (
              <div className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                {formatSize(downloadSize)}
              </div>
            )}
          </div>

          {/* Status text */}
          <div className="mb-2 flex items-center text-sm text-gray-700">
            {isDownloading && <span className="mr-2">📥</span>}
            {isLoading && !isDownloading && <span className="mr-2">⚙️</span>}
            <span className="flex-1 truncate">{progress.text}</span>
            {progress.timeRemaining && progress.timeRemaining > 0 && (
              <span className="ml-2 text-xs text-gray-500">
                ~{formatTimeRemaining(progress.timeRemaining)}
              </span>
            )}
          </div>

          {/* Progress bar */}
          {hasProgress && (
            <div className="mb-1 h-2 overflow-hidden rounded-full bg-gray-200">
              <div
                className="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          )}

          {/* Progress text */}
          <div className="flex items-center justify-between text-xs text-gray-500">
            {hasProgress ? (
              <span>{progressPercent.toFixed(0)}%</span>
            ) : (
              <span className="animate-pulse">Initializing...</span>
            )}
            <span className="text-gray-400">First load may take a while</span>
          </div>
        </div>
      </div>
    </div>
  );
}
