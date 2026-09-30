import { useDeferredValue, useMemo, useState } from 'react';
import Modal from './ui/Modal';
import { gremlinClient } from '../client';
import { showAlert, showDestructiveConfirm } from '../lib/alerts';
import type { AdminRecordView, TableName } from '../../shared/protocol/methods';

/**
 * Kept in sync with `Tables` in `StorageAdapter.ts` — the const itself lives
 * outside the frontend's allowed import surface (`shared/protocol/**`), but a
 * typo here fails to compile against the `TableName` union.
 */
const EDITABLE_TABLES: TableName[] = [
  'chats',
  'minion_chats',
  'projects',
  'messages',
  'api_definitions',
  'models_cache',
  'attachments',
  'app_metadata',
  'vfs_meta',
  'vfs_files',
  'vfs_versions',
];

interface AdminRecordEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Disables saving while chat loops run (backend guard would reject anyway). */
  hasRunningLoops: boolean;
}

/**
 * Raw record editor: decrypts any storage row by table + id, shows the JSON
 * payload for hand-editing, and re-encrypts on save (compression preserved,
 * previous blob backed up to `app_metadata` under `admin_edit_backup:*`).
 * A scalpel for state desync — not a daily driver.
 */
export default function AdminRecordEditorModal({
  isOpen,
  onClose,
  hasRunningLoops,
}: AdminRecordEditorModalProps) {
  const [table, setTable] = useState<TableName>('chats');
  const [recordId, setRecordId] = useState('');
  const [record, setRecord] = useState<AdminRecordView | null>(null);
  const [loadedKey, setLoadedKey] = useState<{ table: TableName; id: string } | null>(null);
  const [json, setJson] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Rows can be multi-MB and DataManagerPage keeps this modal mounted (and
  // re-rendering on every export progress event), so validation parses a
  // deferred snapshot: once per edit, in a background render, never while
  // closed. Record and text are deferred together; deferring only the text
  // would validate a freshly loaded record against the previous text.
  const editorSnapshot = useMemo(() => ({ isOpen, record, json }), [isOpen, record, json]);
  const validatedSnapshot = useDeferredValue(editorSnapshot);
  const validationPending = validatedSnapshot !== editorSnapshot;
  const snapshotParseError = useMemo(() => {
    if (!validatedSnapshot.isOpen || !validatedSnapshot.record) return null;
    try {
      JSON.parse(validatedSnapshot.json);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, [validatedSnapshot]);
  // An error from another record's text says nothing about the one on screen
  const jsonParseError = validatedSnapshot.record === record ? snapshotParseError : null;

  const handleLoad = async () => {
    const id = recordId.trim();
    if (!id) return;
    setLoading(true);
    setError(null);
    setRecord(null);
    try {
      const loaded = await gremlinClient.adminGetRecord(table, id);
      setRecord(loaded);
      setLoadedKey({ table, id });
      try {
        setJson(JSON.stringify(JSON.parse(loaded.json), null, 2));
      } catch {
        setJson(loaded.json);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!record || !loadedKey || jsonParseError || validationPending) return;
    const confirmed = await showDestructiveConfirm(
      'Overwrite Record',
      `This rewrites ${loadedKey.table}/${loadedKey.id} with the edited JSON. The previous blob is backed up to app_metadata (admin_edit_backup:${loadedKey.table}:${loadedKey.id}).`,
      'Overwrite'
    );
    if (!confirmed) return;
    setSaving(true);
    setError(null);
    try {
      // Re-compact — stored payloads are compact JSON, not pretty-printed.
      await gremlinClient.adminSaveRecord(
        loadedKey.table,
        loadedKey.id,
        JSON.stringify(JSON.parse(json))
      );
      showAlert('Saved', 'Record rewritten. Previous blob backed up.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl" position="bottom">
      <div className="flex max-h-[85dvh] flex-col rounded-t-2xl bg-white md:max-h-[700px] md:rounded-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h2 className="text-base font-semibold text-gray-900">Record Editor</h2>
          <button
            onClick={onClose}
            className="text-gray-400 transition-colors hover:text-gray-600"
            title="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
          <div className="flex gap-2">
            <select
              value={table}
              onChange={e => setTable(e.target.value as TableName)}
              className="rounded border border-gray-300 px-2 py-1.5 text-sm"
            >
              {EDITABLE_TABLES.map(name => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <input
              value={recordId}
              onChange={e => setRecordId(e.target.value)}
              placeholder="record id"
              className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1.5 font-mono text-sm"
            />
            <button
              onClick={handleLoad}
              disabled={loading || !recordId.trim()}
              className="rounded bg-blue-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {loading ? 'Loading…' : 'Load'}
            </button>
          </div>

          {record && loadedKey && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                <span className="font-mono break-all">
                  {loadedKey.table}/{loadedKey.id}
                </span>
                {record.timestamp && <span>ts: {record.timestamp}</span>}
                {record.parentId && <span className="break-all">parent: {record.parentId}</span>}
                <span className="rounded bg-gray-100 px-1 py-0.5">
                  {record.encrypted ? 'encrypted' : 'plaintext'}
                </span>
                {record.compressed && (
                  <span className="rounded bg-gray-100 px-1 py-0.5">compressed</span>
                )}
              </div>
              <textarea
                value={json}
                onChange={e => setJson(e.target.value)}
                spellCheck={false}
                className="min-h-[300px] flex-1 rounded border border-gray-300 p-2 font-mono text-xs"
              />
            </>
          )}

          {jsonParseError && (
            <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              Invalid JSON: {jsonParseError}
            </div>
          )}
          {error && (
            <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              {error}
            </div>
          )}
          {hasRunningLoops && (
            <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              ⚠️ Stop all running loops before saving record edits.
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-3">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
          >
            Close
          </button>
          <button
            onClick={handleSave}
            disabled={!record || saving || !!jsonParseError || validationPending || hasRunningLoops}
            className="rounded bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {saving ? 'Saving…' : 'Overwrite Record'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
