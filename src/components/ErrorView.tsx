import { useState, useEffect, useMemo } from 'react';
import type { CapturedError } from '../contexts/ErrorContext';
import { isProductionBuild } from '../utils/stackTraceMapper';

interface ErrorViewProps {
  isOpen: boolean;
  onClose: () => void;
  errors: CapturedError[];
  onRemoveError: (id: string) => void;
  onClearAll: () => void;
}

export function ErrorView({ isOpen, onClose, errors, onRemoveError, onClearAll }: ErrorViewProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Clamp the index to valid range during render (avoids useEffect setState)
  const currentIndex = useMemo(() => {
    if (errors.length === 0) return 0;
    return Math.min(selectedIndex, errors.length - 1);
  }, [selectedIndex, errors.length]);

  // Close if no errors remain
  useEffect(() => {
    if (errors.length === 0 && isOpen) {
      onClose();
    }
  }, [errors.length, isOpen, onClose]);

  if (!isOpen || errors.length === 0) return null;

  const currentError = errors[currentIndex];
  const hasMultiple = errors.length > 1;

  const goToPrevious = () => {
    setSelectedIndex(prev => Math.max(0, prev - 1));
  };

  const goToNext = () => {
    setSelectedIndex(prev => Math.min(errors.length - 1, prev + 1));
  };

  const handleRemoveCurrent = () => {
    onRemoveError(currentError.id);
  };

  const formatTimestamp = (timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString();
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="bg-opacity-50 animate-fade-in fixed inset-0 z-50 bg-black"
        onClick={onClose}
      />
      {/* Modal */}
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="animate-scale-in pointer-events-auto flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
            <div className="flex items-center gap-3">
              <span className="text-2xl">⚠️</span>
              <h2 className="text-xl font-semibold text-gray-900">Errors ({errors.length})</h2>
            </div>
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              ✕
            </button>
          </div>

          {/* Navigation (if multiple errors) */}
          {hasMultiple && (
            <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-6 py-2">
              <button
                onClick={goToPrevious}
                disabled={currentIndex === 0}
                className="rounded px-3 py-1 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                ← Previous
              </button>
              <span className="text-sm text-gray-600">
                {currentIndex + 1} / {errors.length}
              </span>
              <button
                onClick={goToNext}
                disabled={currentIndex === errors.length - 1}
                className="rounded px-3 py-1 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          )}

          {/* Error Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {/* Error message */}
            <div className="mb-4">
              <div className="mb-1 text-xs text-gray-500">
                {formatTimestamp(currentError.timestamp)}
              </div>
              <div className="rounded-lg bg-red-50 px-4 py-3 text-red-800">
                <p className="font-medium">{currentError.message}</p>
              </div>
            </div>

            {/* Stack trace */}
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-medium text-gray-700">Stack Trace</span>
                {currentError.mappedStack && (
                  <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">
                    Source Mapped
                  </span>
                )}
                {!currentError.mappedStack && isProductionBuild() && (
                  <span className="rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700">
                    Mapping...
                  </span>
                )}
              </div>
              <pre className="max-h-64 overflow-auto rounded-lg bg-gray-100 p-4 text-xs text-gray-700">
                {currentError.mappedStack || currentError.stack}
              </pre>
            </div>
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-between border-t border-gray-200 px-6 py-4">
            <button
              onClick={handleRemoveCurrent}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              Dismiss This
            </button>
            <button
              onClick={onClearAll}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
            >
              Clear All Errors
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
