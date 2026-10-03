import { useEffect, useState } from 'react';
import Spinner from '../ui/Spinner';
import VfsBreadcrumb from './VfsBreadcrumb';
import VfsButton from './VfsButton';
import VfsFileEditor from './VfsFileEditor';
import VfsFileRender from './VfsFileRender';
import VfsFileSource from './VfsFileSource';
import VfsHistory from './VfsHistory';
import type { VfsAdapter } from '../../../shared/protocol/types/vfs';
import { base64ToArrayBuffer } from '../../../shared/protocol/binaryEncoding';
import { useAlert } from '../../hooks/useAlert';
import { clearDraft, useDraftPersistence } from '../../hooks/useDraftPersistence';
import { downloadBlob } from '../../lib/download';
import { basename, dirname } from '../../lib/vfsPath';
import { renderViewFor } from '../../lib/vfsRenderView';

export type FileTab = 'render' | 'source' | 'edit' | 'history';

/** Drop old versions keeps this many. */
const KEEP_VERSIONS = 10;

const DRAFT_PLACE = 'vfs-editor';

interface LoadedFile {
  /** Text, or base64 when `isBinary` */
  content: string;
  isBinary: boolean;
  mime: string;
  version: number;
  storedVersionCount: number;
  minStoredVersion: number;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; file: LoadedFile; reloading: boolean };

