/**
 * Format token counts for display (e.g., "12.5k" for large numbers)
 */
export function formatTokenCount(tokens: number): string {
  if (tokens > 10000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return tokens.toString();
}

/**
 * Format tokens with prefix, return empty string if zero/undefined
 */
export function formatTokens(prefix: string, tokens?: number): string {
  if (!tokens || tokens === 0) return '';
  return `${prefix}${formatTokenCount(tokens)}`;
}

/**
 * Format message timestamp (12-hour format with AM/PM)
 */
export function formatTimestamp(timestamp: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(timestamp);
}

/**
 * Strip metadata XML tags from message content
 */
export function stripMetadata(content: string): string {
  return content.replace(/^<metadata>.*?<\/metadata>\s*/s, '');
}
