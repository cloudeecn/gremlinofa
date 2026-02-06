import { useState } from 'react';
import type {
  ToolResultRenderBlock,
  ToolInfoRenderBlock,
  RenderingBlockGroup,
} from '../../types/content';
import { storage } from '../../services/storage';
import { usePreferences } from '../../hooks/usePreferences';
import BackstageView from './BackstageView';
import TextGroupView from './TextGroupView';

export interface ToolResultViewProps {
  block: ToolResultRenderBlock;
}

/**
 * Unified renderer for tool results — handles both simple results (no renderingGroups)
 * and complex results with nested content (e.g., minion sub-agent work).
 *
 * Simple results: collapsible pre block with renderedContent/content.
 * Complex results: collapsible view with tool_info, activity groups, and final result box.
 *
 * Auto-expands when status is 'running', collapses when 'complete'.
 */
export default function ToolResultView({ block }: ToolResultViewProps) {
  const hasGroups = block.renderingGroups && block.renderingGroups.length > 0;

  if (hasGroups) {
    return <ComplexToolResult block={block} groups={block.renderingGroups!} />;
  }

  return <SimpleToolResult block={block} />;
}

// --- Simple tool result (no renderingGroups) ---

function SimpleToolResult({ block }: { block: ToolResultRenderBlock }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const defaultIcon = block.is_error ? '❌' : '✅';
  const icon = block.icon ?? defaultIcon;
  const renderedContent = block.renderedContent ?? block.content;

  return (
    <div className="backstage-segment mb-3 last:mb-0">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`mb-1 flex items-center gap-1 text-xs font-medium hover:text-purple-900 ${
          block.is_error ? 'text-red-600' : 'text-purple-700'
        }`}
      >
        <span>{icon}</span>
        <span>{block.name ?? 'Result'}</span>
        <span className="text-purple-500">{isExpanded ? '▼' : '▶'}</span>
      </button>

      {isExpanded && (
        <pre className="ml-4 overflow-x-auto rounded bg-gray-100 p-2 text-xs whitespace-pre-wrap text-gray-700">
          {renderedContent}
        </pre>
      )}
    </div>
  );
}

// --- Complex tool result (with renderingGroups) ---

/** Extract the last meaningful preview line from activity groups */
function getLastActivityPreview(groups: RenderingBlockGroup[]): string {
  // Walk backward through groups to find the last meaningful content
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    for (let j = group.blocks.length - 1; j >= 0; j--) {
      const block = group.blocks[j];
      switch (block.type) {
        case 'text': {
          const text = block.text?.trim();
          if (text) {
            const lines = text.split('\n');
            return lines[lines.length - 1];
          }
          break;
        }
        case 'tool_use':
          return `Called: ${block.name}`;
        case 'tool_result':
          return `${block.name ?? 'Result'}: ${(block.renderedContent ?? block.content ?? '').slice(0, 80)}`;
        case 'thinking': {
          const thinking = block.thinking?.trim();
          if (thinking) {
            const lines = thinking.split('\n');
            return lines[lines.length - 1];
          }
          break;
        }
        case 'web_search':
          return `Searched: "${block.query}"`;
        case 'web_fetch':
          return `Fetched: ${block.title || block.url}`;
        case 'tool_info':
        case 'error':
          break;
      }
    }
  }
  return '';
}

