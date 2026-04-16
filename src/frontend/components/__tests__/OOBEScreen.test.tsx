import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OOBEScreen } from '../OOBEScreen';

// Mock gremlinClient — OOBEScreen is now a thin shell over the protocol.
const mockInit = vi.fn().mockResolvedValue({
  ok: true,
  subscriberId: 'sub_test',
  serverVersion: '1.0.0-phase1',
});
const mockConfigureWorker = vi.fn().mockResolvedValue(undefined);
const mockValidateRemoteStorage = vi.fn().mockResolvedValue({ ok: true });
const mockIsStorageEmpty = vi.fn().mockResolvedValue(true);
const mockGetProjects = vi.fn().mockResolvedValue([]);
const mockGetAPIDefinitions = vi.fn().mockResolvedValue([]);
const mockClearCek = vi.fn().mockResolvedValue(undefined);
const mockImportFromBytes = vi.fn().mockResolvedValue({
  imported: 10,
  skipped: 2,
  errors: [],
});
const mockGenerateNewCEK = vi.fn().mockResolvedValue('generated_test_cek_base32');
const mockNormalizeCEK = vi.fn(async (input: string) => input);
const mockDeriveUserIdFromCEK = vi
  .fn()
  .mockResolvedValue('mock_user_id_64_chars_abcdef1234567890abcdef1234567890abcdef12');
vi.mock('../../client', () => ({
  gremlinClient: {
    init: (...args: unknown[]) => mockInit(...args),
    configureWorker: (...args: unknown[]) => mockConfigureWorker(...args),
    validateRemoteStorage: (...args: unknown[]) => mockValidateRemoteStorage(...args),
    isStorageEmpty: () => mockIsStorageEmpty(),
    getProjects: () => mockGetProjects(),
    getAPIDefinitions: () => mockGetAPIDefinitions(),
    clearCek: () => mockClearCek(),
    importFromBytes: (...args: unknown[]) => mockImportFromBytes(...args),
    generateNewCEK: () => mockGenerateNewCEK(),
    normalizeCEK: (input: string) => mockNormalizeCEK(input),
    deriveUserIdFromCEK: (cek: string) => mockDeriveUserIdFromCEK(cek),
  },
}));

// Mock the localStorage / hashing helpers so tests can assert against the
// values OOBEScreen would persist + send over the wire.
const mockSetCachedCEKString = vi.fn();
const mockClearCachedCEK = vi.fn();
const mockSetStorageConfig = vi.fn();
const mockHashPassword = vi.fn((password: string) =>
  Promise.resolve(password ? `hashed_${password}` : '')
);
vi.mock('../../lib/localStorageBoot', () => ({
  setCachedCEKString: (cek: string) => mockSetCachedCEKString(cek),
  clearCachedCEK: () => mockClearCachedCEK(),
  setStorageConfig: (config: unknown) => mockSetStorageConfig(config),
  hashPassword: (password: string) => mockHashPassword(password),
}));

