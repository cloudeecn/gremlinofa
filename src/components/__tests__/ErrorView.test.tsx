import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ErrorView } from '../ErrorView';
import type { CapturedError } from '../../contexts/ErrorContext';

describe('ErrorView', () => {
  const mockOnClose = vi.fn();
  const mockOnRemoveError = vi.fn();
  const mockOnClearAll = vi.fn();

  const createError = (overrides: Partial<CapturedError> = {}): CapturedError => ({
    id: 'err-1',
    message: 'Test error message',
    stack: 'Error: Test error\n    at test.ts:1:1',
    timestamp: Date.now(),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should not render when isOpen is false', () => {
      render(
        <ErrorView
          isOpen={false}
          onClose={mockOnClose}
          errors={[createError()]}
          onRemoveError={mockOnRemoveError}
          onClearAll={mockOnClearAll}
        />
      );

      expect(screen.queryByText('Errors')).not.toBeInTheDocument();
    });

    it('should not render when errors array is empty', () => {
      render(
        <ErrorView
          isOpen={true}
          onClose={mockOnClose}
          errors={[]}
          onRemoveError={mockOnRemoveError}
          onClearAll={mockOnClearAll}
        />
      );

      expect(screen.queryByText('Errors')).not.toBeInTheDocument();
    });

    it('should render error view when open with errors', () => {
      render(
        <ErrorView
          isOpen={true}
          onClose={mockOnClose}
          errors={[createError()]}
          onRemoveError={mockOnRemoveError}
          onClearAll={mockOnClearAll}
        />
      );

      expect(screen.getByText('Errors (1)')).toBeInTheDocument();
      expect(screen.getByText('Test error message')).toBeInTheDocument();
    });

    it('should display stack trace', () => {
      const error = createError({
        stack: 'Error: Test\n    at foo.ts:10:5\n    at bar.ts:20:3',
      });

      render(
        <ErrorView
          isOpen={true}
          onClose={mockOnClose}
          errors={[error]}
          onRemoveError={mockOnRemoveError}
          onClearAll={mockOnClearAll}
        />
      );

      expect(screen.getByText('Stack Trace')).toBeInTheDocument();
      expect(screen.getByText(/Error: Test/)).toBeInTheDocument();
    });

    it('should display timestamp', () => {
      const timestamp = new Date('2024-01-15T10:30:00').getTime();
      const error = createError({ timestamp });

      render(
        <ErrorView
          isOpen={true}
          onClose={mockOnClose}
          errors={[error]}
          onRemoveError={mockOnRemoveError}
          onClearAll={mockOnClearAll}
        />
      );

      // Check timestamp is displayed (format varies by locale)
      const timestampElement = screen.getByText(/:\d{2}/);
      expect(timestampElement).toBeInTheDocument();
    });
  });

  describe('navigation', () => {
    it('should not show navigation for single error', () => {
      render(
        <ErrorView
          isOpen={true}
          onClose={mockOnClose}
          errors={[createError()]}
          onRemoveError={mockOnRemoveError}
          onClearAll={mockOnClearAll}
        />
      );

      expect(screen.queryByText('← Previous')).not.toBeInTheDocument();
      expect(screen.queryByText('Next →')).not.toBeInTheDocument();
    });

    it('should show navigation for multiple errors', () => {
      const errors = [
        createError({ id: 'err-1', message: 'Error 1' }),
        createError({ id: 'err-2', message: 'Error 2' }),
      ];

      render(
        <ErrorView
          isOpen={true}
          onClose={mockOnClose}
          errors={errors}
          onRemoveError={mockOnRemoveError}
          onClearAll={mockOnClearAll}
        />
      );

      expect(screen.getByText('← Previous')).toBeInTheDocument();
      expect(screen.getByText('Next →')).toBeInTheDocument();
      expect(screen.getByText('1 / 2')).toBeInTheDocument();
    });

    it('should navigate to next error', () => {
      const errors = [
        createError({ id: 'err-1', message: 'Error 1' }),
        createError({ id: 'err-2', message: 'Error 2' }),
      ];

      render(
        <ErrorView
          isOpen={true}
          onClose={mockOnClose}
          errors={errors}
          onRemoveError={mockOnRemoveError}
          onClearAll={mockOnClearAll}
        />
      );

      expect(screen.getByText('Error 1')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Next →'));

      expect(screen.getByText('Error 2')).toBeInTheDocument();
      expect(screen.getByText('2 / 2')).toBeInTheDocument();
    });

    it('should navigate to previous error', () => {
      const errors = [
        createError({ id: 'err-1', message: 'Error 1' }),
        createError({ id: 'err-2', message: 'Error 2' }),
      ];

      render(
        <ErrorView
          isOpen={true}
          onClose={mockOnClose}
          errors={errors}
          onRemoveError={mockOnRemoveError}
          onClearAll={mockOnClearAll}
        />
      );

      // Go to second error
      fireEvent.click(screen.getByText('Next →'));
      expect(screen.getByText('Error 2')).toBeInTheDocument();

      // Go back to first
      fireEvent.click(screen.getByText('← Previous'));
      expect(screen.getByText('Error 1')).toBeInTheDocument();
      expect(screen.getByText('1 / 2')).toBeInTheDocument();
    });

    it('should disable Previous button on first error', () => {
      const errors = [
        createError({ id: 'err-1', message: 'Error 1' }),
        createError({ id: 'err-2', message: 'Error 2' }),
      ];

      render(
        <ErrorView
          isOpen={true}
          onClose={mockOnClose}
          errors={errors}
          onRemoveError={mockOnRemoveError}
          onClearAll={mockOnClearAll}
        />
      );

      const prevButton = screen.getByText('← Previous');
      expect(prevButton).toBeDisabled();
    });

    it('should disable Next button on last error', () => {
      const errors = [
        createError({ id: 'err-1', message: 'Error 1' }),
        createError({ id: 'err-2', message: 'Error 2' }),
      ];

      render(
        <ErrorView
          isOpen={true}
          onClose={mockOnClose}
          errors={errors}
          onRemoveError={mockOnRemoveError}
          onClearAll={mockOnClearAll}
        />
      );

      // Go to last error
      fireEvent.click(screen.getByText('Next →'));

      const nextButton = screen.getByText('Next →');
      expect(nextButton).toBeDisabled();
    });
  });

  describe('actions', () => {
    it('should call onClose when close button clicked', () => {
      render(
        <ErrorView
          isOpen={true}
          onClose={mockOnClose}
          errors={[createError()]}
          onRemoveError={mockOnRemoveError}
          onClearAll={mockOnClearAll}
        />
      );

      fireEvent.click(screen.getByText('✕'));
      expect(mockOnClose).toHaveBeenCalled();
    });

    it('should call onClose when backdrop clicked', () => {
      render(
        <ErrorView
          isOpen={true}
          onClose={mockOnClose}
          errors={[createError()]}
          onRemoveError={mockOnRemoveError}
          onClearAll={mockOnClearAll}
        />
      );

      // Find backdrop by its class
      const backdrop = document.querySelector('.animate-fade-in');
      expect(backdrop).toBeInTheDocument();
      fireEvent.click(backdrop!);
      expect(mockOnClose).toHaveBeenCalled();
    });

    it('should call onRemoveError when Dismiss This clicked', () => {
      const error = createError({ id: 'err-123' });

      render(
        <ErrorView
          isOpen={true}
          onClose={mockOnClose}
          errors={[error]}
          onRemoveError={mockOnRemoveError}
          onClearAll={mockOnClearAll}
        />
      );

      fireEvent.click(screen.getByText('Dismiss This'));
      expect(mockOnRemoveError).toHaveBeenCalledWith('err-123');
    });

    it('should call onClearAll when Clear All Errors clicked', () => {
      render(
        <ErrorView
          isOpen={true}
          onClose={mockOnClose}
          errors={[createError()]}
          onRemoveError={mockOnRemoveError}
          onClearAll={mockOnClearAll}
        />
      );

      fireEvent.click(screen.getByText('Clear All Errors'));
      expect(mockOnClearAll).toHaveBeenCalled();
    });
  });

  describe('index clamping', () => {
    it('should clamp index when errors are removed', () => {
      const errors = [
        createError({ id: 'err-1', message: 'Error 1' }),
        createError({ id: 'err-2', message: 'Error 2' }),
        createError({ id: 'err-3', message: 'Error 3' }),
      ];

      const { rerender } = render(
        <ErrorView
          isOpen={true}
          onClose={mockOnClose}
          errors={errors}
          onRemoveError={mockOnRemoveError}
          onClearAll={mockOnClearAll}
        />
      );

      // Navigate to last error (index 2)
      fireEvent.click(screen.getByText('Next →'));
      fireEvent.click(screen.getByText('Next →'));
      expect(screen.getByText('Error 3')).toBeInTheDocument();
      expect(screen.getByText('3 / 3')).toBeInTheDocument();

      // Reduce to 2 errors - index should clamp
      const reducedErrors = [
        createError({ id: 'err-1', message: 'Error 1' }),
        createError({ id: 'err-2', message: 'Error 2' }),
      ];

      rerender(
        <ErrorView
          isOpen={true}
          onClose={mockOnClose}
          errors={reducedErrors}
          onRemoveError={mockOnRemoveError}
          onClearAll={mockOnClearAll}
        />
      );

      // Should now show last valid error
      expect(screen.getByText('2 / 2')).toBeInTheDocument();
      expect(screen.getByText('Error 2')).toBeInTheDocument();
    });
  });
});