export interface VfsFilePanelProps {
  adapter: VfsAdapter;
  /** Scopes the unsaved draft: the same path in another project is another file */
  projectId: string;
  path: string;
  /** Defaults to Render for files that have one, else Source */
  initialTab?: FileTab;
  /** Opens an ancestor folder from the breadcrumb */
  onNavigate: (dir: string) => void;
  /** Opens the memory file a rendered link points at; it may not exist */
  onOpenLink: (path: string) => void;
  /** Content or versions changed: the tree's sizes are stale */
  onChanged: () => void;
  onDelete: () => void;
  /** Mobile sheet only */
  onClose?: () => void;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * One file: render, source, edit and history tabs. The parent keys it by
 * path, so a newly selected file starts from a clean panel.
 */
export default function VfsFilePanel({
  adapter,
  projectId,
  path,
  initialTab,
  onNavigate,
  onOpenLink,
  onChanged,
  onDelete,
  onClose,
}: VfsFilePanelProps) {
  const { showAlert, showDestructiveConfirm } = useAlert();
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [reloadCount, setReloadCount] = useState(0);
  // null: the file's default view, which depends on its type
  const [tab, setTab] = useState<FileTab | null>(initialTab ?? null);
  const name = basename(path);

  useEffect(() => {
    let cancelled = false;
    Promise.all([adapter.readFileWithMeta(path), adapter.getFileMeta(path)]).then(
      ([result, meta]) => {
        if (cancelled) return;
        const version = meta?.version ?? 1;
        setLoad({
          status: 'ready',
          reloading: false,
          file: {
            content: result.content,
            isBinary: result.isBinary,
            mime: result.mime,
            version,
            storedVersionCount: meta?.storedVersionCount ?? 1,
            minStoredVersion: meta?.minStoredVersion ?? version,
          },
        });
      },
      error => {
        if (cancelled) return;
        console.debug('[VfsFilePanel] load failed', path, error);
        setLoad({ status: 'error', message: errorMessage(error) });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [adapter, path, reloadCount]);

  const reload = () => {
    // A reload keeps the current content on screen until the new one lands
    setLoad(prev =>
      prev.status === 'ready' ? { ...prev, reloading: true } : { status: 'loading' }
    );
    setReloadCount(count => count + 1);
  };

  const showChanges = () => {
    setTab(null);
    reload();
    onChanged();
  };

  const download = (file: LoadedFile) => {
    const blob = file.isBinary
      ? new Blob([base64ToArrayBuffer(file.content)], { type: file.mime })
      : new Blob([file.content], { type: 'text/plain;charset=utf-8' });
    downloadBlob(blob, name);
  };

  const dropOldVersions = async (file: LoadedFile) => {
    const dropCount = file.storedVersionCount - KEEP_VERSIONS;
    const confirmed = await showDestructiveConfirm(
      'Drop old versions',
      `Delete the ${dropCount} oldest stored versions of “${name}”? The latest ${KEEP_VERSIONS} stay.`,
      'Drop'
    );
    if (!confirmed) return;
    try {
      const fileId = await adapter.getFileId(path);
      if (!fileId) throw new Error('File not found');
      await adapter.dropOldVersions(fileId, KEEP_VERSIONS);
      reload();
    } catch (error) {
      await showAlert('Versions not dropped', errorMessage(error));
    }
  };

  const file = load.status === 'ready' ? load.file : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2">
        <div className="min-w-0 flex-1">
          <VfsBreadcrumb path={path} onNavigate={onNavigate} />
        </div>
        {file && (
          <span
            className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500"
            title={`Minimum stored version: v${file.minStoredVersion}`}
          >
            v{file.version}
            {file.storedVersionCount < file.version && ` (${file.storedVersionCount} stored)`}
          </span>
        )}
        {file?.isBinary && (
          <span className="hidden shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700 sm:inline">
            {file.mime}
          </span>
        )}
        {onClose && <VfsButton icon="✕" label="Close" iconOnly onClick={onClose} />}
      </div>

      {load.status === 'loading' && (
        <div className="flex flex-1 items-center justify-center text-gray-400">
          <Spinner size={24} />
        </div>
      )}

      {load.status === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm">
          <p className="text-red-600">
            Couldn’t open “{name}”: {load.message}
          </p>
          <button type="button" className="text-blue-600 hover:underline" onClick={reload}>
            Retry
          </button>
        </div>
      )}

      {load.status === 'ready' && (
        <FileBody
          // A new version (saved, rolled back, written by the agent) re-seeds the editor
          key={load.file.version}
          adapter={adapter}
          projectId={projectId}
          path={path}
          file={load.file}
          reloading={load.reloading}
          tab={tab}
          onTabChange={setTab}
          onOpenLink={onOpenLink}
          onReload={reload}
          onSaved={showChanges}
          onRolledBack={showChanges}
          onDownload={() => download(load.file)}
          onDropVersions={() => void dropOldVersions(load.file)}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

interface FileBodyProps {
  adapter: VfsAdapter;
  projectId: string;
  path: string;
  file: LoadedFile;
  reloading: boolean;
  tab: FileTab | null;
  onTabChange: (tab: FileTab) => void;
  onOpenLink: (path: string) => void;
  onReload: () => void;
  onSaved: () => void;
  onRolledBack: () => void;
  onDownload: () => void;
  onDropVersions: () => void;
  onDelete: () => void;
}

/**
 * Owns the draft, so typed text survives switching to Preview or History and
 * back. Drafts also persist in localStorage under the same key as before the
 * rewrite, so ones saved by the old editor still restore.
 */
function FileBody({
  adapter,
  projectId,
  path,
  file,
  reloading,
  tab,
  onTabChange,
  onOpenLink,
  onReload,
  onSaved,
  onRolledBack,
  onDownload,
  onDropVersions,
  onDelete,
}: FileBodyProps) {
  const { showConfirm, showDestructiveConfirm } = useAlert();
  const [draft, setDraft] = useState(file.content);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const draftId = `vfs_${projectId}_${encodeURIComponent(path)}`;
  const isDirty = !file.isBinary && draft !== file.content;

  useDraftPersistence({
    place: DRAFT_PLACE,
    contextId: draftId,
    value: draft,
    onChange: setDraft,
    enabled: !file.isBinary,
  });

  // A draft equal to the file is no draft. Left in storage, it would come
  // back as "unsaved changes" once the agent writes a newer version, and
  // saving it would quietly revert that write.
  useEffect(() => {
    if (!file.isBinary && draft === file.content) clearDraft(DRAFT_PLACE, draftId);
  }, [draft, draftId, file.content, file.isBinary]);

  const name = basename(path);
  const renderView = renderViewFor(name, file.isBinary, file.mime);
  const hasHistory = file.storedVersionCount >= 2;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const meta = await adapter.getFileMeta(path);
      if (meta && meta.version !== file.version) {
        const overwrite = await showConfirm(
          'File changed since you opened it',
          `v${meta.version} was saved after the v${file.version} you’re editing, probably by the agent. Overwrite it with your text? Reload instead to see the new version; your draft is kept.`,
          'Overwrite'
        );
        if (!overwrite) {
          setSaving(false);
          return;
        }
      }
      await adapter.writeFile(path, draft);
      clearDraft(DRAFT_PLACE, draftId);
      setSaving(false);
      onSaved();
    } catch (error) {
      setSaveError(`Couldn’t save: ${errorMessage(error)}`);
      setSaving(false);
    }
  };

  const discard = async () => {
    const confirmed = await showDestructiveConfirm(
      'Discard changes',
      `Throw away your unsaved edits to “${name}”?`,
      'Discard'
    );
    if (!confirmed) return;
    clearDraft(DRAFT_PLACE, draftId);
    setDraft(file.content);
    setSaveError(null);
  };

  // A binary file has one view: the image, or a download
  const tabs: Array<{ id: FileTab; label: string; disabled?: boolean; title?: string }> = [];
  if (renderView) tabs.push({ id: 'render', label: 'Render' });
  if (!file.isBinary || !renderView) tabs.push({ id: 'source', label: 'Source' });
  if (!file.isBinary) {
    tabs.push({ id: 'edit', label: 'Edit' });
    tabs.push({
      id: 'history',
      label: 'History',
      disabled: !hasHistory,
      title: hasHistory ? undefined : 'No earlier version stored',
    });
  }
  const activeTab = tabs.find(({ id, disabled }) => id === tab && !disabled)?.id ?? tabs[0].id;

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-gray-200 px-3 py-1.5">
        {tabs.length > 1 && (
          <div role="group" aria-label="View" className="flex gap-1">
            {tabs.map(({ id, label, disabled, title }) => (
              <button
                key={id}
                type="button"
                aria-pressed={activeTab === id}
                disabled={disabled}
                title={title}
                onClick={() => onTabChange(id)}
                className={`relative h-8 rounded-md px-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:px-3 ${
                  activeTab === id ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                {label}
                {id === 'edit' && isDirty && (
                  <span
                    className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-amber-500"
                    title="Unsaved draft"
                  />
                )}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center">
          {reloading && <Spinner size={14} className="mr-1 text-gray-400" />}
          <VfsButton icon="↻" label="Reload" iconOnly onClick={onReload} disabled={reloading} />
          <VfsButton icon="⬇️" label="Download file" iconOnly onClick={onDownload} />
          {file.storedVersionCount > KEEP_VERSIONS && (
            <VfsButton
              icon="🧹"
              label={`Drop old versions (keep ${KEEP_VERSIONS})`}
              iconOnly
              onClick={onDropVersions}
            />
          )}
          <VfsButton icon="🗑️" label="Delete file" tone="danger" iconOnly onClick={onDelete} />
        </div>
      </div>

      {activeTab === 'render' && renderView && (
        <VfsFileRender
          view={renderView}
          name={name}
          dir={dirname(path)}
          content={file.content}
          onOpenLink={onOpenLink}
        />
      )}
      {activeTab === 'source' && (
        <VfsFileSource
          content={file.content}
          isBinary={file.isBinary}
          mime={file.mime}
          onDownload={onDownload}
        />
      )}
      {activeTab === 'edit' && (
        <VfsFileEditor
          value={draft}
          onChange={setDraft}
          isDirty={isDirty}
          saving={saving}
          error={saveError}
          onSave={() => void save()}
          onDiscard={() => void discard()}
        />
      )}
      {activeTab === 'history' && (
        <VfsHistory
          adapter={adapter}
          path={path}
          currentVersion={file.version}
          minStoredVersion={file.minStoredVersion}
          onRolledBack={onRolledBack}
        />
      )}
    </>
  );
}
