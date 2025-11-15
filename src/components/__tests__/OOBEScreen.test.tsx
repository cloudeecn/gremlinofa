import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OOBEScreen } from '../OOBEScreen';

// Mock encryptionService (static import)
vi.mock('../../services/encryption/encryptionService', () => ({
  encryptionService: {
    initialize: vi.fn().mockResolvedValue(undefined),
    getCEK: vi.fn().mockReturnValue('MOCK_CEK_12345678901234567890123456789012=='),
    importCEK: vi.fn().mockResolvedValue(true),
    deriveUserId: vi
      .fn()
      .mockResolvedValue('mock_user_id_64_chars_abcdef1234567890abcdef1234567890abcdef12'),
  },
}));

// Mock createStorage factory (static import)
const mockStorageInitialize = vi.fn().mockResolvedValue(undefined);
const mockAdapterInitialize = vi.fn().mockResolvedValue(undefined);
const mockCreateStorage = vi.fn().mockReturnValue({
  initialize: mockStorageInitialize,
  getAdapter: vi.fn().mockReturnValue({
    initialize: mockAdapterInitialize,
  }),
});
vi.mock('../../services/storage', () => ({
  createStorage: (config: unknown) => mockCreateStorage(config),
}));

// Mock migrateDataFromFile (static import)
vi.mock('../../utils/dataImport', () => ({
  migrateDataFromFile: vi.fn().mockResolvedValue({
    imported: 10,
    skipped: 2,
    errors: [],
  }),
}));

// Mock storage config
const mockSetStorageConfig = vi.fn();
vi.mock('../../services/storage/storageConfig', () => ({
  setStorageConfig: (config: unknown) => mockSetStorageConfig(config),
}));

