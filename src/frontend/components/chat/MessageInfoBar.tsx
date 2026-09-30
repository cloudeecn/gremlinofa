import { useState, type ReactNode } from 'react';
import type { MessageMetadata } from '../../../shared/protocol/types';
import { formatTimestamp, formatTokenGroup, truncateModelName } from '../../lib/messageFormatters';

export interface MessageInfoBarProps {
  timestamp: Date;
  /** `end` right-aligns both rows (user bubble). */
  align?: 'start' | 'end';
  /**
   * Requested vs. served model ids. Only the served id is ever shown — red when
   * it differs from the requested one, `-` when the provider reported none.
   * Never falls back to the requested id: a missing served model must read as
   * missing, not as a fake match.
   */
  model?: { requested?: string; served?: string };
  /** Pre-formatted context fill, e.g. `12.5k/200k`. */
  contextText?: string;
  cost?: number;
  /** Source of the expanded row's `↑/↓` token breakdown. */
  tokens?: MessageMetadata;
  /** Trailing trigger-row element: stop-reason badge, DUMMY marker. */
  badge?: ReactNode;
  tone?: 'default' | 'dummy';
  /** Bubble-specific action buttons, rendered on the expanded row. */
  actions: ReactNode;
  /**
   * Everyday actions (Copy, Edit) on the trigger row itself: revealed on hover
   * or focus with a mouse, always visible on touch screens.
   */
  quickActions?: ReactNode;
}

const MODEL_NAME_MAX = 16;

/** Shared class for the info bar's action buttons: a larger hit target than bare glyphs. */
export const INFO_BAR_BUTTON = 'px-1.5 py-1 transition-colors';

function Divider() {
  return <span className="text-gray-400">|</span>;
}

/**
 * Two-row message footer. The always-visible trigger row carries the everyday
 * facts (when, which model, how full, how much) plus the quick actions;
 * clicking it reveals the remaining action buttons and the exact token counts.
 * Collapsed by default, state is local to the bubble. Quick actions reveal on
 * hovering the bubble: `MessageBubble` is the `group/message`.
 */
export default function MessageInfoBar({
  timestamp,
  align = 'start',
  model,
  contextText,
  cost,
  tokens,
  badge,
  tone = 'default',
  actions,
  quickActions,
}: MessageInfoBarProps) {
  const [expanded, setExpanded] = useState(false);

  const justify = align === 'end' ? 'justify-end' : 'justify-start';
  const textTone = tone === 'dummy' ? 'text-green-700' : 'text-gray-500';

  const servedModel = model?.served;
  const modelMismatch = Boolean(servedModel && model?.requested && servedModel !== model.requested);
  const modelTitle = modelMismatch
    ? `${model?.requested} → ${servedModel}`
    : servedModel
      ? servedModel
      : model?.requested
        ? `${model.requested} requested, provider reported no model`
        : undefined;

  const usageText = [contextText, cost !== undefined ? `$${cost.toFixed(3)}` : '']
    .filter(Boolean)
    .join(' ');

  const tokenText = tokens
    ? [
        formatTokenGroup('↑', tokens.inputTokens, [
          { prefix: 'C↑', value: tokens.cacheCreationTokens },
          { prefix: 'C↓', value: tokens.cacheReadTokens },
        ]),
        formatTokenGroup('↓', tokens.outputTokens, [
          { prefix: 'R:', value: tokens.reasoningTokens },
        ]),
        tokens.webSearchCount ? `🔍${tokens.webSearchCount}` : '',
      ]
        .filter(Boolean)
        .join(' ')
    : '';

  return (
    <div className={`mt-1 flex w-full flex-col gap-1 text-xs ${textTone}`}>
      <div className={`flex w-full items-center gap-2 ${justify}`}>
        <button
          type="button"
          onClick={() => setExpanded(open => !open)}
          aria-expanded={expanded}
          aria-label="Message details"
          className="flex min-w-0 items-center gap-2 transition-colors hover:text-gray-700"
        >
          <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          <span>{formatTimestamp(timestamp)}</span>
          {model && (
            <>
              <Divider />
              <span
                title={modelTitle}
                className={modelMismatch ? 'text-red-600' : undefined}
                data-testid="info-bar-model"
              >
                {servedModel ? truncateModelName(servedModel, MODEL_NAME_MAX) : '-'}
              </span>
            </>
          )}
          {usageText && (
            <>
              <Divider />
              <span>{usageText}</span>
            </>
          )}
          {badge && (
            <>
              <Divider />
              {badge}
            </>
          )}
        </button>
        {quickActions && (
          <div className="flex items-center transition-opacity group-hover/message:opacity-100 focus-within:opacity-100 [@media(hover:hover)]:opacity-0">
            {quickActions}
          </div>
        )}
      </div>

      {expanded && (
        <div className={`flex w-full items-center gap-3 ${justify}`}>
          {actions}
          {tokenText && (
            <>
              <Divider />
              <span>{tokenText}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
