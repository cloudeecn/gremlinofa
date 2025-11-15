/**
 * OOBE (Out-of-Box Experience) Screen
 * Shown on first launch when no CEK exists
 * Single-page layout with all sections visible
 */

import { useState, useRef } from 'react';
import { setStorageConfig, type StorageConfig } from '../services/storage/storageConfig';
import { createStorage } from '../services/storage';
import { encryptionService } from '../services/encryption/encryptionService';
import { migrateDataFromFile, type ImportProgress } from '../utils/dataImport';
import { RemoteStorageAdapter } from '../services/storage/adapters/RemoteStorageAdapter';
import { Tables } from '../services/storage/StorageAdapter';

type StorageType = 'indexeddb' | 'remote';
type InitMode = 'fresh' | 'import' | 'existing';

interface OOBEResult {
  mode: InitMode;
  cek: string;
  storageType: StorageType;
  importStats?: {
    imported: number;
    skipped: number;
    errors: string[];
  };
}

interface OOBEScreenProps {
  onComplete: (result: OOBEResult) => void;
}

/**
 * Test connection to remote storage backend
 * @param baseUrl - Base URL for the storage backend
 * @returns true if connection successful, false otherwise
 */
async function testRemoteConnection(baseUrl: string): Promise<boolean> {
  try {
    const url = baseUrl ? `${baseUrl.replace(/\/$/, '')}/health` : '/health';
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) return false;
    const data = await response.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
}

