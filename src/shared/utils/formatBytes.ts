/**
 * Format bytes to human-readable string
 * @param bytes - Number of bytes
 * @param decimals - Number of decimal places (default: 1)
 * @returns Formatted string like "150 MB" or "2.5 GB"
 */
export function formatBytes(bytes: number, decimals: number = 1): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Format storage display with usage, quota, percentage, and color coding
 * @param usage - Bytes used
 * @param quota - Total bytes available
 * @returns Object with formatted text, color class, and percentage
 */
export function formatStorageDisplay(
  usage: number,
  quota: number
): {
  text: string;
  colorClass: string;
  percentage: number;
} {
  const percentage = Math.round((usage / quota) * 100);
  const text = `${formatBytes(usage)} / ${formatBytes(quota)} (${percentage}%)`;

  let colorClass = 'text-gray-700'; // Normal (≤50%)
  if (percentage > 80) {
    colorClass = 'text-red-700'; // Critical (>80%)
  } else if (percentage > 50) {
    colorClass = 'text-yellow-700'; // Warning (>50%)
  }

  return { text, colorClass, percentage };
}

/**
 * Check if storage warning should be shown
 * Warning shows when EITHER:
 * - Usage > 100MB (absolute threshold), OR
 * - Usage > 50% of quota (percentage threshold)
 *
 * @param usage - Bytes used
 * @param quota - Total bytes available
 * @returns True if warning should be shown
 */
export function shouldShowStorageWarning(usage: number, quota: number): boolean {
  const ABSOLUTE_THRESHOLD = 100 * 1024 * 1024; // 100 MB
  const PERCENTAGE_THRESHOLD = 0.5; // 50%

  return usage > ABSOLUTE_THRESHOLD || usage / quota > PERCENTAGE_THRESHOLD;
}
