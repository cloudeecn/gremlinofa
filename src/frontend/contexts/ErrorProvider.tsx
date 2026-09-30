import { useState, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { ErrorContext, type CapturedError } from './ErrorContext';
import { generateUniqueId } from '../../shared/protocol/idGenerator';
import { mapStackTrace, isProductionBuild } from '../lib/stackTraceMapper';
import { CrashView, ErrorBoundary } from '../components/ErrorBoundary';

interface ErrorProviderProps {
  children: ReactNode;
}

export function ErrorProvider({ children }: ErrorProviderProps) {
  const [errors, setErrors] = useState<CapturedError[]>([]);

  const addError = useCallback((error: Error) => {
    const errorId = generateUniqueId('err');
    const capturedError: CapturedError = {
      id: errorId,
      message: error.message || 'Unknown error',
      stack: error.stack || 'No stack trace available',
      timestamp: Date.now(),
    };

    setErrors(prev => [...prev, capturedError]);
    console.debug('[ErrorProvider] Error captured:', capturedError.message);

    // In production builds, asynchronously map stack trace to original source locations
    if (isProductionBuild()) {
      mapStackTrace(error).then(mappedStack => {
        setErrors(prev => prev.map(e => (e.id === errorId ? { ...e, mappedStack } : e)));
        console.debug('[ErrorProvider] Stack trace mapped for error:', errorId);
      });
    }
  }, []);

  const removeError = useCallback((id: string) => {
    setErrors(prev => prev.filter(e => e.id !== id));
  }, []);

  const clearErrors = useCallback(() => {
    setErrors([]);
  }, []);

  // Global error handlers
  useEffect(() => {
    const handleGlobalError = (event: ErrorEvent) => {
      console.debug('[ErrorProvider] Global error caught:', event.message);

      const error = new Error(event.message);
      error.stack = event.error?.stack || `at ${event.filename}:${event.lineno}:${event.colno}`;

      addError(error);
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.debug('[ErrorProvider] Unhandled rejection caught:', event.reason);

      let error: Error;
      if (event.reason instanceof Error) {
        error = event.reason;
      } else {
        error = new Error(String(event.reason));
        error.stack = 'Unhandled Promise Rejection\n' + (new Error().stack || '');
      }

      addError(error);
    };

    window.addEventListener('error', handleGlobalError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    return () => {
      window.removeEventListener('error', handleGlobalError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, [addError]);

  const contextValue = useMemo(
    () => ({ errors, addError, removeError, clearErrors }),
    [errors, addError, removeError, clearErrors]
  );

  return (
    <ErrorContext.Provider value={contextValue}>
      {/* Last line of defence; each route has its own boundary that keeps the sidebar */}
      <ErrorBoundary
        onError={addError}
        fallback={error => (
          <div className="flex h-dvh">
            <CrashView error={error} />
          </div>
        )}
      >
        {children}
      </ErrorBoundary>
    </ErrorContext.Provider>
  );
}
