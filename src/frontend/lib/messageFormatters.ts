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
 * Format a token group with an arrow and optional extras.
 * Returns `↑123` when no extras, `↑(123, C↑101, C↓202)` when extras exist.
 */
export function formatTokenGroup(
  arrow: string,
  main: number | undefined,
  extras: { prefix: string; value: number | undefined }[]
): string {
  if (main == null) return '';
  const activeExtras = extras.filter(e => e.value && e.value > 0);
  if (activeExtras.length === 0) {
    return `${arrow}${formatTokenCount(main)}`;
  }
  const parts = [
    formatTokenCount(main),
    ...activeExtras.map(e => `${e.prefix}${formatTokenCount(e.value!)}`),
  ];
  return `${arrow}(${parts.join(', ')})`;
}

/**
 * Format message timestamp as date + 12-hour time, e.g. `Sep 10, 3:42 PM`.
 * The year is only spelled out when it differs from the current one.
 */
export function formatTimestamp(timestamp: Date, now: Date = new Date()): string {
  const sameYear = timestamp.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat('en-US', {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(timestamp);
}

/**
 * Context-fill string for the info bar: `12.5k/200k` when the model's window
 * is known, bare usage otherwise, empty when there is no usage figure.
 */
export function formatContextWindow(usage?: number, max?: number): string {
  if (!usage) return '';
  const used = formatTokenCount(usage);
  return max ? `${used}/${formatTokenCount(max)}` : used;
}

/**
 * Clamp a model id for the one-line info bar. Longer ids keep `max - 1`
 * leading characters plus an ellipsis; the full id belongs in a `title`.
 */
export function truncateModelName(name: string, max = 16): string {
  if (name.length <= max) return name;
  return `${name.slice(0, max - 1)}…`;
}

/**
 * Strip metadata XML tags from message content
 */
export function stripMetadata(content: string): string {
  return content.replace(/^<metadata>.*?<\/metadata>\s*/s, '');
}
