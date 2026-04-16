import { createElement } from 'react';
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useAlert } from '../useAlert';
import { AlertContext } from '../../contexts/AlertContext';

interface AlertContextType {
  showAlert: (title: string, message: string) => Promise<void>;
  showConfirm: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
  showDestructiveConfirm: (
    title: string,
    message: string,
    confirmLabel?: string
  ) => Promise<boolean>;
}

describe('useAlert', () => {
  it('should throw error when used outside AlertProvider', () => {
    // Suppress console.error for this test
    const consoleError = console.error;
    console.error = vi.fn();

    expect(() => {
      renderHook(() => useAlert());
    }).toThrow('useAlert must be used within AlertProvider');

    console.error = consoleError;
  });

  it('should return context value when used inside AlertProvider', () => {
    const mockShowAlert = vi.fn();
    const mockShowConfirm = vi.fn();
    const mockShowDestructiveConfirm = vi.fn();

    const mockContextValue: AlertContextType = {
      showAlert: mockShowAlert,
      showConfirm: mockShowConfirm,
      showDestructiveConfirm: mockShowDestructiveConfirm,
    };

    const { result } = renderHook(() => useAlert(), {
      wrapper: ({ children }) =>
        createElement(AlertContext.Provider, { value: mockContextValue }, children),
    });

    expect(result.current).toBe(mockContextValue);
    expect(result.current.showAlert).toBe(mockShowAlert);
    expect(result.current.showConfirm).toBe(mockShowConfirm);
    expect(result.current.showDestructiveConfirm).toBe(mockShowDestructiveConfirm);
  });

  it('should allow calling alert functions from context', () => {
    const mockShowAlert = vi.fn().mockResolvedValue(undefined);
    const mockShowConfirm = vi.fn().mockResolvedValue(true);
    const mockShowDestructiveConfirm = vi.fn().mockResolvedValue(false);

    const mockContextValue: AlertContextType = {
      showAlert: mockShowAlert,
      showConfirm: mockShowConfirm,
      showDestructiveConfirm: mockShowDestructiveConfirm,
    };

    const { result } = renderHook(() => useAlert(), {
      wrapper: ({ children }) =>
        createElement(AlertContext.Provider, { value: mockContextValue }, children),
    });

    // Call showAlert
    result.current.showAlert('Test Title', 'Test Message');
    expect(mockShowAlert).toHaveBeenCalledWith('Test Title', 'Test Message');

    // Call showConfirm
    result.current.showConfirm('Confirm Title', 'Confirm Message', 'OK');
    expect(mockShowConfirm).toHaveBeenCalledWith('Confirm Title', 'Confirm Message', 'OK');

    // Call showDestructiveConfirm
    result.current.showDestructiveConfirm('Delete?', 'Are you sure?', 'Delete');
    expect(mockShowDestructiveConfirm).toHaveBeenCalledWith('Delete?', 'Are you sure?', 'Delete');
  });

  it('should support async alert functions', async () => {
    const mockShowAlert = vi.fn().mockResolvedValue(undefined);

    const mockContextValue: AlertContextType = {
      showAlert: mockShowAlert,
      showConfirm: vi.fn(),
      showDestructiveConfirm: vi.fn(),
    };

    const { result } = renderHook(() => useAlert(), {
      wrapper: ({ children }) =>
        createElement(AlertContext.Provider, { value: mockContextValue }, children),
    });

    await result.current.showAlert('Test', 'Message');
    expect(mockShowAlert).toHaveBeenCalled();
  });

  it('should support async confirm functions', async () => {
    const mockShowConfirm = vi.fn().mockResolvedValue(true);

    const mockContextValue: AlertContextType = {
      showAlert: vi.fn(),
      showConfirm: mockShowConfirm,
      showDestructiveConfirm: vi.fn(),
    };

    const { result } = renderHook(() => useAlert(), {
      wrapper: ({ children }) =>
        createElement(AlertContext.Provider, { value: mockContextValue }, children),
    });

    const confirmed = await result.current.showConfirm('Test', 'Message');
    expect(confirmed).toBe(true);
    expect(mockShowConfirm).toHaveBeenCalled();
  });

  it('should support async destructive confirm functions', async () => {
    const mockShowDestructiveConfirm = vi.fn().mockResolvedValue(false);

    const mockContextValue: AlertContextType = {
      showAlert: vi.fn(),
      showConfirm: vi.fn(),
      showDestructiveConfirm: mockShowDestructiveConfirm,
    };

    const { result } = renderHook(() => useAlert(), {
      wrapper: ({ children }) =>
        createElement(AlertContext.Provider, { value: mockContextValue }, children),
    });

    const confirmed = await result.current.showDestructiveConfirm('Delete?', 'Are you sure?');
    expect(confirmed).toBe(false);
    expect(mockShowDestructiveConfirm).toHaveBeenCalled();
  });
});
