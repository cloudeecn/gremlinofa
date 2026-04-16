import { useState } from 'react';
import { useError } from '../hooks/useError';
import { ErrorView } from './ErrorView';

export function ErrorFloatingButton() {
  const { errors, removeError, clearErrors } = useError();
  const [isErrorViewOpen, setIsErrorViewOpen] = useState(false);

  // Don't render anything if no errors
  if (errors.length === 0) return null;

  return (
    <>
      {/* Floating Error Button */}
      <button
        onClick={() => setIsErrorViewOpen(true)}
        className="error-floating-button fixed bottom-4 left-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-red-600 text-white shadow-lg transition-all hover:scale-105 hover:bg-red-700"
        aria-label={`View ${errors.length} error${errors.length > 1 ? 's' : ''}`}
      >
        <span className="text-xl">⚠️</span>
        {/* Error count badge */}
        <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-yellow-400 px-1 text-xs font-bold text-gray-900">
          {errors.length > 99 ? '99+' : errors.length}
        </span>
      </button>

      {/* Error View Modal */}
      <ErrorView
        isOpen={isErrorViewOpen}
        onClose={() => setIsErrorViewOpen(false)}
        errors={errors}
        onRemoveError={removeError}
        onClearAll={clearErrors}
      />
    </>
  );
}
