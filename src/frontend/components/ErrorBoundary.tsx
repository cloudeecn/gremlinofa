import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Rendered instead of the children after a render error; `reset` tries them again. */
  fallback: (error: Error, reset: () => void) => ReactNode;
  /** Gets the error with the component stack appended. */
  onError?: (error: Error) => void;
  /** A new value clears a caught error. The route boundary passes the path, so navigating away recovers. */
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  error: Error | null;
  resetKey: unknown;
}

/**
 * Catches render errors below it and shows `fallback` instead of unmounting
 * the whole tree (React's default is a white screen).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState
  ): Partial<ErrorBoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.debug('[ErrorBoundary] Caught error: %s', error.message);
    const withComponentStack = new Error(error.message);
    withComponentStack.stack = error.stack
      ? `${error.stack}\n\nComponent Stack:${errorInfo.componentStack}`
      : `Component Stack:${errorInfo.componentStack}`;
    this.props.onError?.(withComponentStack);
  }

  private reset = () => this.setState({ error: null });

  render(): ReactNode {
    if (this.state.error) return this.props.fallback(this.state.error, this.reset);
    return this.props.children;
  }
}

interface CrashViewProps {
  error: Error;
  /** Omitted for the full-page boundary, where only a reload helps */
  onRetry?: () => void;
  /** Opens the sidebar drawer on a phone, so the user can go elsewhere */
  onMenuPress?: () => void;
}

/** What a boundary shows: the error, plus a way out. */
export function CrashView({ error, onRetry, onMenuPress }: CrashViewProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      {onMenuPress && (
        <div className="md:hidden">
          <div className="safe-area-inset-top" />
          <div className="flex h-14 items-center px-4">
            <button
              onClick={onMenuPress}
              aria-label="Open menu"
              className="-ml-2 flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-gray-100"
            >
              <span className="text-2xl text-gray-700">☰</span>
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-1 items-center justify-center p-4">
        <div role="alert" className="max-w-md text-center">
          <div className="mb-4 text-4xl">🙀</div>
          <h2 className="mb-2 text-xl font-semibold text-gray-800">This page crashed</h2>
          <p className="mb-6 break-words text-gray-600">{error.message}</p>
          <div className="flex justify-center gap-3">
            {onRetry && (
              <button
                onClick={onRetry}
                className="rounded-lg border border-gray-300 px-6 py-3 text-gray-700 transition-colors hover:bg-gray-50"
              >
                Try again
              </button>
            )}
            <button
              onClick={() => window.location.reload()}
              className="rounded-lg bg-gray-900 px-6 py-3 text-white transition-colors hover:bg-gray-800"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
