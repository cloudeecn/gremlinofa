import { createElement } from 'react';
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useError } from '../useError';
import {
  ErrorContext,
  type ErrorContextValue,
  type CapturedError,
} from '../../contexts/ErrorContext';

describe('useError', () => {
  it('should throw error when used outside ErrorProvider', () => {
    // Suppress console.error for this test
    const consoleError = console.error;
    console.error = vi.fn();

    expect(() => {
      renderHook(() => useError());
    }).toThrow('useError must be used within an ErrorProvider');

    console.error = consoleError;
  });

  it('should return context value when used inside ErrorProvider', () => {
    const mockAddError = vi.fn();
    const mockRemoveError = vi.fn();
    const mockClearErrors = vi.fn();
    const mockErrors: CapturedError[] = [];

    const mockContextValue: ErrorContextValue = {
      errors: mockErrors,
      addError: mockAddError,
      removeError: mockRemoveError,
      clearErrors: mockClearErrors,
    };

    const { result } = renderHook(() => useError(), {
      wrapper: ({ children }) =>
        createElement(ErrorContext.Provider, { value: mockContextValue }, children),
    });

    expect(result.current).toBe(mockContextValue);
    expect(result.current.errors).toBe(mockErrors);
    expect(result.current.addError).toBe(mockAddError);
    expect(result.current.removeError).toBe(mockRemoveError);
    expect(result.current.clearErrors).toBe(mockClearErrors);
  });

  it('should allow calling addError from context', () => {
    const mockAddError = vi.fn();

    const mockContextValue: ErrorContextValue = {
      errors: [],
      addError: mockAddError,
      removeError: vi.fn(),
      clearErrors: vi.fn(),
    };

    const { result } = renderHook(() => useError(), {
      wrapper: ({ children }) =>
        createElement(ErrorContext.Provider, { value: mockContextValue }, children),
    });

    const testError = new Error('Test error');
    result.current.addError(testError);
    expect(mockAddError).toHaveBeenCalledWith(testError);
  });

  it('should allow calling removeError from context', () => {
    const mockRemoveError = vi.fn();

    const mockContextValue: ErrorContextValue = {
      errors: [],
      addError: vi.fn(),
      removeError: mockRemoveError,
      clearErrors: vi.fn(),
    };

    const { result } = renderHook(() => useError(), {
      wrapper: ({ children }) =>
        createElement(ErrorContext.Provider, { value: mockContextValue }, children),
    });

    result.current.removeError('test-id');
    expect(mockRemoveError).toHaveBeenCalledWith('test-id');
  });

  it('should allow calling clearErrors from context', () => {
    const mockClearErrors = vi.fn();

    const mockContextValue: ErrorContextValue = {
      errors: [],
      addError: vi.fn(),
      removeError: vi.fn(),
      clearErrors: mockClearErrors,
    };

    const { result } = renderHook(() => useError(), {
      wrapper: ({ children }) =>
        createElement(ErrorContext.Provider, { value: mockContextValue }, children),
    });

    result.current.clearErrors();
    expect(mockClearErrors).toHaveBeenCalled();
  });

  it('should return errors array from context', () => {
    const mockErrors: CapturedError[] = [
      { id: 'err-1', message: 'Error 1', stack: 'Stack 1', timestamp: 1000 },
      { id: 'err-2', message: 'Error 2', stack: 'Stack 2', timestamp: 2000 },
    ];

    const mockContextValue: ErrorContextValue = {
      errors: mockErrors,
      addError: vi.fn(),
      removeError: vi.fn(),
      clearErrors: vi.fn(),
    };

    const { result } = renderHook(() => useError(), {
      wrapper: ({ children }) =>
        createElement(ErrorContext.Provider, { value: mockContextValue }, children),
    });

    expect(result.current.errors).toHaveLength(2);
    expect(result.current.errors[0].message).toBe('Error 1');
    expect(result.current.errors[1].message).toBe('Error 2');
  });
});
