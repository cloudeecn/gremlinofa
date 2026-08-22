import { useCallback, useState } from 'react';
import { gremlinClient } from '../../../client';
import Spinner from '../../ui/Spinner';
import type { ChatAgentConfig } from '../../../../shared/protocol/types';
import type { PromptSegment } from '../../../../shared/protocol/methods';

interface ResolvedPromptPreviewProps {
  chatId: string;
  /** The unsaved draft to preview; omit to preview the chat as persisted. */
  overrides?: ChatAgentConfig;
}

const SOURCE_LABELS: Record<PromptSegment['source'], string> = {
  'pre-persona': 'Pre-persona',
  persona: 'Persona',
  inline: 'Inline',
  file: 'File',
  project: 'Project',
  tool: 'Tool',
};

/**
 * Shows exactly what the model will receive.
 *
 * Resolved by the backend rather than reassembled here: the join order, the
 * `''`-disables rule, the error semantics and the appended tool prompts are
 * all backend behaviour that keeps evolving, and a second implementation in
 * React would drift and then lie about what the model sees.
 *
 * Refreshed on demand, not per keystroke — each refresh reads VFS files.
 */
export default function ResolvedPromptPreview({ chatId, overrides }: ResolvedPromptPreviewProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<{ text: string; segments: PromptSegment[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setResult(await gremlinClient.previewChatSystemPrompt(chatId, overrides));
    } catch (err) {
      console.debug('[ResolvedPromptPreview] preview failed:', err);
      setError(err instanceof Error ? err.message : 'Could not resolve the prompt.');
    } finally {
      setIsLoading(false);
    }
  }, [chatId, overrides]);

  const toggle = useCallback(() => {
    setIsOpen(prev => {
      if (!prev && !result) void refresh();
      return !prev;
    });
  }, [refresh, result]);

  return (
    <div className="border-t border-gray-100 pt-3">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        className="flex h-11 items-center gap-2 text-sm font-medium text-gray-700 hover:text-blue-600"
      >
        <span>{isOpen ? '▾' : '▸'}</span>
        <span>Preview resolved prompt</span>
      </button>

      {isOpen && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={refresh}
              disabled={isLoading}
              className="h-11 rounded-lg border border-gray-300 px-3 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Refresh
            </button>
            {isLoading && <Spinner size={14} />}
          </div>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          {result && (
            <>
              <ul className="space-y-0.5 text-xs">
                {result.segments.length === 0 && (
                  <li className="text-gray-400">
                    No prompt segments — the model gets no system prompt.
                  </li>
                )}
                {result.segments.map((seg, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="w-20 shrink-0 text-gray-500">{SOURCE_LABELS[seg.source]}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-gray-700">
                      {seg.path ?? ''}
                    </span>
                    {seg.error ? (
                      <span className="shrink-0 text-red-600">{seg.error}</span>
                    ) : (
                      <span className="shrink-0 text-gray-400">{seg.chars} chars</span>
                    )}
                  </li>
                ))}
              </ul>
              <pre className="max-h-[40dvh] overflow-y-auto overscroll-contain rounded-lg bg-gray-50 p-3 font-mono text-xs break-words whitespace-pre-wrap text-gray-800">
                {result.text || '(empty)'}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
