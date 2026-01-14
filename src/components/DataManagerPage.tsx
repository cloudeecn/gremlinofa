/**
 * Data Manager Page
 * Shows encryption key (CEK), export/import buttons, and danger zone
 */

import { useState, useEffect } from 'react';
import { useApp } from '../hooks/useApp';
import { useIsMobile } from '../hooks/useIsMobile';
import { showAlert, showDestructiveConfirm } from '../utils/alerts';
import {
  getStorageConfig,
  clearStorageConfig,
  type StorageConfig,
} from '../services/storage/storageConfig';
import { encryptionService } from '../services/encryption/encryptionService';
import { clearAllDrafts } from '../hooks/useDraftPersistence';
import { ImportDataModal } from './ImportDataModal';
import { formatStorageDisplay } from '../utils/formatBytes';

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
    storageQuota,
    refreshStorageQuota,
  } = useApp();

  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [isPurging, setIsPurging] = useState(false);
  const [isCompressing, setIsCompressing] = useState(false);
  const [showDangerZone, setShowDangerZone] = useState(false);
  const [localCEK, setLocalCEK] = useState(cek);
  const [storageConfig, setStorageConfigState] = useState<StorageConfig | null>(null);
  const [showImportData, setShowImportData] = useState(false);
  const [compressionResult, setCompressionResult] = useState<{
    total: number;
    compressed: number;
    skipped: number;
    errors: number;
  } | null>(null);

  // Load storage config on mount
  useEffect(() => {
    setStorageConfigState(getStorageConfig());
  }, []);

  useEffect(() => {
    refreshStorageQuota();
  }, [refreshStorageQuota]);

  // Keep localCEK in sync with prop unless we've converted it
  const displayCEK = localCEK ?? cek;

  const handleConvertToBase32 = async () => {
    const newCEK = convertCEKToBase32();
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

  const copyCEK = async () => {
    if (displayCEK) {
      navigator.clipboard.writeText(displayCEK);
      await showAlert('Copied', 'Encryption key copied to clipboard!');
    }
  };

  const handleDetachRemoteStorage = async () => {
    const confirmed = await showDestructiveConfirm(
      'Detach Remote Storage',
      'Make sure you have backed up your encryption key! You can reconnect later using "Use Existing Data" with your encryption key.\n\nThis will remove your encryption key and storage configuration from this device. Your data will remain on the server.',
      'Detach'
    );
    if (confirmed) {
      clearAllDrafts();
      await encryptionService.clearCEK();
      clearStorageConfig();
      window.location.reload();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-gray-50">
      {/* Header with safe area */}
      <div className="border-b border-gray-200 bg-white">
        <div className="safe-area-inset-top" />
        <div className="flex h-14 items-center px-4">
          {isMobile && onMenuPress && (
            <button
              onClick={onMenuPress}
              className="-ml-2 flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-gray-100"
            >
              <span className="text-2xl text-gray-700">☰</span>
            </button>
          )}
          <h1 className="flex-1 text-center text-lg font-semibold text-gray-900">Manage Data</h1>
          {/* Spacer for centering on mobile */}
          {isMobile && onMenuPress && <div className="w-11" />}
        </div>
      </div>

      {/* Content */}
      <div className="ios-scroll scroll-safe-bottom flex-1 overflow-y-auto overscroll-y-contain p-4">
        <div className="mx-auto max-w-2xl space-y-6">
          {/* Encryption Key Section */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold text-gray-900">Encryption Key</h3>
            <p className="mb-3 text-xs text-gray-600">
              Your data is encrypted with this key. Save it securely for backup purposes.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={displayCEK || 'Loading...'}
                readOnly
                className="flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-sm"
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
              <span>{storageConfig?.type === 'remote' ? '☁️' : '📦'}</span>
              <span>
                {storageConfig?.type === 'remote'
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
              className="w-full rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600"
            >
              📤 Import Data
            </button>
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

          {/* Detach Remote Storage - only show when using remote storage */}
          {storageConfig?.type === 'remote' && (
            <section className="rounded-lg border border-gray-200 bg-white p-4">
              <h3 className="mb-2 text-sm font-semibold text-gray-900">Detach Remote Storage</h3>
              <p className="mb-3 text-xs text-gray-600">
                Disconnect from remote storage on this device. Your data remains on the server. You
                can reconnect later using your encryption key.
              </p>
              <button
                onClick={handleDetachRemoteStorage}
                className="w-full rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600"
              >
                🔗 Detach Remote Storage
              </button>
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
                  <p className="mb-3 text-xs text-red-700">
                    Permanently delete all projects, chats, messages, API keys, and encryption key.
                    The app will reload and show the setup wizard. This action cannot be undone!
                  </p>
                  <button
                    onClick={handlePurge}
                    disabled={isPurging}
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
    </div>
  );
}
