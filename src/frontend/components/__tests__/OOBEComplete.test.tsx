import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OOBEComplete } from '../OOBEComplete';

describe('OOBEComplete', () => {
  const mockCEK = 'ABCDEF1234567890ABCDEF1234567890ABCDEF12345678==';

  // Mock clipboard API
  const mockClipboard = {
    writeText: vi.fn().mockResolvedValue(undefined),
  };

  // Mock location.reload
  const mockReload = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup clipboard mock
    Object.defineProperty(navigator, 'clipboard', {
      value: mockClipboard,
      writable: true,
      configurable: true,
    });

    // Setup location mock
    Object.defineProperty(window, 'location', {
      value: { reload: mockReload },
      writable: true,
      configurable: true,
    });
  });

  describe('rendering - fresh mode', () => {
    it('should render success header for fresh mode', () => {
      render(<OOBEComplete mode="fresh" cek={mockCEK} storageType="indexeddb" />);

      expect(screen.getByText('Setup Complete!')).toBeInTheDocument();
      expect(screen.getByText('Your workspace is ready to use')).toBeInTheDocument();
    });

    it('should display the CEK', () => {
      render(<OOBEComplete mode="fresh" cek={mockCEK} storageType="indexeddb" />);

      expect(screen.getByText(mockCEK)).toBeInTheDocument();
    });

    it('should display encryption key section title', () => {
      render(<OOBEComplete mode="fresh" cek={mockCEK} storageType="indexeddb" />);

      expect(screen.getByText('Your Encryption Key')).toBeInTheDocument();
    });

    it('should display warning about saving the key', () => {
      render(<OOBEComplete mode="fresh" cek={mockCEK} storageType="indexeddb" />);

      expect(screen.getByText('Save this key somewhere safe!')).toBeInTheDocument();
      expect(
        screen.getByText(/You'll need it to restore your data on another device/)
      ).toBeInTheDocument();
    });

    it('should display local storage info for indexeddb', () => {
      render(<OOBEComplete mode="fresh" cek={mockCEK} storageType="indexeddb" />);

      expect(screen.getByText('Storage: IndexedDB (Local)')).toBeInTheDocument();
      expect(screen.getByText('Data stored locally in your browser')).toBeInTheDocument();
    });

    it('should display remote storage info for remote', () => {
      render(<OOBEComplete mode="fresh" cek={mockCEK} storageType="remote" />);

      expect(screen.getByText('Storage: Remote Storage')).toBeInTheDocument();
      expect(screen.getByText('Data synced via remote storage backend')).toBeInTheDocument();
    });

    it('should display Launch App button', () => {
      render(<OOBEComplete mode="fresh" cek={mockCEK} storageType="indexeddb" />);

      expect(screen.getByRole('button', { name: /Launch App/i })).toBeInTheDocument();
    });

    it('should not display import stats for fresh mode', () => {
      render(<OOBEComplete mode="fresh" cek={mockCEK} storageType="indexeddb" />);

      expect(screen.queryByText('Import Summary')).not.toBeInTheDocument();
    });
  });

  describe('rendering - import mode', () => {
    const importStats = {
      imported: 42,
      skipped: 3,
      errors: [],
    };

    it('should render success header for import mode', () => {
      render(
        <OOBEComplete
          mode="import"
          cek={mockCEK}
          storageType="indexeddb"
          importStats={importStats}
        />
      );

      expect(screen.getByText('Setup Complete!')).toBeInTheDocument();
      expect(screen.getByText('Your data has been imported successfully')).toBeInTheDocument();
    });

    it('should display import summary', () => {
      render(
        <OOBEComplete
          mode="import"
          cek={mockCEK}
          storageType="indexeddb"
          importStats={importStats}
        />
      );

      expect(screen.getByText('Import Summary')).toBeInTheDocument();
      expect(screen.getByText('✓ 42 records imported')).toBeInTheDocument();
    });

    it('should display skipped count when present', () => {
      render(
        <OOBEComplete
          mode="import"
          cek={mockCEK}
          storageType="indexeddb"
          importStats={importStats}
        />
      );

      expect(screen.getByText('⏭ 3 duplicates skipped')).toBeInTheDocument();
    });

    it('should not display skipped count when zero', () => {
      const statsNoSkipped = { imported: 10, skipped: 0, errors: [] };
      render(
        <OOBEComplete
          mode="import"
          cek={mockCEK}
          storageType="indexeddb"
          importStats={statsNoSkipped}
        />
      );

      expect(screen.queryByText(/duplicates skipped/)).not.toBeInTheDocument();
    });

    it('should display error count when present', () => {
      const statsWithErrors = {
        imported: 10,
        skipped: 0,
        errors: ['Error 1', 'Error 2'],
      };
      render(
        <OOBEComplete
          mode="import"
          cek={mockCEK}
          storageType="indexeddb"
          importStats={statsWithErrors}
        />
      );

      expect(screen.getByText('⚠ 2 errors occurred')).toBeInTheDocument();
    });

    it('should not display error count when no errors', () => {
      render(
        <OOBEComplete
          mode="import"
          cek={mockCEK}
          storageType="indexeddb"
          importStats={importStats}
        />
      );

      expect(screen.queryByText(/errors occurred/)).not.toBeInTheDocument();
    });
  });

  describe('copy functionality', () => {
    it('should have a Copy button', () => {
      render(<OOBEComplete mode="fresh" cek={mockCEK} storageType="indexeddb" />);

      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    });

    it('should copy CEK to clipboard when Copy button is clicked', async () => {
      render(<OOBEComplete mode="fresh" cek={mockCEK} storageType="indexeddb" />);

      const copyButton = screen.getByRole('button', { name: 'Copy' });
      fireEvent.click(copyButton);

      expect(mockClipboard.writeText).toHaveBeenCalledWith(mockCEK);
    });

    it('should show "✓ Copied" after successful copy', async () => {
      render(<OOBEComplete mode="fresh" cek={mockCEK} storageType="indexeddb" />);

      const copyButton = screen.getByRole('button', { name: 'Copy' });
      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: '✓ Copied' })).toBeInTheDocument();
      });
    });

    it('should revert to "Copy" after timeout', async () => {
      // This test verifies the copy button reverts its text after a timeout
      // Using real timers with a shorter wait since fake timers have issues with React state
      render(<OOBEComplete mode="fresh" cek={mockCEK} storageType="indexeddb" />);

      const copyButton = screen.getByRole('button', { name: 'Copy' });
      fireEvent.click(copyButton);

      // Wait for copied state
      await waitFor(() => {
        expect(screen.getByRole('button', { name: '✓ Copied' })).toBeInTheDocument();
      });

      // Wait for the reset (2000ms timeout in component)
      await waitFor(
        () => {
          expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });

    it('should handle clipboard error gracefully', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockClipboard.writeText.mockRejectedValueOnce(new Error('Clipboard error'));

      render(<OOBEComplete mode="fresh" cek={mockCEK} storageType="indexeddb" />);

      const copyButton = screen.getByRole('button', { name: 'Copy' });
      fireEvent.click(copyButton);

      // Wait for the rejection to be handled
      await waitFor(
        () => {
          expect(consoleError).toHaveBeenCalledWith('Failed to copy CEK:', expect.any(Error));
        },
        { timeout: 1000 }
      );

      consoleError.mockRestore();
    });
  });

  describe('launch app functionality', () => {
    it('should reload the page when Launch App is clicked', () => {
      render(<OOBEComplete mode="fresh" cek={mockCEK} storageType="indexeddb" />);

      const launchButton = screen.getByRole('button', { name: /Launch App/i });
      fireEvent.click(launchButton);

      expect(mockReload).toHaveBeenCalled();
    });
  });

  describe('footer', () => {
    it('should display footer note about reload', () => {
      render(<OOBEComplete mode="fresh" cek={mockCEK} storageType="indexeddb" />);

      expect(
        screen.getByText('The app will reload to initialize all services')
      ).toBeInTheDocument();
    });
  });
});
