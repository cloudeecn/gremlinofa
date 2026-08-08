import { useEffect, useState } from 'react';
import Modal from '../ui/Modal';
import { gremlinClient } from '../../client';

interface ClaudeAgentDebugModalProps {
  onClose: () => void;
  /** Stamped owning session — absent on messages written before the stamp. */
  sessionId?: string;
  messageUuid: string;
}

interface InspectionState {
  entry: string;
  sessionId: string;
  foundVia: 'stated' | 'scan';
}

/**
 * Debug view of the raw Claude Agent SDK session entry (JSONL line) behind a
 * stored assistant message, looked up via the message's persisted
 * `{claudeAgentSessionId, claudeAgentMessageUuid}` pair. Server mode only —
 * worker mode surfaces the stub client's error. Mounted only while open, so
 * each open starts from a fresh fetch.
 */
export default function ClaudeAgentDebugModal({
  onClose,
  sessionId,
  messageUuid,
}: ClaudeAgentDebugModalProps) {
  const [inspection, setInspection] = useState<InspectionState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    gremlinClient
      .claudeAgentInspectMessage(sessionId, messageUuid)
      .then(found => {
        if (!cancelled) setInspection(found);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, messageUuid]);

  const prettyEntry = (() => {
    if (!inspection) return '';
    try {
      return JSON.stringify(JSON.parse(inspection.entry), null, 2);
    } catch {
      return inspection.entry;
    }
  })();

  return (
    <Modal isOpen onClose={onClose} size="xl" position="bottom">
      <div className="flex max-h-[85dvh] flex-col rounded-t-2xl bg-white md:max-h-[700px] md:rounded-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h2 className="text-base font-semibold text-gray-900">SDK Session Entry</h2>
          <button
            onClick={onClose}
            className="text-gray-400 transition-colors hover:text-gray-600"
            title="Close"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="mb-2 space-y-1 text-xs text-gray-500">
            <div className="break-all">
              uuid: <span className="font-mono">{messageUuid}</span>
            </div>
            {inspection && (
              <div className="break-all">
                session: <span className="font-mono">{inspection.sessionId}</span>{' '}
                {inspection.foundVia === 'scan' && (
                  <span
                    className="rounded bg-amber-100 px-1 py-0.5 text-amber-800"
                    title="The stamped session didn't contain this entry — it was located by scanning the session files"
                  >
                    found via scan
                  </span>
                )}
              </div>
            )}
          </div>
          {error ? (
            <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          ) : inspection ? (
            <pre className="overflow-x-auto rounded bg-gray-50 p-3 font-mono text-xs whitespace-pre-wrap text-gray-800">
              {prettyEntry}
            </pre>
          ) : (
            <div className="p-3 text-sm text-gray-500">Loading…</div>
          )}
        </div>
      </div>
    </Modal>
  );
}
