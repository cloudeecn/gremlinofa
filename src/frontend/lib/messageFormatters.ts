import type { Message } from '../../shared/protocol/types';
import type { TextRenderBlock } from '../../shared/protocol/types/content';

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

// Every info bar formats a timestamp; building an Intl.DateTimeFormat costs
// ~40x more than calling a cached one.
const TIMESTAMP_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
};
const sameYearFormat = new Intl.DateTimeFormat('en-US', TIMESTAMP_OPTIONS);
const otherYearFormat = new Intl.DateTimeFormat('en-US', {
  ...TIMESTAMP_OPTIONS,
  year: 'numeric',
});

/**
 * Format message timestamp as date + 12-hour time, e.g. `Sep 10, 3:42 PM`.
 * The year is only spelled out when it differs from the current one.
 */
export function formatTimestamp(timestamp: Date, now: Date = new Date()): string {
  const sameYear = timestamp.getFullYear() === now.getFullYear();
  return (sameYear ? sameYearFormat : otherYearFormat).format(timestamp);
}

/**
 * Last `max` characters of a one-line preview. Collapsed tool headers show
 * the end of the text (right-aligned, clipped on the left), so rendering the
 * whole payload of a 200 KB file read into a nowrap span buys nothing.
 */
export function tailPreview(text: string, max = 200): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
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

/**
 * Text of a user message as its bubble shows it: the rendered text blocks,
 * or the raw content minus metadata for messages without rendering content.
 */
export function userMessageText(message: Message<unknown>): string {
  const groups = message.content.renderingContent;
  if (!groups) return stripMetadata(message.content.content);
  return groups
    .flatMap(group => group.blocks)
    .filter((block): block is TextRenderBlock => block.type === 'text')
    .map(block => block.text)
    .join('');
}

/** User-role message that carries tool results back to the model. */
export function isToolResultMessage(message: Message<unknown>): boolean {
  return (
    message.role === 'user' &&
    !!message.content.renderingContent?.some(group =>
      group.blocks.some(block => block.type === 'tool_result')
    )
  );
}

/**
 * One-line summary for the scrubber label: the first line of the text,
 * without leading markdown markers; tool names when there is no text.
 */
export function messagePreviewLine(message: Message<unknown>, max = 120): string {
  if (isToolResultMessage(message)) return 'Tool results';

  const blocks = (message.content.renderingContent ?? []).flatMap(group => group.blocks);
  const text =
    message.role === 'user'
      ? userMessageText(message)
      : blocks
          .filter((block): block is TextRenderBlock => block.type === 'text')
          .map(block => block.text)
          .join('\n');
  const firstLine = text
    .split('\n')
    .map(line => line.replace(/^[\s#>*-]+/, '').trim())
    .find(line => line !== '');
  if (firstLine) return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;

  const toolNames = blocks.flatMap(block => (block.type === 'tool_use' ? [block.name] : []));
  if (toolNames.length > 0) return toolNames.join(', ');
  return message.content.attachmentIds?.length ? 'Attachment' : '…';
}
