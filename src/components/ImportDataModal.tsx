/**
 * Import Data Modal
 * Handles CSV file upload and encryption key input for data import
 * Supports both normal import and migration mode (full restore)
 */

import { useState, useRef, useEffect } from 'react';
import Modal from './ui/Modal';
import { storage } from '../services/storage';
import { showAlert, showDestructiveConfirm } from '../utils/alerts';
import type { ImportProgress } from '../utils/dataImport';

interface ImportDataModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (
    file: File,
    cek: string,
    onProgress?: (progress: ImportProgress) => void
  ) => Promise<{ imported: number; skipped: number; errors: string[] }>;
  onMigrate: (
    file: File,
    cek: string,
    onProgress?: (progress: ImportProgress) => void
  ) => Promise<{ imported: number; skipped: number; errors: string[] }>;
}

export function ImportDataModal({ isOpen, onClose, onImport, onMigrate }: ImportDataModalProps) {
  const [cek, setCek] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    imported: number;
    skipped: number;
    errors: string[];
  } | null>(null);
  const [isMigrationMode, setIsMigrationMode] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Check if storage is empty on mount
  useEffect(() => {
    if (isOpen) {
      checkStorageEmpty();
    }
  }, [isOpen]);

  const checkStorageEmpty = async () => {
    try {
      const isEmpty = await storage.isStorageEmpty();
      // Auto-check migration mode if storage is empty
      setIsMigrationMode(isEmpty);
    } catch (error) {
      console.error('[ImportDataModal] Failed to check storage empty status:', error);
      setIsMigrationMode(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      if (!selectedFile.name.endsWith('.csv')) {
        setError('Please select a CSV file');
        setFile(null);
        return;
      }
      setFile(selectedFile);
      setError(null);
    }
  };

  const handleImport = async () => {
    if (!file) {
      setError('Please select a file');
      return;
    }

    if (!cek.trim()) {
      setError('Please enter the encryption key');
      return;
    }

    // Extra confirmation for migration mode
    if (isMigrationMode) {
      const confirmed = await showDestructiveConfirm(
        '⚠️ MIGRATION MODE WARNING',
        'This will:\n' +
          '• DELETE all current projects, chats, and messages\n' +
          '• DELETE your current encryption key\n' +
          '• RESTORE the complete backup from the CSV file\n' +
          '• SET your encryption key to match the backup\n\n' +
          'This action is IRREVERSIBLE!\n\n' +
          'Are you absolutely sure you want to proceed?',
        'Proceed'
      );

      if (!confirmed) {
        return;
      }

      // Second confirmation
      const doubleConfirmed = await showDestructiveConfirm(
        'FINAL CONFIRMATION',
        'You are about to permanently erase all current data.\n\n' +
          'Click Confirm to proceed with migration, or Cancel to abort.',
        'Confirm Migration'
      );

      if (!doubleConfirmed) {
        return;
      }
    }

    try {
      setIsImporting(true);
      setImportProgress(0);
      setError(null);
      setResult(null);

      const progressCallback = (progress: ImportProgress) => {
        setImportProgress(progress.processed);
      };

      const importResult = isMigrationMode
        ? await onMigrate(file, cek.trim(), progressCallback)
        : await onImport(file, cek.trim(), progressCallback);

      setResult(importResult);

      if (importResult.errors.length === 0) {
        const title = isMigrationMode ? 'Migration Successful' : 'Import Successful';
        const message = isMigrationMode
          ? `Restored: ${importResult.imported} records\n\nYour encryption key has been updated to match the backup.`
          : `Imported: ${importResult.imported} records\nSkipped: ${importResult.skipped} duplicates`;

        await showAlert(title, message);

        if (isMigrationMode) {
          // Reload page after migration to reinitialize everything
          window.location.reload();
        } else {
          handleClose();
        }
      } else {
        setError(
          `Import completed with errors:\n${importResult.errors.slice(0, 5).join('\n')}${
            importResult.errors.length > 5
              ? `\n...and ${importResult.errors.length - 5} more errors`
              : ''
          }`
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setIsImporting(false);
    }
  };

  const handleClose = () => {
    if (!isImporting) {
      setCek('');
      setFile(null);
      setError(null);
      setResult(null);
      setIsMigrationMode(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      onClose();
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose}>
      <div className="w-full max-w-md rounded-lg bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 p-6">
          <h2 className="text-xl font-semibold text-gray-900">Import Data</h2>
          <button
            onClick={handleClose}
            disabled={isImporting}
            className="text-2xl leading-none text-gray-400 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div className="space-y-4 p-6">
          {/* Encryption Key Input */}
          <div>
            <label htmlFor="import-cek" className="mb-2 block text-sm font-semibold text-gray-900">
              Encryption Key
            </label>
            <p className="mb-2 text-xs text-gray-600">
              Enter the encryption key from the device where the data was exported.
            </p>
            <input
              id="import-cek"
              type="text"
              value={cek}
              onChange={e => setCek(e.target.value)}
              disabled={isImporting}
              placeholder="Enter encryption key..."
              className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-base focus:border-transparent focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100"
            />
          </div>
          {/* File Upload */}
          <div>
            <label htmlFor="import-file" className="mb-2 block text-sm font-semibold text-gray-900">
              CSV File
            </label>
            <p className="mb-2 text-xs text-gray-600">
              Select the CSV file exported from another device.
            </p>
            <div className="flex items-center gap-2">
              <input
                id="import-file"
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleFileChange}
                disabled={isImporting}
                className="flex-1 text-sm text-gray-600 file:mr-4 file:rounded-lg file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
            {file && (
              <p className="mt-1 text-xs text-gray-600">
                Selected: {file.name} ({(file.size / 1024).toFixed(1)} KB)
              </p>
            )}
          </div>
          {/* Error Message */}
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-xs whitespace-pre-wrap text-red-700">{error}</p>
            </div>
          )}
          {/* Result Message */}
          {result && result.errors.length === 0 && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3">
              <p className="text-xs text-green-700">
                ✓ Imported {result.imported} records, skipped {result.skipped} duplicates
              </p>
            </div>
          )}
          {/* Migration Mode Checkbox */}
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={isMigrationMode}
                onChange={e => setIsMigrationMode(e.target.checked)}
                disabled={isImporting}
                className="mt-0.5 cursor-pointer"
              />
              <div>
                <p className="text-sm font-semibold text-blue-900">Migration Mode (Full Restore)</p>
                <p className="mt-1 text-xs text-blue-700">
                  Restore complete backup with original encryption key. Recommended when setting up
                  a new device from backup.
                </p>
              </div>
            </label>
          </div>
          {/* Warning */}
          {isMigrationMode ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-xs text-red-800">
                <strong>⚠️ MIGRATION MODE:</strong> This will DELETE all current data and encryption
                key, then restore the complete backup. You will be prompted for confirmation.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3">
              <p className="text-xs text-yellow-800">
                ⚠️ <strong>Important:</strong> Duplicate IDs will be skipped. Existing data will not
                be overwritten.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 border-t border-gray-200 p-6">
          <button
            onClick={handleClose}
            disabled={isImporting}
            className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:bg-gray-100"
          >
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={isImporting || !file || !cek.trim()}
            className={`flex-1 px-4 py-2 ${
              isMigrationMode ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-500 hover:bg-blue-600'
            } flex items-center justify-center gap-2 rounded-lg text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-300`}
          >
            {isImporting ? (
              <>
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                {isMigrationMode ? 'Migrating...' : 'Importing...'}{' '}
                {importProgress > 0 && `${importProgress} entries`}
              </>
            ) : isMigrationMode ? (
              '🔴 Migrate (Erase & Restore)'
            ) : (
              'Import'
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}
