/**
 * Data Manager Page
 * Shows encryption key (CEK), export/import buttons, and danger zone
 */

import { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../hooks/useApp';
import { useIsMobile } from '../hooks/useIsMobile';
import { showAlert, showDestructiveConfirm } from '../lib/alerts';
import { copyText } from '../lib/clipboard';
import {
  getStorageConfig,
  clearStorageConfig,
  clearCachedCEK,
  type StorageConfig,
} from '../lib/localStorageBoot';
import { gremlinClient, activeLoopsStore } from '../client';
import { clearAllDrafts } from '../hooks/useDraftPersistence';
import { ImportDataModal } from './ImportDataModal';
import AdminRecordEditorModal from './AdminRecordEditorModal';
import { formatStorageDisplay } from '../lib/formatBytes';

interface DataManagerPageProps {
  onMenuPress?: () => void;
}

export default function DataManagerPage({ onMenuPress }: DataManagerPageProps) {
  const isMobile = useIsMobile();

  const {
    handleExport,
    handleImport,
    handleMigrate,
    purgeAllData,
    cek,
    isCEKBase32,
    convertCEKToBase32,
    handleCompressMessages,
    clearAllModelsCache,
    storageQuota,
    refreshStorageQuota,
    refreshProjects,
  } = useApp();

  // Subscribe to the running-loops snapshot so destructive ops disable
  // themselves while a chat loop is in flight. The backend's
  // assertNoLoopsRunning guard would reject the call anyway with
  // LOOPS_RUNNING, but disabling the buttons is a friendlier UX than
  // letting the user click and bounce off an error toast.
  const activeLoops = useSyncExternalStore(
    activeLoopsStore.subscribe,
    activeLoopsStore.getSnapshot,
    activeLoopsStore.getSnapshot
  );
  const hasRunningLoops = activeLoops.length > 0;

  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [isPurging, setIsPurging] = useState(false);
  const [isCompressing, setIsCompressing] = useState(false);
  const [showDangerZone, setShowDangerZone] = useState(false);
  const [showRecordEditor, setShowRecordEditor] = useState(false);
  const [localCEK, setLocalCEK] = useState(cek);
  const [storageConfig] = useState<StorageConfig | null>(() => getStorageConfig());
  const [showImportData, setShowImportData] = useState(false);
  const [isClearingModels, setIsClearingModels] = useState(false);
  const [isImportingProject, setIsImportingProject] = useState(false);
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  const [compressionResult, setCompressionResult] = useState<{
    total: number;
    compressed: number;
    skipped: number;
    errors: number;
  } | null>(null);

  useEffect(() => {
    refreshStorageQuota();
  }, [refreshStorageQuota]);

  // Keep localCEK in sync with prop unless we've converted it
  const displayCEK = localCEK ?? cek;

  const handleConvertToBase32 = async () => {
    const newCEK = await convertCEKToBase32();
    if (newCEK) {
      setLocalCEK(newCEK);
      await showAlert('Success', 'Encryption key converted to base32 format!');
    }
  };

  const handleExportClick = async () => {
    try {
      setIsExporting(true);
      setExportProgress(0);
      await handleExport(count => setExportProgress(count));
    } finally {
      setIsExporting(false);
    }
  };

  const handleCompressMessagesClick = async () => {
    try {
      setIsCompressing(true);
      setCompressionResult(null);
      const result = await handleCompressMessages();
      setCompressionResult(result);
    } finally {
      setIsCompressing(false);
    }
  };

  const handleClearModelsCache = async () => {
    try {
      setIsClearingModels(true);
      await clearAllModelsCache();
      await showAlert('Done', 'Model cache cleared. Models will be re-fetched on next use.');
    } finally {
      setIsClearingModels(false);
    }
  };

  const handlePurge = async () => {
    const confirmed = await showDestructiveConfirm(
      '⚠️ Delete All Data',
      'Are you absolutely sure? This will DELETE ALL DATA including projects, chats, messages, and API keys. This action CANNOT be undone!',
      'Delete All'
    );

    if (!confirmed) return;

    // Double confirmation
    const doubleConfirmed = await showDestructiveConfirm(
      'Final Confirmation',
      'Last chance! Are you really sure you want to delete everything?',
      'Yes, Delete Everything'
    );

    if (!doubleConfirmed) return;

    try {
      setIsPurging(true);
      await purgeAllData();
    } finally {
      setIsPurging(false);
    }
  };

  const cekInputRef = useRef<HTMLInputElement>(null);
  // Losing the key loses the data, so a failed copy must never read as a success
  const copyCEK = async () => {
    if (!displayCEK) return;
    if (await copyText(displayCEK)) {
      await showAlert('Copied', 'Encryption key copied to clipboard!');
      return;
    }
    cekInputRef.current?.select();
    await showAlert(
      'Copy failed',
      'The browser blocked clipboard access. The key is selected in the field; copy it by hand.'
    );
  };

  const handleDetachRemoteStorage = async () => {
    const isServer = storageConfig?.type === 'server';
    const confirmed = await showDestructiveConfirm(
      isServer ? 'Disconnect Backend' : 'Detach Remote Storage',
      'Make sure you have backed up your encryption key! You can reconnect later using "Use Existing Data" with your encryption key.\n\nThis will remove your encryption key and storage configuration from this device. Your data will remain on the server.',
      isServer ? 'Disconnect' : 'Detach'
    );
    if (confirmed) {
      clearAllDrafts();
      // Server mode: only clear localStorage. The server keeps running —
      // the client is just walking away.
      // Worker/remote mode: also tear down the in-memory CEK on the worker.
      if (!isServer) {
        await gremlinClient.clearCek();
      }
      clearCachedCEK();
      clearStorageConfig();
      window.location.reload();
    }
  };

  const handleProjectImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset input so the same file can be re-selected
    e.target.value = '';

    try {
      setIsImportingProject(true);
      const bundleJson = await file.text();
      const { projectName } = await gremlinClient.importProjectBundle(bundleJson);
      await refreshProjects();
      await showAlert('Imported', `Project "${projectName}" created.`);
    } catch (error) {
      await showAlert('Import Failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setIsImportingProject(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-gray-50">
      {/* Header with safe area */}
      <div className="border-b border-gray-200 bg-white">
        <div className="safe-area-inset-top" />
        <div className="flex h-14 items-center px-4">
          {isMobile && onMenuPress ? (
            <button
              onClick={onMenuPress}
              aria-label="Open menu"
              className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-gray-100"
            >
              <span className="text-2xl text-gray-700">☰</span>
            </button>
          ) : (
            // Balances the Home link so the title stays centered
            <div className="-ml-2 w-11 shrink-0" />
          )}
          <h1 className="min-w-0 flex-1 truncate text-center text-lg font-semibold text-gray-900">
            Manage Data
          </h1>
          <Link
            to="/"
            aria-label="Home"
            title="Home"
            className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-gray-100"
          >
            <span className="text-xl">🏠</span>
          </Link>
        </div>
      </div>

      {/* Content */}
      <div className="ios-scroll flex-1 overflow-y-auto overscroll-y-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-2xl space-y-6">
          {/* Encryption Key Section */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold text-gray-900">Encryption Key</h3>
            <p className="mb-3 text-xs text-gray-600">
              Your data is encrypted with this key. Save it securely for backup purposes.
            </p>
            <div className="flex gap-2">
              <input
                ref={cekInputRef}
                type="text"
                value={displayCEK || 'Loading...'}
                readOnly
                aria-label="Encryption key"
                className="flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-base"
              />
              <button
                onClick={copyCEK}
                disabled={!displayCEK}
                className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                Copy
              </button>
            </div>
            {/* Convert to base32 button - only show if CEK is base64 */}
            {isCEKBase32 === false && (
              <div className="mt-3">
                <button
                  onClick={handleConvertToBase32}
                  className="text-xs text-blue-600 hover:text-blue-700 hover:underline"
                >
                  🔄 Convert to base32 format (shorter, easier to type)
                </button>
              </div>
            )}
            {/* Storage mode indicator */}
            <div className="mt-3 flex items-center gap-2 text-xs text-gray-600">
              <span>
                {storageConfig?.type === 'server'
                  ? '🖥️'
                  : storageConfig?.type === 'remote'
                    ? '☁️'
                    : '📦'}
              </span>
              <span>
                {storageConfig?.type === 'server'
                  ? `Remote Backend (${storageConfig.wsUrl})`
                  : storageConfig?.type === 'remote'
                    ? `Remote Storage (${storageConfig.baseUrl || 'same origin'})`
                    : 'IndexedDB (Local)'}
              </span>
            </div>

            {/* Storage quota display */}
            {storageQuota && (
              <div className="mt-2 flex items-center gap-2 text-xs">
                <span>📊</span>
                <span
                  className={
                    formatStorageDisplay(storageQuota.usage, storageQuota.quota).colorClass
                  }
                >
                  Storage Used: {formatStorageDisplay(storageQuota.usage, storageQuota.quota).text}
                </span>
              </div>
            )}
          </section>

          {/* Export Section */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold text-gray-900">Export Data</h3>
            <p className="mb-3 text-xs text-gray-600">
              Download all your data (projects, chats, messages) as an encrypted CSV file.
            </p>
            <button
              onClick={handleExportClick}
              disabled={isExporting}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-green-500 px-4 py-2 text-sm font-medium text-white hover:bg-green-600 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {isExporting ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Exporting... {exportProgress > 0 && `${exportProgress} entries`}
                </>
              ) : (
                '📥 Export All Data'
              )}
            </button>
          </section>

          {/* Import Section */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold text-gray-900">Import Data</h3>
            <p className="mb-3 text-xs text-gray-600">
              Import data from a CSV file exported from another device. Requires the encryption key
              from that device.
            </p>
            <button
              onClick={() => setShowImportData(true)}
              disabled={hasRunningLoops}
              title={hasRunningLoops ? 'Stop all running loops first' : undefined}
              className="w-full rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              📤 Import Data
            </button>
            {hasRunningLoops && (
              <p className="mt-2 text-xs text-amber-700">
                Stop all running loops before importing — the backend refuses with LOOPS_RUNNING.
              </p>
            )}
          </section>

          {/* Import Project Section */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold text-gray-900">Import Project</h3>
            <p className="mb-3 text-xs text-gray-600">
              Import a single project from a .gremlin.json file. No encryption key needed.
            </p>
            <button
              onClick={() => projectFileInputRef.current?.click()}
              disabled={isImportingProject}
              className="w-full rounded-lg bg-teal-500 px-4 py-2 text-sm font-medium text-white hover:bg-teal-600 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {isImportingProject ? (
                <>
                  <div className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  <span className="ml-2">Importing...</span>
                </>
              ) : (
                '📦 Import Project'
              )}
            </button>
            <input
              ref={projectFileInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleProjectImport}
            />
          </section>

          {/* Compression Section */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold text-gray-900">Storage Optimization</h3>
            <p className="mb-3 text-xs text-gray-600">
              Compress all messages using gzip to reduce storage space. New messages are
              automatically compressed. This operation only compresses old uncompressed messages.
            </p>
            <button
              onClick={handleCompressMessagesClick}
              disabled={isCompressing}
              className="w-full rounded-lg bg-purple-500 px-4 py-2 text-sm font-medium text-white hover:bg-purple-600 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {isCompressing ? (
                <>
                  <div className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  <span className="ml-2">Compressing...</span>
                </>
              ) : (
                '🗜️ Compress All Messages'
              )}
            </button>
            {compressionResult && (
              <div className="mt-2 rounded bg-green-50 p-2 text-xs text-green-800">
                ✅ Compressed {compressionResult.compressed} messages, skipped{' '}
                {compressionResult.skipped} (already compressed)
                {compressionResult.errors > 0 && `, ${compressionResult.errors} errors`}
              </div>
            )}
          </section>

          {/* Record Editor Section */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold text-gray-900">Record Editor</h3>
            <p className="mb-3 text-xs text-gray-600">
              Decrypt, hand-edit, and rewrite any raw storage row by table + id. A repair tool for
              state desync — the previous blob is backed up, but you can still write nonsense the
              app chokes on. Know what you&apos;re editing.
            </p>
            <button
              onClick={() => setShowRecordEditor(true)}
              className="w-full rounded-lg bg-slate-600 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              🔧 Open Record Editor
            </button>
          </section>

          {/* Clear Model Cache Section */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold text-gray-900">Model Cache</h3>
            <p className="mb-3 text-xs text-gray-600">
              Clear cached model lists for all API providers. Models will be re-fetched from each
              provider on next use.
            </p>
            <button
              onClick={handleClearModelsCache}
              disabled={isClearingModels}
              className="w-full rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {isClearingModels ? (
                <>
                  <div className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  <span className="ml-2">Clearing...</span>
                </>
              ) : (
                'Clear Model Cache'
              )}
            </button>
          </section>

          {/* Detach / Disconnect — shown for remote storage and server mode */}
          {(storageConfig?.type === 'remote' || storageConfig?.type === 'server') && (
            <section className="rounded-lg border border-gray-200 bg-white p-4">
              <h3 className="mb-2 text-sm font-semibold text-gray-900">
                {storageConfig.type === 'server' ? 'Disconnect Backend' : 'Detach Remote Storage'}
              </h3>
              <p className="mb-3 text-xs text-gray-600">
                {storageConfig.type === 'server'
                  ? 'Disconnect from the remote backend on this device. Your data remains on the server. You can reconnect later using your encryption key.'
                  : 'Disconnect from remote storage on this device. Your data remains on the server. You can reconnect later using your encryption key.'}
              </p>
              <button
                onClick={handleDetachRemoteStorage}
                disabled={hasRunningLoops && storageConfig.type !== 'server'}
                title={
                  hasRunningLoops && storageConfig.type !== 'server'
                    ? 'Stop all running loops first'
                    : undefined
                }
                className="w-full rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                {storageConfig.type === 'server'
                  ? '🔗 Disconnect Backend'
                  : '🔗 Detach Remote Storage'}
              </button>
              {hasRunningLoops && storageConfig.type !== 'server' && (
                <p className="mt-2 text-xs text-amber-700">
                  Stop all running loops before disconnecting — the backend refuses with
                  LOOPS_RUNNING.
                </p>
              )}
            </section>
          )}

          {/* Danger Zone */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <button
              onClick={() => setShowDangerZone(!showDangerZone)}
              className="flex items-center gap-2 text-sm font-semibold text-red-600 hover:text-red-700"
            >
              {showDangerZone ? '▼' : '▶'} Danger Zone
            </button>

            {showDangerZone && (
              <div className="mt-4 space-y-4 rounded-lg border border-red-200 bg-red-50 p-4">
                {/* Delete All Data */}
                <div>
                  <h4 className="mb-1 text-sm font-semibold text-red-900">Delete All Data</h4>
                  {storageConfig?.type === 'server' ? (
                    <p className="text-xs text-red-700">
                      Data deletion is not available in server mode. To reset: disconnect from this
                      device first, then stop the server, delete the database file, and restart.
                    </p>
                  ) : (
                    <>
                      <p className="mb-3 text-xs text-red-700">
                        Permanently delete all projects, chats, messages, API keys, and encryption
                        key. The app will reload and show the setup wizard. This action cannot be
                        undone!
                      </p>
                      <button
                        onClick={handlePurge}
                        disabled={isPurging || hasRunningLoops}
                        title={hasRunningLoops ? 'Stop all running loops first' : undefined}
                        className="flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                      >
                        {isPurging ? (
                          <>
                            <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                            Deleting...
                          </>
                        ) : (
                          '🗑️ Delete All Data'
                        )}
                      </button>
                      {hasRunningLoops && (
                        <p className="mt-2 text-xs text-amber-700">
                          Stop all running loops before purging — the backend refuses with
                          LOOPS_RUNNING.
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Import Data Modal */}
      <ImportDataModal
        isOpen={showImportData}
        onClose={() => setShowImportData(false)}
        onImport={handleImport}
        onMigrate={handleMigrate}
      />
      <AdminRecordEditorModal
        isOpen={showRecordEditor}
        onClose={() => setShowRecordEditor(false)}
        hasRunningLoops={hasRunningLoops}
      />
    </div>
  );
}