export function OOBEScreen({ onComplete }: OOBEScreenProps) {
  // Section 1: Storage selection
  const [storageType, setStorageType] = useState<StorageType>('indexeddb');

  // Remote storage options
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remotePassword, setRemotePassword] = useState('');
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // Section 2: Init mode
  const [initMode, setInitMode] = useState<InitMode>('fresh');

  // Import options
  const [importCEK, setImportCEK] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Status
  const [isProcessing, setIsProcessing] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      if (!selectedFile.name.endsWith('.csv')) {
        setError('Please select a CSV file');
        setImportFile(null);
        return;
      }
      setImportFile(selectedFile);
      setError(null);
    }
  };

  const handleTestConnection = async () => {
    setIsTestingConnection(true);
    setConnectionStatus('idle');
    setError(null);

    try {
      const success = await testRemoteConnection(remoteUrl);
      setConnectionStatus(success ? 'success' : 'error');
      if (!success) {
        setError('Could not connect to storage backend. Check the URL and try again.');
      }
    } catch {
      setConnectionStatus('error');
      setError('Connection test failed');
    } finally {
      setIsTestingConnection(false);
    }
  };

  const handleGetStarted = async () => {
    setError(null);
    setIsProcessing(true);

    try {
      // For remote storage, test connection first if not already tested successfully
      if (storageType === 'remote') {
        if (connectionStatus !== 'success') {
          const success = await testRemoteConnection(remoteUrl);
          if (!success) {
            setError('Could not connect to storage backend. Please verify the URL.');
            setIsProcessing(false);
            return;
          }
        }
      }

      if (initMode === 'fresh') {
        // Initialize encryption (generates new CEK)
        await encryptionService.initialize();
        const newCEK = encryptionService.getCEK();

        if (!newCEK) {
          throw new Error('Failed to generate encryption key');
        }

        // Build storage config with explicit values
        let storageConfig: StorageConfig;
        if (storageType === 'remote') {
          const userId = await encryptionService.deriveUserId();
          storageConfig = {
            type: 'remote',
            baseUrl: remoteUrl,
            password: remotePassword,
            userId,
          };
        } else {
          storageConfig = { type: 'local' };
        }

        // Save config for future app loads
        setStorageConfig(storageConfig);

        // Create storage with explicit config (not relying on global state)
        const oobStorage = createStorage(storageConfig);

        // Initialize storage (creates IndexedDB or connects to remote, creates default API definitions)
        await oobStorage.initialize();

        onComplete({
          mode: 'fresh',
          cek: newCEK,
          storageType,
        });
      } else if (initMode === 'existing') {
        // Use existing remote data - validate CEK input
        if (!importCEK.trim()) {
          setError('Please enter your encryption key');
          setIsProcessing(false);
          return;
        }

        // Import the CEK
        const imported = await encryptionService.importCEK(importCEK.trim());
        if (!imported) {
          throw new Error('Invalid encryption key format');
        }

        // Derive userId and create remote adapter
        const userId = await encryptionService.deriveUserId();
        const adapter = new RemoteStorageAdapter(remoteUrl, userId, remotePassword);
        await adapter.initialize();

        // Try to fetch and decrypt one record to verify CEK
        // Order: projects → api_definitions → chats → messages → attachments
        const tablesToTry = [
          Tables.PROJECTS,
          Tables.API_DEFINITIONS,
          Tables.CHATS,
          Tables.MESSAGES,
          Tables.ATTACHMENTS,
        ];

        let verified = false;
        for (const table of tablesToTry) {
          try {
            const records = await adapter.query(table, {
              orderBy: 'timestamp',
              orderDirection: 'desc',
            });

            if (records.length > 0) {
              // Try to decrypt the first record
              const decrypted = await encryptionService.decrypt(records[0].encryptedData);
              // If we got here, decryption succeeded
              JSON.parse(decrypted); // Also verify it's valid JSON
              verified = true;
              console.debug(`[OOBE] CEK verified by decrypting record from ${table}`);
              break;
            }
          } catch (err) {
            // Decryption failed for this table - CEK might be wrong
            console.debug(`[OOBE] Failed to decrypt from ${table}:`, err);
            continue;
          }
        }

        if (!verified) {
          // Check if storage is actually empty
          let isEmpty = true;
          for (const table of tablesToTry) {
            const count = await adapter.count(table);
            if (count > 0) {
              isEmpty = false;
              break;
            }
          }

          if (isEmpty) {
            // Storage is empty, can't verify CEK but that's okay
            console.debug('[OOBE] Remote storage is empty, CEK cannot be verified');
          } else {
            // Storage has data but we couldn't decrypt - wrong CEK
            await encryptionService.clearCEK();
            throw new Error(
              'Could not decrypt existing data. Please verify your encryption key is correct.'
            );
          }
        }

        // Save storage config
        const storageConfig: StorageConfig = {
          type: 'remote',
          baseUrl: remoteUrl,
          password: remotePassword,
          userId,
        };
        setStorageConfig(storageConfig);

        onComplete({
          mode: 'existing',
          cek: importCEK.trim(),
          storageType: 'remote',
        });
      } else {
        // Import mode - validate inputs
        if (!importFile) {
          setError('Please select a backup file');
          setIsProcessing(false);
          return;
        }

        if (!importCEK.trim()) {
          setError('Please enter the encryption key from your backup');
          setIsProcessing(false);
          return;
        }

        // Import the CEK from backup
        const imported = await encryptionService.importCEK(importCEK.trim());
        if (!imported) {
          throw new Error('Invalid encryption key format');
        }

        // Build storage config with explicit values
        let storageConfig: StorageConfig;
        if (storageType === 'remote') {
          const userId = await encryptionService.deriveUserId();
          storageConfig = {
            type: 'remote',
            baseUrl: remoteUrl,
            password: remotePassword,
            userId,
          };
        } else {
          storageConfig = { type: 'local' };
        }

        // Save config for future app loads
        setStorageConfig(storageConfig);

        // Create storage with explicit config (not relying on global state)
        const oobStorage = createStorage(storageConfig);

        // Initialize storage adapter (not full initialize - just the adapter)
        const adapter = oobStorage.getAdapter();
        await adapter.initialize();

        // Reset progress and perform migration import
        setImportProgress(0);
        const progressCallback = (progress: ImportProgress) => {
          setImportProgress(progress.processed);
        };

        const result = await migrateDataFromFile(
          adapter,
          importFile,
          importCEK.trim(),
          encryptionService,
          progressCallback
        );

        if (result.errors.length > 0) {
          console.error('[OOBE] Import errors:', result.errors);
        }

        onComplete({
          mode: 'import',
          cek: importCEK.trim(),
          storageType,
          importStats: result,
        });
      }
    } catch (err) {
      console.error('[OOBE] Error:', err);
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
      setIsProcessing(false);
    }
  };

  const canProceed =
    (storageType === 'indexeddb' || (storageType === 'remote' && remoteUrl.trim())) &&
    (initMode === 'fresh' ||
      (initMode === 'import' && importFile && importCEK.trim()) ||
      (initMode === 'existing' && importCEK.trim()));

  return (
    <div className="safe-area-inset-x safe-area-inset-top safe-area-inset-bottom flex min-h-dvh items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-8 shadow-xl">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-gray-900">Welcome to GremlinOFA</h1>
          <p className="mt-2 text-gray-600">Let's get your workspace set up</p>
        </div>

        {/* Section 1: Storage System */}
        <div className="mb-6">
          <h2 className="mb-3 text-sm font-semibold tracking-wide text-gray-500 uppercase">
            Storage System
          </h2>
          <div className="space-y-2">
            {/* IndexedDB option */}
            <label
              className={`flex cursor-pointer items-center rounded-lg border-2 p-4 transition-colors ${
                storageType === 'indexeddb'
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <input
                type="radio"
                name="storage"
                value="indexeddb"
                checked={storageType === 'indexeddb'}
                onChange={() => {
                  setStorageType('indexeddb');
                  setConnectionStatus('idle');
                  setError(null);
                }}
                disabled={isProcessing}
                className="sr-only"
              />
              <div className="flex-1">
                <div className="font-medium text-gray-900">IndexedDB (Local)</div>
                <div className="text-sm text-gray-500">Data stored in your browser</div>
              </div>
              {storageType === 'indexeddb' && <div className="text-blue-500">✓</div>}
            </label>

            {/* Remote Storage option */}
            <label
              className={`flex cursor-pointer items-start rounded-lg border-2 p-4 transition-colors ${
                storageType === 'remote'
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <input
                type="radio"
                name="storage"
                value="remote"
                checked={storageType === 'remote'}
                onChange={() => {
                  setStorageType('remote');
                  setError(null);
                }}
                disabled={isProcessing}
                className="sr-only"
              />
              <div className="flex-1">
                <div className="font-medium text-gray-900">Remote Storage</div>
                <div className="text-sm text-gray-500">Sync across devices via storage-backend</div>
              </div>
              {storageType === 'remote' && <div className="text-blue-500">✓</div>}
            </label>
          </div>

          {/* Remote storage options (shown when remote selected) */}
          {storageType === 'remote' && (
            <div className="mt-4 space-y-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
              {/* Server URL input */}
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">Server URL</label>
                <input
                  type="text"
                  value={remoteUrl}
                  onChange={e => {
                    setRemoteUrl(e.target.value);
                    setConnectionStatus('idle');
                  }}
                  disabled={isProcessing}
                  placeholder="https://example.com/storage or /storage"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Full URL or path if hosted on same domain
                </p>
              </div>

              {/* Password input */}
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">
                  Password (optional)
                </label>
                <input
                  type="password"
                  value={remotePassword}
                  onChange={e => setRemotePassword(e.target.value)}
                  disabled={isProcessing}
                  placeholder="Server password if configured"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100"
                />
              </div>

              {/* Test Connection button */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleTestConnection}
                  disabled={!remoteUrl.trim() || isTestingConnection || isProcessing}
                  className="rounded-lg bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isTestingConnection ? 'Testing...' : 'Test Connection'}
                </button>
                {connectionStatus === 'success' && (
                  <span className="text-sm text-green-600">✓ Connected</span>
                )}
                {connectionStatus === 'error' && (
                  <span className="text-sm text-red-600">✗ Failed</span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Section 2: Initialize Data */}
        <div className="mb-6">
          <h2 className="mb-3 text-sm font-semibold tracking-wide text-gray-500 uppercase">
            Initialize Data
          </h2>
          <div className="space-y-2">
            {/* Start Fresh option */}
            <label
              className={`flex cursor-pointer items-center rounded-lg border-2 p-4 transition-colors ${
                initMode === 'fresh'
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <input
                type="radio"
                name="initMode"
                value="fresh"
                checked={initMode === 'fresh'}
                onChange={() => setInitMode('fresh')}
                disabled={isProcessing}
                className="sr-only"
              />
              <div className="flex-1">
                <div className="font-medium text-gray-900">Start Fresh</div>
                <div className="text-sm text-gray-500">
                  Create a new database with a fresh encryption key
                </div>
              </div>
              {initMode === 'fresh' && <div className="text-blue-500">✓</div>}
            </label>

            {/* Import from Backup option */}
            <label
              className={`flex cursor-pointer items-start rounded-lg border-2 p-4 transition-colors ${
                initMode === 'import'
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <input
                type="radio"
                name="initMode"
                value="import"
                checked={initMode === 'import'}
                onChange={() => setInitMode('import')}
                disabled={isProcessing}
                className="sr-only"
              />
              <div className="flex-1">
                <div className="font-medium text-gray-900">Import from Backup</div>
                <div className="text-sm text-gray-500">
                  Restore data from a CSV backup file with its encryption key
                </div>
              </div>
              {initMode === 'import' && <div className="text-blue-500">✓</div>}
            </label>

            {/* Use Existing Data option (only for remote storage) */}
            {storageType === 'remote' && (
              <label
                className={`flex cursor-pointer items-start rounded-lg border-2 p-4 transition-colors ${
                  initMode === 'existing'
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <input
                  type="radio"
                  name="initMode"
                  value="existing"
                  checked={initMode === 'existing'}
                  onChange={() => setInitMode('existing')}
                  disabled={isProcessing}
                  className="sr-only"
                />
                <div className="flex-1">
                  <div className="font-medium text-gray-900">Use Existing Data</div>
                  <div className="text-sm text-gray-500">
                    Connect to remote storage that already has your data
                  </div>
                </div>
                {initMode === 'existing' && <div className="text-blue-500">✓</div>}
              </label>
            )}
          </div>

          {/* Import options (shown when import mode selected) */}
          {initMode === 'import' && (
            <div className="mt-4 space-y-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
              {/* File input */}
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">
                  Backup File (CSV)
                </label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  onChange={handleFileChange}
                  disabled={isProcessing}
                  className="w-full text-base text-gray-600 file:mr-4 file:rounded-lg file:border-0 file:bg-blue-100 file:px-4 file:py-2 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-200 disabled:cursor-not-allowed disabled:opacity-50"
                />
                {importFile && (
                  <p className="mt-1 text-xs text-gray-500">
                    Selected: {importFile.name} ({(importFile.size / 1024).toFixed(1)} KB)
                  </p>
                )}
              </div>

              {/* CEK input */}
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">
                  Encryption Key
                </label>
                <input
                  type="text"
                  value={importCEK}
                  onChange={e => setImportCEK(e.target.value)}
                  disabled={isProcessing}
                  placeholder="Enter the encryption key from your backup..."
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100"
                />
                <p className="mt-1 text-xs text-gray-500">
                  This key was shown when you created the original database
                </p>
              </div>
            </div>
          )}

          {/* Existing data options (shown when existing mode selected) */}
          {initMode === 'existing' && (
            <div className="mt-4 space-y-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
              {/* CEK input */}
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">
                  Encryption Key
                </label>
                <input
                  type="text"
                  value={importCEK}
                  onChange={e => setImportCEK(e.target.value)}
                  disabled={isProcessing}
                  placeholder="Enter your encryption key..."
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Your existing encryption key will be verified by decrypting data from the server
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {/* Get Started button */}
        <button
          onClick={handleGetStarted}
          disabled={!canProceed || isProcessing}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-lg font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {isProcessing ? (
            <>
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
              {initMode === 'fresh'
                ? 'Setting up...'
                : initMode === 'existing'
                  ? 'Connecting...'
                  : `Importing...${importProgress > 0 ? ` ${importProgress} entries` : ''}`}
            </>
          ) : (
            <>🚀 Get Started</>
          )}
        </button>

        {/* Footer note */}
        <p className="mt-4 text-center text-xs text-gray-400">
          {storageType === 'remote'
            ? 'Your data is encrypted before being sent to the server'
            : 'Your data is encrypted and stored locally in your browser'}
        </p>
      </div>
    </div>
  );
}