// Mock fetch for connection testing
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('OOBEScreen', () => {
  const mockOnComplete = vi.fn();

  // Helper to get file input (since it doesn't have proper label association)
  const getFileInput = () => {
    return document.querySelector('input[type="file"]') as HTMLInputElement;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render welcome header', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      expect(screen.getByText('Welcome to GremlinOFA')).toBeInTheDocument();
      expect(screen.getByText("Let's get your workspace set up")).toBeInTheDocument();
    });

    it('should render storage system section', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      expect(screen.getByText('Storage System')).toBeInTheDocument();
      expect(screen.getByText('IndexedDB (Local)')).toBeInTheDocument();
      expect(screen.getByText('Data stored in your browser')).toBeInTheDocument();
    });

    it('should show Remote Storage option', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      expect(screen.getByText('Remote Storage')).toBeInTheDocument();
      expect(screen.getByText('Sync across devices via storage-backend')).toBeInTheDocument();
    });

    it('should render initialize data section', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      expect(screen.getByText('Initialize Data')).toBeInTheDocument();
      expect(screen.getByText('Start Fresh')).toBeInTheDocument();
      expect(screen.getByText('Import from Backup')).toBeInTheDocument();
    });

    it('should render Get Started button', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      expect(screen.getByRole('button', { name: /Get Started/i })).toBeInTheDocument();
    });

    it('should render footer note', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      expect(
        screen.getByText('Your data is encrypted and stored locally in your browser')
      ).toBeInTheDocument();
    });
  });

  describe('init mode selection', () => {
    it('should have Start Fresh selected by default', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const startFreshRadio = screen.getByRole('radio', { name: /Start Fresh/i });
      expect(startFreshRadio).toBeChecked();
    });

    it('should switch to Import from Backup mode', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      expect(importRadio).toBeChecked();
    });

    it('should show import options when Import from Backup is selected', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      expect(screen.getByText('Backup File (CSV)')).toBeInTheDocument();
      expect(screen.getByText('Encryption Key')).toBeInTheDocument();
    });

    it('should hide import options when Start Fresh is selected', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      // First select import mode
      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      expect(screen.getByText('Backup File (CSV)')).toBeInTheDocument();

      // Then switch back to fresh mode
      const freshRadio = screen.getByRole('radio', { name: /Start Fresh/i });
      fireEvent.click(freshRadio);

      expect(screen.queryByText('Backup File (CSV)')).not.toBeInTheDocument();
    });
  });

  describe('file input', () => {
    it('should accept CSV files', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      const fileInput = getFileInput();
      expect(fileInput).toHaveAttribute('accept', '.csv');
    });

    it('should show error for non-CSV file', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      const fileInput = getFileInput();
      const invalidFile = new File(['content'], 'test.txt', { type: 'text/plain' });

      fireEvent.change(fileInput, { target: { files: [invalidFile] } });

      expect(screen.getByText('Please select a CSV file')).toBeInTheDocument();
    });

    it('should accept valid CSV file', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      const fileInput = getFileInput();
      const validFile = new File(['col1,col2\nval1,val2'], 'backup.csv', { type: 'text/csv' });
      Object.defineProperty(validFile, 'size', { value: 1024 });

      fireEvent.change(fileInput, { target: { files: [validFile] } });

      expect(screen.queryByText('Please select a CSV file')).not.toBeInTheDocument();
      expect(screen.getByText(/Selected: backup.csv/)).toBeInTheDocument();
    });
  });

  describe('CEK input', () => {
    it('should have CEK input field in import mode', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      const cekInput = screen.getByPlaceholderText('Enter the encryption key from your backup...');
      expect(cekInput).toBeInTheDocument();
    });

    it('should update CEK input value', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      const cekInput = screen.getByPlaceholderText('Enter the encryption key from your backup...');
      fireEvent.change(cekInput, { target: { value: 'test-cek' } });

      expect(cekInput).toHaveValue('test-cek');
    });
  });

  describe('validation - import mode', () => {
    it('should disable button when file is missing', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      // Enter CEK but no file - button should be disabled
      const cekInput = screen.getByPlaceholderText('Enter the encryption key from your backup...');
      fireEvent.change(cekInput, { target: { value: 'test-cek' } });

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      expect(getStartedButton).toBeDisabled();
    });

    it('should disable button when CEK is missing', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      // Select file but no CEK - button should be disabled
      const fileInput = getFileInput();
      const validFile = new File(['col1,col2\nval1,val2'], 'backup.csv', { type: 'text/csv' });
      fireEvent.change(fileInput, { target: { files: [validFile] } });

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      expect(getStartedButton).toBeDisabled();
    });

    it('should enable button only when both file and CEK are provided', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });

      // Initially disabled
      expect(getStartedButton).toBeDisabled();

      // Add file
      const fileInput = getFileInput();
      const validFile = new File(['col1,col2\nval1,val2'], 'backup.csv', { type: 'text/csv' });
      fireEvent.change(fileInput, { target: { files: [validFile] } });

      // Still disabled (no CEK)
      expect(getStartedButton).toBeDisabled();

      // Add CEK
      const cekInput = screen.getByPlaceholderText('Enter the encryption key from your backup...');
      fireEvent.change(cekInput, { target: { value: 'test-cek' } });

      // Now enabled
      expect(getStartedButton).not.toBeDisabled();
    });
  });

  describe('fresh mode flow', () => {
    it('should call onComplete with fresh mode result', async () => {
      // Need to mock at the module level for dynamic imports
      const mockEncryptionService = await import('../../services/encryption/encryptionService');
      vi.mocked(mockEncryptionService.encryptionService.initialize).mockResolvedValue(undefined);
      vi.mocked(mockEncryptionService.encryptionService.getCEK).mockReturnValue('GENERATED_CEK');

      render(<OOBEScreen onComplete={mockOnComplete} />);

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      fireEvent.click(getStartedButton);

      await waitFor(() => {
        expect(mockOnComplete).toHaveBeenCalledWith({
          mode: 'fresh',
          cek: 'GENERATED_CEK',
          storageType: 'indexeddb',
        });
      });
    });

    it('should show loading state while processing', async () => {
      // Make the initialization slow
      const mockEncryptionService = await import('../../services/encryption/encryptionService');
      vi.mocked(mockEncryptionService.encryptionService.initialize).mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 100))
      );

      render(<OOBEScreen onComplete={mockOnComplete} />);

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      fireEvent.click(getStartedButton);

      expect(screen.getByText('Setting up...')).toBeInTheDocument();
    });

    it('should show error when CEK generation fails', async () => {
      const mockEncryptionService = await import('../../services/encryption/encryptionService');
      vi.mocked(mockEncryptionService.encryptionService.initialize).mockResolvedValue(undefined);
      vi.mocked(mockEncryptionService.encryptionService.getCEK).mockReturnValue(null);

      render(<OOBEScreen onComplete={mockOnComplete} />);

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      fireEvent.click(getStartedButton);

      await waitFor(() => {
        expect(screen.getByText('Failed to generate encryption key')).toBeInTheDocument();
      });
    });
  });

  describe('import mode flow', () => {
    it('should call onComplete with import mode result', async () => {
      const mockEncryptionService = await import('../../services/encryption/encryptionService');
      const mockDataImport = await import('../../utils/dataImport');

      vi.mocked(mockEncryptionService.encryptionService.importCEK).mockResolvedValue(true);
      vi.mocked(mockDataImport.migrateDataFromFile).mockResolvedValue({
        imported: 15,
        skipped: 3,
        errors: [],
      });

      render(<OOBEScreen onComplete={mockOnComplete} />);

      // Select import mode
      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      // Add file
      const fileInput = getFileInput();
      const validFile = new File(['col1,col2\nval1,val2'], 'backup.csv', { type: 'text/csv' });
      fireEvent.change(fileInput, { target: { files: [validFile] } });

      // Add CEK
      const cekInput = screen.getByPlaceholderText('Enter the encryption key from your backup...');
      fireEvent.change(cekInput, { target: { value: 'test-cek-value' } });

      // Submit
      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      fireEvent.click(getStartedButton);

      await waitFor(() => {
        expect(mockOnComplete).toHaveBeenCalledWith({
          mode: 'import',
          cek: 'test-cek-value',
          storageType: 'indexeddb',
          importStats: {
            imported: 15,
            skipped: 3,
            errors: [],
          },
        });
      });
    });

    it('should show loading state while importing', async () => {
      const mockEncryptionService = await import('../../services/encryption/encryptionService');
      vi.mocked(mockEncryptionService.encryptionService.importCEK).mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve(true), 100))
      );

      render(<OOBEScreen onComplete={mockOnComplete} />);

      // Select import mode
      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      // Add file
      const fileInput = getFileInput();
      const validFile = new File(['col1,col2\nval1,val2'], 'backup.csv', { type: 'text/csv' });
      fireEvent.change(fileInput, { target: { files: [validFile] } });

      // Add CEK
      const cekInput = screen.getByPlaceholderText('Enter the encryption key from your backup...');
      fireEvent.change(cekInput, { target: { value: 'test-cek' } });

      // Submit
      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      fireEvent.click(getStartedButton);

      expect(screen.getByText('Importing...')).toBeInTheDocument();
    });

    it('should show error when CEK import fails', async () => {
      const mockEncryptionService = await import('../../services/encryption/encryptionService');
      vi.mocked(mockEncryptionService.encryptionService.importCEK).mockResolvedValue(false);

      render(<OOBEScreen onComplete={mockOnComplete} />);

      // Select import mode
      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      // Add file
      const fileInput = getFileInput();
      const validFile = new File(['col1,col2\nval1,val2'], 'backup.csv', { type: 'text/csv' });
      fireEvent.change(fileInput, { target: { files: [validFile] } });

      // Add CEK
      const cekInput = screen.getByPlaceholderText('Enter the encryption key from your backup...');
      fireEvent.change(cekInput, { target: { value: 'invalid-cek' } });

      // Submit
      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      fireEvent.click(getStartedButton);

      await waitFor(() => {
        expect(screen.getByText('Invalid encryption key format')).toBeInTheDocument();
      });
    });
  });

  describe('button state', () => {
    it('should enable Get Started button in fresh mode', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      expect(getStartedButton).not.toBeDisabled();
    });

    it('should disable Get Started button in import mode without file', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      expect(getStartedButton).toBeDisabled();
    });

    it('should disable Get Started button in import mode without CEK', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      // Add file but no CEK
      const fileInput = getFileInput();
      const validFile = new File(['col1,col2\nval1,val2'], 'backup.csv', { type: 'text/csv' });
      fireEvent.change(fileInput, { target: { files: [validFile] } });

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      expect(getStartedButton).toBeDisabled();
    });

    it('should enable Get Started button in import mode with file and CEK', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      // Add file
      const fileInput = getFileInput();
      const validFile = new File(['col1,col2\nval1,val2'], 'backup.csv', { type: 'text/csv' });
      fireEvent.change(fileInput, { target: { files: [validFile] } });

      // Add CEK
      const cekInput = screen.getByPlaceholderText('Enter the encryption key from your backup...');
      fireEvent.change(cekInput, { target: { value: 'test-cek' } });

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      expect(getStartedButton).not.toBeDisabled();
    });
  });

  describe('remote storage selection', () => {
    it('should switch to remote storage mode', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      expect(remoteRadio).toBeChecked();
    });

    it('should show remote storage options when selected', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      expect(screen.getByText('Server URL')).toBeInTheDocument();
      expect(screen.getByText('Password (optional)')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Test Connection/i })).toBeInTheDocument();
    });

    it('should hide remote storage options when IndexedDB selected', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      // First select remote
      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      expect(screen.getByText('Server URL')).toBeInTheDocument();

      // Then switch back to IndexedDB
      const indexedDBRadio = screen.getByRole('radio', { name: /IndexedDB/i });
      fireEvent.click(indexedDBRadio);

      expect(screen.queryByText('Server URL')).not.toBeInTheDocument();
    });

    it('should update remote URL input', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      const urlInput = screen.getByPlaceholderText('https://example.com/storage or /storage');
      fireEvent.change(urlInput, { target: { value: 'https://my-server.com/storage' } });

      expect(urlInput).toHaveValue('https://my-server.com/storage');
    });

    it('should update remote password input', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      const passwordInput = screen.getByPlaceholderText('Server password if configured');
      fireEvent.change(passwordInput, { target: { value: 'secret123' } });

      expect(passwordInput).toHaveValue('secret123');
    });

    it('should disable Get Started button when remote selected without URL', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      expect(getStartedButton).toBeDisabled();
    });

    it('should enable Get Started button when remote selected with URL', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      const urlInput = screen.getByPlaceholderText('https://example.com/storage or /storage');
      fireEvent.change(urlInput, { target: { value: 'https://my-server.com/storage' } });

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      expect(getStartedButton).not.toBeDisabled();
    });

    it('should change footer note when remote is selected', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      // Local storage footer
      expect(
        screen.getByText('Your data is encrypted and stored locally in your browser')
      ).toBeInTheDocument();

      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      // Remote storage footer
      expect(
        screen.getByText('Your data is encrypted before being sent to the server')
      ).toBeInTheDocument();
    });
  });

  describe('remote storage connection testing', () => {
    it('should disable Test Connection button without URL', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      const testButton = screen.getByRole('button', { name: /Test Connection/i });
      expect(testButton).toBeDisabled();
    });

    it('should enable Test Connection button with URL', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      const urlInput = screen.getByPlaceholderText('https://example.com/storage or /storage');
      fireEvent.change(urlInput, { target: { value: 'https://my-server.com/storage' } });

      const testButton = screen.getByRole('button', { name: /Test Connection/i });
      expect(testButton).not.toBeDisabled();
    });

    it('should show Testing... while testing connection', async () => {
      mockFetch.mockImplementation(
        () =>
          new Promise(resolve =>
            setTimeout(
              () => resolve({ ok: true, json: () => Promise.resolve({ status: 'ok' }) }),
              100
            )
          )
      );

      render(<OOBEScreen onComplete={mockOnComplete} />);

      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      const urlInput = screen.getByPlaceholderText('https://example.com/storage or /storage');
      fireEvent.change(urlInput, { target: { value: 'https://my-server.com/storage' } });

      const testButton = screen.getByRole('button', { name: /Test Connection/i });
      fireEvent.click(testButton);

      expect(screen.getByText('Testing...')).toBeInTheDocument();
    });

    it('should show Connected on successful connection test', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });

      render(<OOBEScreen onComplete={mockOnComplete} />);

      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      const urlInput = screen.getByPlaceholderText('https://example.com/storage or /storage');
      fireEvent.change(urlInput, { target: { value: 'https://my-server.com/storage' } });

      const testButton = screen.getByRole('button', { name: /Test Connection/i });
      fireEvent.click(testButton);

      await waitFor(() => {
        expect(screen.getByText('✓ Connected')).toBeInTheDocument();
      });
    });

    it('should show Failed on failed connection test', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Unauthorized' }),
      });

      render(<OOBEScreen onComplete={mockOnComplete} />);

      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      const urlInput = screen.getByPlaceholderText('https://example.com/storage or /storage');
      fireEvent.change(urlInput, { target: { value: 'https://my-server.com/storage' } });

      const testButton = screen.getByRole('button', { name: /Test Connection/i });
      fireEvent.click(testButton);

      await waitFor(() => {
        expect(screen.getByText('✗ Failed')).toBeInTheDocument();
      });
    });

    it('should show error message on connection failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      render(<OOBEScreen onComplete={mockOnComplete} />);

      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      const urlInput = screen.getByPlaceholderText('https://example.com/storage or /storage');
      fireEvent.change(urlInput, { target: { value: 'https://my-server.com/storage' } });

      const testButton = screen.getByRole('button', { name: /Test Connection/i });
      fireEvent.click(testButton);

      await waitFor(() => {
        // Error thrown becomes "Connection test failed" in the catch
        // But the component actually shows the error from testRemoteConnection -> connection fails
        expect(
          screen.getByText('Could not connect to storage backend. Check the URL and try again.')
        ).toBeInTheDocument();
      });
    });
  });

  describe('storage config', () => {
    it('should save local storage config on fresh mode', async () => {
      const mockEncryptionService = await import('../../services/encryption/encryptionService');
      vi.mocked(mockEncryptionService.encryptionService.initialize).mockResolvedValue(undefined);
      vi.mocked(mockEncryptionService.encryptionService.getCEK).mockReturnValue('NEW_CEK');

      render(<OOBEScreen onComplete={mockOnComplete} />);

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      fireEvent.click(getStartedButton);

      await waitFor(() => {
        expect(mockSetStorageConfig).toHaveBeenCalledWith({ type: 'local' });
      });
    });

    it('should create storage with explicit local config', async () => {
      const mockEncryptionService = await import('../../services/encryption/encryptionService');
      vi.mocked(mockEncryptionService.encryptionService.initialize).mockResolvedValue(undefined);
      vi.mocked(mockEncryptionService.encryptionService.getCEK).mockReturnValue('NEW_CEK');

      render(<OOBEScreen onComplete={mockOnComplete} />);

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      fireEvent.click(getStartedButton);

      await waitFor(() => {
        // createStorage should be called with explicit config, not relying on global state
        expect(mockCreateStorage).toHaveBeenCalledWith({ type: 'local' });
      });
    });

    it('should create storage with explicit remote config', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });

      const mockEncryptionService = await import('../../services/encryption/encryptionService');
      vi.mocked(mockEncryptionService.encryptionService.initialize).mockResolvedValue(undefined);
      vi.mocked(mockEncryptionService.encryptionService.getCEK).mockReturnValue('NEW_CEK');
      vi.mocked(mockEncryptionService.encryptionService.deriveUserId).mockResolvedValue(
        'derived_user_id_64_chars_abcdef1234567890abcdef1234567890abcdef12'
      );

      render(<OOBEScreen onComplete={mockOnComplete} />);

      // Select remote storage
      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      // Fill in URL and password
      const urlInput = screen.getByPlaceholderText('https://example.com/storage or /storage');
      fireEvent.change(urlInput, { target: { value: 'https://my-server.com/storage' } });

      const passwordInput = screen.getByPlaceholderText('Server password if configured');
      fireEvent.change(passwordInput, { target: { value: 'secret123' } });

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      fireEvent.click(getStartedButton);

      await waitFor(() => {
        // createStorage should be called with explicit remote config
        expect(mockCreateStorage).toHaveBeenCalledWith({
          type: 'remote',
          baseUrl: 'https://my-server.com/storage',
          password: 'secret123',
          userId: 'derived_user_id_64_chars_abcdef1234567890abcdef1234567890abcdef12',
        });
      });
    });

    it('should save remote storage config with URL, password, and userId', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });

      const mockEncryptionService = await import('../../services/encryption/encryptionService');
      vi.mocked(mockEncryptionService.encryptionService.initialize).mockResolvedValue(undefined);
      vi.mocked(mockEncryptionService.encryptionService.getCEK).mockReturnValue('NEW_CEK');
      vi.mocked(mockEncryptionService.encryptionService.deriveUserId).mockResolvedValue(
        'derived_user_id_64_chars_abcdef1234567890abcdef1234567890abcdef12'
      );

      render(<OOBEScreen onComplete={mockOnComplete} />);

      // Select remote storage
      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      // Fill in URL and password
      const urlInput = screen.getByPlaceholderText('https://example.com/storage or /storage');
      fireEvent.change(urlInput, { target: { value: 'https://my-server.com/storage' } });

      const passwordInput = screen.getByPlaceholderText('Server password if configured');
      fireEvent.change(passwordInput, { target: { value: 'secret123' } });

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      fireEvent.click(getStartedButton);

      await waitFor(() => {
        expect(mockSetStorageConfig).toHaveBeenCalledWith({
          type: 'remote',
          baseUrl: 'https://my-server.com/storage',
          password: 'secret123',
          userId: 'derived_user_id_64_chars_abcdef1234567890abcdef1234567890abcdef12',
        });
      });
    });

    it('should derive and save userId for remote storage in import mode', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });

      const mockEncryptionService = await import('../../services/encryption/encryptionService');
      const mockDataImport = await import('../../utils/dataImport');

      vi.mocked(mockEncryptionService.encryptionService.importCEK).mockResolvedValue(true);
      vi.mocked(mockEncryptionService.encryptionService.deriveUserId).mockResolvedValue(
        'imported_user_id_64_chars_bcdef1234567890abcdef1234567890abcdef123'
      );
      vi.mocked(mockDataImport.migrateDataFromFile).mockResolvedValue({
        imported: 5,
        skipped: 0,
        errors: [],
      });

      render(<OOBEScreen onComplete={mockOnComplete} />);

      // Select remote storage
      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      // Fill in URL
      const urlInput = screen.getByPlaceholderText('https://example.com/storage or /storage');
      fireEvent.change(urlInput, { target: { value: 'https://import-server.com/storage' } });

      // Test connection to enable proceed
      const testButton = screen.getByRole('button', { name: /Test Connection/i });
      fireEvent.click(testButton);

      await waitFor(() => {
        expect(screen.getByText('✓ Connected')).toBeInTheDocument();
      });

      // Select import mode
      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      // Add file
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const validFile = new File(['col1,col2\nval1,val2'], 'backup.csv', { type: 'text/csv' });
      fireEvent.change(fileInput, { target: { files: [validFile] } });

      // Add CEK
      const cekInput = screen.getByPlaceholderText('Enter the encryption key from your backup...');
      fireEvent.change(cekInput, { target: { value: 'import-cek-value' } });

      // Submit
      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      fireEvent.click(getStartedButton);

      await waitFor(() => {
        expect(mockSetStorageConfig).toHaveBeenCalledWith({
          type: 'remote',
          baseUrl: 'https://import-server.com/storage',
          password: '',
          userId: 'imported_user_id_64_chars_bcdef1234567890abcdef1234567890abcdef123',
        });
      });
    });

    it('should test connection before proceeding with remote storage', async () => {
      // First call for auto-test, returns success
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });

      const mockEncryptionService = await import('../../services/encryption/encryptionService');
      vi.mocked(mockEncryptionService.encryptionService.initialize).mockResolvedValue(undefined);
      vi.mocked(mockEncryptionService.encryptionService.getCEK).mockReturnValue('NEW_CEK');

      render(<OOBEScreen onComplete={mockOnComplete} />);

      // Select remote storage
      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      // Fill in URL
      const urlInput = screen.getByPlaceholderText('https://example.com/storage or /storage');
      fireEvent.change(urlInput, { target: { value: 'https://my-server.com/storage' } });

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      fireEvent.click(getStartedButton);

      await waitFor(() => {
        // Should have called fetch for health check
        expect(mockFetch).toHaveBeenCalledWith('https://my-server.com/storage/health', {
          method: 'GET',
        });
      });
    });

    it('should show error when remote connection fails during setup', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Connection refused' }),
      });

      render(<OOBEScreen onComplete={mockOnComplete} />);

      // Select remote storage
      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      // Fill in URL
      const urlInput = screen.getByPlaceholderText('https://example.com/storage or /storage');
      fireEvent.change(urlInput, { target: { value: 'https://my-server.com/storage' } });

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      fireEvent.click(getStartedButton);

      await waitFor(() => {
        expect(
          screen.getByText('Could not connect to storage backend. Please verify the URL.')
        ).toBeInTheDocument();
      });
    });
  });
});