function ComplexToolResult({
  block,
  groups,
}: {
  block: ToolResultRenderBlock;
  groups: RenderingBlockGroup[];
}) {
  const isRunning = block.status === 'running';
  const [isExpanded, setIsExpanded] = useState(false);
  const { iconOnRight } = usePreferences();

  // Extract tool_info block from first group (if present)
  const toolInfo = extractToolInfo(groups);

  // Activity groups = everything except the tool_info group
  const activityGroups = groups.filter(
    g => !g.blocks.some((b): b is ToolInfoRenderBlock => b.type === 'tool_info')
  );

  const isError = block.is_error;
  const hasResult = !isRunning && block.content;

  const defaultIcon = block.icon ?? '🤖';
  const previewText = !isExpanded ? getLastActivityPreview(activityGroups) : '';

  return (
    <div className="overflow-hidden rounded-r-lg border-l-4 border-purple-400 bg-purple-50">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium text-purple-800 transition-colors hover:bg-purple-100"
      >
        <span className="flex shrink-0 items-center gap-1">
          <span>
            {!iconOnRight && defaultIcon} {block.name ?? 'Tool'}
          </span>
          <span className="text-purple-600">{isExpanded ? '▼' : '▶'}</span>
        </span>
        {!isExpanded && (
          <>
            {previewText ? (
              <>
                <span className="flex min-w-0 overflow-hidden">
                  <span className="flex max-w-full justify-end overflow-hidden text-xs font-normal whitespace-nowrap text-purple-600">
                    {previewText}
                  </span>
                </span>
                <span className="min-w-0 flex-1 overflow-hidden"></span>
              </>
            ) : toolInfo?.chatId ? (
              <span className="min-w-0 flex-1 truncate text-right text-xs text-purple-400">
                {toolInfo.chatId}
              </span>
            ) : (
              <span className="min-w-0 flex-1 overflow-hidden"></span>
            )}
            {iconOnRight && <span className="mr-2 shrink-0">{defaultIcon}</span>}
          </>
        )}
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="space-y-3 border-t border-purple-200 bg-white px-4 py-3">
          {/* Tool info input in blue box */}
          {toolInfo?.input && (
            <div className="rounded border border-blue-300 bg-blue-50 px-3 py-2">
              <pre className="overflow-x-auto text-sm whitespace-pre-wrap text-blue-800">
                {toolInfo.input}
              </pre>
            </div>
          )}

          {/* Activity groups */}
          {activityGroups.length > 0 && (
            <div className="space-y-2">
              {activityGroups.map((group, idx) => {
                if (group.category === 'backstage') {
                  return (
                    <BackstageView
                      key={`backstage-${idx}`}
                      blocks={group.blocks}
                      isToolGenerated={group.isToolGenerated}
                    />
                  );
                }
                if (group.category === 'text') {
                  return (
                    <div key={`text-${idx}`}>
                      <TextGroupView blocks={group.blocks} />
                    </div>
                  );
                }
                return null;
              })}
            </div>
          )}

          {/* Final result box */}
          {hasResult && (
            <div
              className={`rounded border px-3 py-2 ${
                isError ? 'border-red-300 bg-red-50' : 'border-green-300 bg-green-50'
              }`}
            >
              <pre
                className={`overflow-x-auto text-sm whitespace-pre-wrap ${
                  isError ? 'text-red-800' : 'text-green-800'
                }`}
              >
                {block.renderedContent ?? block.content}
              </pre>
            </div>
          )}

          {/* Copy buttons */}
          <div className="flex justify-end gap-3 border-t border-purple-100 pt-2">
            {toolInfo?.chatId && (
              <button
                onClick={async e => {
                  e.stopPropagation();
                  try {
                    const messages = await storage.getMinionMessages(toolInfo.chatId!);
                    await navigator.clipboard.writeText(JSON.stringify(messages, null, 2));
                  } catch {
                    // Silently fail if clipboard access denied
                  }
                }}
                className="text-xs text-gray-400 hover:text-gray-600"
                title="Copy all sub-chat messages as JSON"
              >
                📋 Copy All
              </button>
            )}
            <button
              onClick={async e => {
                e.stopPropagation();
                try {
                  await navigator.clipboard.writeText(JSON.stringify(block, null, 2));
                } catch {
                  // Silently fail if clipboard access denied
                }
              }}
              className="text-xs text-gray-400 hover:text-gray-600"
              title="Copy tool result data as JSON"
            >
              📋 Copy JSON
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Extract the first ToolInfoRenderBlock from renderingGroups, if any. */
function extractToolInfo(groups: RenderingBlockGroup[]): ToolInfoRenderBlock | undefined {
  for (const group of groups) {
    for (const block of group.blocks) {
      if (block.type === 'tool_info') return block;
    }
  }
  return undefined;
}
