import { createElement } from 'react';
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useApp } from '../useApp';
import { AppContext } from '../../contexts/createAppContext';
import type { AppContextType } from '../../contexts/createAppContext';

describe('useApp', () => {
  it('should throw error when used outside AppProvider', () => {
    // Suppress console.error for this test
    const consoleError = console.error;
    console.error = vi.fn();

    expect(() => {
      renderHook(() => useApp());
    }).toThrow('useApp must be used within an AppProvider');

    console.error = consoleError;
  });

  it('should return context value when used inside AppProvider', () => {
    const mockContextValue: AppContextType = {
      apiDefinitions: [],
      refreshAPIDefinitions: vi.fn().mockResolvedValue(undefined),
      saveAPIDefinition: vi.fn().mockResolvedValue(undefined),
      deleteAPIDefinition: vi.fn().mockResolvedValue(undefined),
      projects: [],
      refreshProjects: vi.fn().mockResolvedValue(undefined),
      saveProject: vi.fn().mockResolvedValue(undefined),
      deleteProject: vi.fn().mockResolvedValue(undefined),
      models: new Map(),
      refreshModels: vi.fn().mockResolvedValue(undefined),
      purgeAllData: vi.fn().mockResolvedValue(undefined),
      handleExport: vi.fn().mockResolvedValue(undefined),
      handleImport: vi.fn().mockResolvedValue({ imported: 0, skipped: 0, errors: [] }),
      handleMigrate: vi.fn().mockResolvedValue({ imported: 0, skipped: 0, errors: [] }),
      handleCompressMessages: vi
        .fn()
        .mockResolvedValue({ total: 0, compressed: 0, skipped: 0, errors: 0 }),
      cek: null,
      isCEKBase32: null,
      convertCEKToBase32: vi.fn().mockReturnValue(null),
      isInitializing: false,
      isLoadingProjects: false,
      isLoadingModels: false,
    };

    const { result } = renderHook(() => useApp(), {
      wrapper: ({ children }) =>
        createElement(AppContext.Provider, { value: mockContextValue }, children),
    });

    expect(result.current).toBe(mockContextValue);
    expect(result.current.cek).toBe(null);
    expect(result.current.projects).toEqual([]);
    expect(result.current.apiDefinitions).toEqual([]);
  });
});