// Mock fetch for the /health probe in OOBEScreen's testRemoteConnection.
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
    mockInit.mockResolvedValue({
      ok: true,
      subscriberId: 'sub_test',
      serverVersion: '1.0.0-phase1',
    });
    mockValidateRemoteStorage.mockResolvedValue({ ok: true });
    mockIsStorageEmpty.mockResolvedValue(true);
    mockGetProjects.mockResolvedValue([]);
    mockGetAPIDefinitions.mockResolvedValue([]);
    mockImportFromBytes.mockResolvedValue({ imported: 10, skipped: 2, errors: [] });
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

      const cekInput = screen.getByPlaceholderText('Enter the encryption key from your backup...');
      fireEvent.change(cekInput, { target: { value: 'test-cek' } });

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      expect(getStartedButton).toBeDisabled();
    });

    it('should disable button when CEK is missing', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

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

      expect(getStartedButton).toBeDisabled();

      const fileInput = getFileInput();
      const validFile = new File(['col1,col2\nval1,val2'], 'backup.csv', { type: 'text/csv' });
      fireEvent.change(fileInput, { target: { files: [validFile] } });

      expect(getStartedButton).toBeDisabled();

      const cekInput = screen.getByPlaceholderText('Enter the encryption key from your backup...');
      fireEvent.change(cekInput, { target: { value: 'test-cek' } });

      expect(getStartedButton).not.toBeDisabled();
    });
  });

  describe('fresh mode flow', () => {
    it('should call onComplete with fresh mode result', async () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      fireEvent.click(getStartedButton);

      await waitFor(() => {
        expect(mockOnComplete).toHaveBeenCalledWith({
          mode: 'fresh',
          cek: 'generated_test_cek_base32',
          storageType: 'indexeddb',
        });
      });
    });

    it('persists CEK + local storage config and inits the worker', async () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);
      fireEvent.click(screen.getByRole('button', { name: /Get Started/i }));

      await waitFor(() => {
        expect(mockSetCachedCEKString).toHaveBeenCalledWith('generated_test_cek_base32');
        expect(mockSetStorageConfig).toHaveBeenCalledWith({ type: 'local' });
        // Storage config flows through `configureWorker` (out-of-band),
        // not the typed `init` envelope. `init` only carries `{cek}`.
        expect(mockConfigureWorker).toHaveBeenCalledWith({ type: 'local' });
        expect(mockInit).toHaveBeenCalledWith({
          cek: 'generated_test_cek_base32',
        });
      });
    });
  });

  describe('import mode flow', () => {
    it('should call onComplete with import mode result', async () => {
      mockImportFromBytes.mockResolvedValue({
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
      // jsdom's File polyfill omits arrayBuffer; stub it so OOBE's read works.
      Object.defineProperty(validFile, 'arrayBuffer', {
        value: () => Promise.resolve(new ArrayBuffer(8)),
      });
      fireEvent.change(fileInput, { target: { files: [validFile] } });

      // Add CEK (use a base32 value so the format check passes)
      const cekInput = screen.getByPlaceholderText('Enter the encryption key from your backup...');
      fireEvent.change(cekInput, { target: { value: 'testcekbase32' } });

      // Submit
      const getStartedButton = screen.getByRole('button', { name: /Get Started/i });
      fireEvent.click(getStartedButton);

      await waitFor(() => {
        expect(mockOnComplete).toHaveBeenCalledWith({
          mode: 'import',
          cek: 'testcekbase32',
          storageType: 'indexeddb',
          importStats: {
            imported: 15,
            skipped: 3,
            errors: [],
          },
        });
      });
    });

    it('streams the backup through importFromBytes in replace mode', async () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const importRadio = screen.getByRole('radio', { name: /Import from Backup/i });
      fireEvent.click(importRadio);

      const fileInput = getFileInput();
      const validFile = new File(['col1,col2\nval1,val2'], 'backup.csv', { type: 'text/csv' });
      Object.defineProperty(validFile, 'arrayBuffer', {
        value: () => Promise.resolve(new ArrayBuffer(8)),
      });
      fireEvent.change(fileInput, { target: { files: [validFile] } });

      const cekInput = screen.getByPlaceholderText('Enter the encryption key from your backup...');
      fireEvent.change(cekInput, { target: { value: 'testcekbase32' } });

      fireEvent.click(screen.getByRole('button', { name: /Get Started/i }));

      await waitFor(() => {
        expect(mockImportFromBytes).toHaveBeenCalled();
      });
      const [bytes, sourceCek, mode] = mockImportFromBytes.mock.calls[0];
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(sourceCek).toBe('testcekbase32');
      expect(mode).toBe('replace');
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

      const fileInput = getFileInput();
      const validFile = new File(['col1,col2\nval1,val2'], 'backup.csv', { type: 'text/csv' });
      fireEvent.change(fileInput, { target: { files: [validFile] } });

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
      expect(
        screen.getByPlaceholderText('https://example.com/storage or /storage')
      ).toBeInTheDocument();
    });

    it('should hide remote storage options when IndexedDB selected', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      expect(screen.getByText('Server URL')).toBeInTheDocument();

      const localRadio = screen.getByRole('radio', { name: /IndexedDB/i });
      fireEvent.click(localRadio);

      expect(screen.queryByText('Server URL')).not.toBeInTheDocument();
    });

    it('should change footer note when remote is selected', () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);

      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      expect(
        screen.getByText('Your data is encrypted before being sent to the server')
      ).toBeInTheDocument();
    });
  });

  describe('storage config persistence', () => {
    it('persists local storage config in fresh mode', async () => {
      render(<OOBEScreen onComplete={mockOnComplete} />);
      fireEvent.click(screen.getByRole('button', { name: /Get Started/i }));

      await waitFor(() => {
        expect(mockSetStorageConfig).toHaveBeenCalledWith({ type: 'local' });
      });
    });

    it('persists remote storage config with hashed password and derived userId', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });

      render(<OOBEScreen onComplete={mockOnComplete} />);

      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      const urlInput = screen.getByPlaceholderText('https://example.com/storage or /storage');
      fireEvent.change(urlInput, { target: { value: 'https://my-server.com/storage' } });

      const passwordInput = screen.getByPlaceholderText('Server password if configured');
      fireEvent.change(passwordInput, { target: { value: 'secret123' } });

      fireEvent.click(screen.getByRole('button', { name: /Get Started/i }));

      await waitFor(() => {
        expect(mockSetStorageConfig).toHaveBeenCalledWith({
          type: 'remote',
          baseUrl: 'https://my-server.com/storage',
          password: 'hashed_secret123',
          userId: 'mock_user_id_64_chars_abcdef1234567890abcdef1234567890abcdef12',
        });
      });
    });

    it('shows error when remote connection probe fails', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Connection refused' }),
      });

      render(<OOBEScreen onComplete={mockOnComplete} />);

      const remoteRadio = screen.getByRole('radio', { name: /Remote Storage/i });
      fireEvent.click(remoteRadio);

      const urlInput = screen.getByPlaceholderText('https://example.com/storage or /storage');
      fireEvent.change(urlInput, { target: { value: 'https://my-server.com/storage' } });

      fireEvent.click(screen.getByRole('button', { name: /Get Started/i }));

      await waitFor(() => {
        expect(
          screen.getByText('Could not connect to storage backend. Please verify the URL.')
        ).toBeInTheDocument();
      });
    });
  });
});
