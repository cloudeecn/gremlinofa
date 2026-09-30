/**
 * OOBE Complete Screen
 * Shown after OOBE finishes, displays CEK and import stats
 * User must click button to reload and launch the app
 */

import { useRef, useState } from 'react';
import { copyText } from '../lib/clipboard';

interface OOBECompleteProps {
  mode: 'fresh' | 'import' | 'existing';
  cek: string;
  storageType: 'indexeddb' | 'remote' | 'server';
  importStats?: {
    imported: number;
    skipped: number;
    errors: string[];
  };
}

export function OOBEComplete({ mode, cek, storageType, importStats }: OOBECompleteProps) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const cekRef = useRef<HTMLElement>(null);

  // A key the user believes they saved but didn't is lost data: on failure,
  // select it for a manual copy and say so
  const handleCopyCEK = async () => {
    if (await copyText(cek)) {
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus('idle'), 2000);
      return;
    }
    setCopyStatus('failed');
    if (cekRef.current) window.getSelection()?.selectAllChildren(cekRef.current);
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
              <code
                ref={cekRef}
                className="flex-1 overflow-x-auto font-mono text-sm whitespace-nowrap text-gray-800"
              >
                {cek}
              </code>
              <button
                onClick={handleCopyCEK}
                className="shrink-0 rounded-lg bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-300"
              >
                {copyStatus === 'copied' ? '✓ Copied' : 'Copy'}
              </button>
            </div>
            {copyStatus === 'failed' && (
              <p role="alert" className="mt-2 text-sm text-red-700">
                Couldn&apos;t copy automatically. The key is selected; copy it by hand.
              </p>
            )}
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
            <span className="text-2xl">
              {storageType === 'server' ? '🖥️' : storageType === 'remote' ? '☁️' : '📦'}
            </span>
            <div>
              <div className="font-medium text-gray-900">
                Storage:{' '}
                {storageType === 'server'
                  ? 'Remote Backend'
                  : storageType === 'remote'
                    ? 'Remote Storage'
                    : 'IndexedDB (Local)'}
              </div>
              <div className="text-sm text-gray-500">
                {storageType === 'server'
                  ? 'Server owns storage and runs the backend'
                  : storageType === 'remote'
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
