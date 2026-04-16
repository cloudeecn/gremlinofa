/**
 * OOBE Complete Screen
 * Shown after OOBE finishes, displays CEK and import stats
 * User must click button to reload and launch the app
 */

import { useState } from 'react';

interface OOBECompleteProps {
  mode: 'fresh' | 'import' | 'existing';
  cek: string;
  storageType: 'indexeddb' | 'remote';
  importStats?: {
    imported: number;
    skipped: number;
    errors: string[];
  };
}

export function OOBEComplete({ mode, cek, storageType, importStats }: OOBECompleteProps) {
  const [copied, setCopied] = useState(false);

  const handleCopyCEK = async () => {
    try {
      await navigator.clipboard.writeText(cek);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy CEK:', err);
    }
  };

  const handleLaunchApp = () => {
    // Hard reload to sync all states
    window.location.reload();
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-8 shadow-xl">
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="mb-4 text-5xl">✅</div>
          <h1 className="text-2xl font-bold text-gray-900">Setup Complete!</h1>
          <p className="mt-2 text-gray-600">
            {mode === 'fresh'
              ? 'Your workspace is ready to use'
              : 'Your data has been imported successfully'}
          </p>
        </div>

        {/* Import stats (if applicable) */}
        {mode === 'import' && importStats && (
          <div className="mb-6 rounded-lg border border-green-200 bg-green-50 p-4">
            <h3 className="mb-2 font-semibold text-green-800">Import Summary</h3>
            <div className="space-y-1 text-sm text-green-700">
              <p>✓ {importStats.imported} records imported</p>
              {importStats.skipped > 0 && <p>⏭ {importStats.skipped} duplicates skipped</p>}
              {importStats.errors.length > 0 && (
                <p className="text-amber-700">⚠ {importStats.errors.length} errors occurred</p>
              )}
            </div>
          </div>
        )}

        {/* CEK Display */}
        <div className="mb-6">
          <h2 className="mb-3 text-sm font-semibold tracking-wide text-gray-500 uppercase">
            Your Encryption Key
          </h2>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto font-mono text-sm whitespace-nowrap text-gray-800">
                {cek}
              </code>
              <button
                onClick={handleCopyCEK}
                className="shrink-0 rounded-lg bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-300"
              >
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>
        </div>

        {/* Warning */}
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <div className="flex gap-3">
            <span className="text-xl">⚠️</span>
            <div className="text-sm text-amber-800">
              <p className="font-semibold">Save this key somewhere safe!</p>
              <p className="mt-1">
                You'll need it to restore your data on another device. Without this key, your
                encrypted data cannot be recovered.
              </p>
            </div>
          </div>
        </div>

        {/* Storage info */}
        <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{storageType === 'remote' ? '☁️' : '📦'}</span>
            <div>
              <div className="font-medium text-gray-900">
                Storage: {storageType === 'remote' ? 'Remote Storage' : 'IndexedDB (Local)'}
              </div>
              <div className="text-sm text-gray-500">
                {storageType === 'remote'
                  ? 'Data synced via remote storage backend'
                  : 'Data stored locally in your browser'}
              </div>
            </div>
          </div>
        </div>

        {/* Launch button */}
        <button
          onClick={handleLaunchApp}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-lg font-semibold text-white transition-colors hover:bg-blue-700"
        >
          🚀 Launch App
        </button>

        {/* Footer note */}
        <p className="mt-4 text-center text-xs text-gray-400">
          The app will reload to initialize all services
        </p>
      </div>
    </div>
  );
}
