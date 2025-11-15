import React, { useState, useCallback, useEffect, Component, type ReactNode } from 'react';
import { ErrorContext, type CapturedError } from './ErrorContext';
import { generateUniqueId } from '../utils/idGenerator';
import { mapStackTrace, isProductionBuild } from '../utils/stackTraceMapper';

// Error Boundary class component that logs errors but continues rendering
interface ErrorBoundaryProps {
  children: ReactNode;
  onError: (error: Error) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class ErrorBoundaryInner extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    // Don't block rendering - just mark that an error occurred
    return { hasError: false };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Log and capture the error
    console.debug('[ErrorBoundary] Caught error:', error.message);

    // Add component stack to the error stack
    const fullStack = error.stack
      ? `${error.stack}\n\nComponent Stack:${errorInfo.componentStack}`
      : `Component Stack:${errorInfo.componentStack}`;

    const enhancedError = new Error(error.message);
    enhancedError.stack = fullStack;

    this.props.onError(enhancedError);
  }

  render(): ReactNode {
    return this.props.children;
  }
}

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

  return (
    <ErrorContext.Provider value={{ errors, addError, removeError, clearErrors }}>
      <ErrorBoundaryInner onError={addError}>{children}</ErrorBoundaryInner>
    </ErrorContext.Provider>
  );
}
