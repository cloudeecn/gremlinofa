import { createElement } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ErrorFloatingButton } from '../ErrorFloatingButton';
import {
  ErrorContext,
  type ErrorContextValue,
  type CapturedError,
} from '../../contexts/ErrorContext';

describe('ErrorFloatingButton', () => {
  const createMockContext = (overrides: Partial<ErrorContextValue> = {}): ErrorContextValue => ({
    errors: [],
    addError: vi.fn(),
    removeError: vi.fn(),
    clearErrors: vi.fn(),
    ...overrides,
  });

  const createError = (overrides: Partial<CapturedError> = {}): CapturedError => ({
    id: 'err-1',
    message: 'Test error',
    stack: 'Error: Test\n    at test.ts:1:1',
    timestamp: Date.now(),
    ...overrides,
  });

  const renderWithContext = (contextValue: ErrorContextValue) => {
    return render(
      createElement(
        ErrorContext.Provider,
        { value: contextValue },
        createElement(ErrorFloatingButton)
      )
    );
  };

  describe('rendering', () => {
    it('should not render when no errors', () => {
      const context = createMockContext({ errors: [] });
      renderWithContext(context);

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('should render when errors exist', () => {
      const context = createMockContext({
        errors: [createError()],
      });
      renderWithContext(context);

      const button = screen.getByRole('button');
      expect(button).toBeInTheDocument();
    });

    it('should show error count badge', () => {
      const context = createMockContext({
        errors: [
          createError({ id: 'err-1' }),
          createError({ id: 'err-2' }),
          createError({ id: 'err-3' }),
        ],
      });
      renderWithContext(context);

      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('should show 99+ for more than 99 errors', () => {
      const errors = Array.from({ length: 100 }, (_, i) => createError({ id: `err-${i}` }));
      const context = createMockContext({ errors });
      renderWithContext(context);

      expect(screen.getByText('99+')).toBeInTheDocument();
    });

    it('should have correct aria-label for single error', () => {
      const context = createMockContext({
        errors: [createError()],
      });
      renderWithContext(context);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-label', 'View 1 error');
    });

    it('should have correct aria-label for multiple errors', () => {
      const context = createMockContext({
        errors: [createError({ id: 'err-1' }), createError({ id: 'err-2' })],
      });
      renderWithContext(context);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-label', 'View 2 errors');
    });
  });

  describe('interaction', () => {
    it('should open ErrorView when clicked', () => {
      const context = createMockContext({
        errors: [createError()],
      });
      renderWithContext(context);

      fireEvent.click(screen.getByRole('button'));

      // ErrorView should be visible
      expect(screen.getByText('Errors (1)')).toBeInTheDocument();
    });

    it('should close ErrorView when backdrop clicked', () => {
      const context = createMockContext({
        errors: [createError()],
      });
      renderWithContext(context);

      // Open ErrorView
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('Errors (1)')).toBeInTheDocument();

      // Click backdrop to close
      const backdrop = document.querySelector('.animate-fade-in');
      expect(backdrop).toBeInTheDocument();
      fireEvent.click(backdrop!);

      // ErrorView should be closed
      expect(screen.queryByText('Errors (1)')).not.toBeInTheDocument();
    });

    it('should call removeError when dismissing an error', () => {
      const mockRemoveError = vi.fn();
      const context = createMockContext({
        errors: [createError({ id: 'test-error-id' })],
        removeError: mockRemoveError,
      });
      renderWithContext(context);

      // Open ErrorView
      fireEvent.click(screen.getByRole('button'));

      // Click dismiss
      fireEvent.click(screen.getByText('Dismiss This'));
      expect(mockRemoveError).toHaveBeenCalledWith('test-error-id');
    });

    it('should call clearErrors when clearing all', () => {
      const mockClearErrors = vi.fn();
      const context = createMockContext({
        errors: [createError()],
        clearErrors: mockClearErrors,
      });
      renderWithContext(context);

      // Open ErrorView
      fireEvent.click(screen.getByRole('button'));

      // Click clear all
      fireEvent.click(screen.getByText('Clear All Errors'));
      expect(mockClearErrors).toHaveBeenCalled();
    });
  });

  describe('visibility transitions', () => {
    it('should disappear when errors are cleared', () => {
      const errors = [createError()];
      const context = createMockContext({ errors });
      const { rerender } = renderWithContext(context);

      // Button visible
      expect(screen.getByRole('button')).toBeInTheDocument();

      // Update with empty errors
      const emptyContext = createMockContext({ errors: [] });
      rerender(
        createElement(
          ErrorContext.Provider,
          { value: emptyContext },
          createElement(ErrorFloatingButton)
        )
      );

      // Button should be gone
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('should appear when first error is added', () => {
      const context = createMockContext({ errors: [] });
      const { rerender } = renderWithContext(context);

      // No button initially
      expect(screen.queryByRole('button')).not.toBeInTheDocument();

      // Add an error
      const contextWithError = createMockContext({
        errors: [createError()],
      });
      rerender(
        createElement(
          ErrorContext.Provider,
          { value: contextWithError },
          createElement(ErrorFloatingButton)
        )
      );

      // Button should appear
      expect(screen.getByRole('button')).toBeInTheDocument();
    });
  });
});
