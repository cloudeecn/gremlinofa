import { useState, useEffect, useRef, useCallback, useId, useMemo } from 'react';
import type { ReactNode } from 'react';
import { AlertContext } from './AlertContext';
import type { AlertOptions, ConfirmOptions } from './AlertContext';
import { setAlertContext } from '../lib/alerts';
import { useOverlay } from '../hooks/useOverlay';

interface AlertDialog extends AlertOptions {
  id: number;
  type: 'alert';
  resolve: () => void;
}

interface ConfirmDialog extends ConfirmOptions {
  id: number;
  type: 'confirm';
  resolve: (confirmed: boolean) => void;
}

type Dialog = AlertDialog | ConfirmDialog;

// Keys the dialog card so a queued dialog that replaces another remounts and
// its autoFocus button takes focus.
let nextDialogId = 0;

export function AlertProvider({ children }: { children: ReactNode }) {
  // One queue; the visible dialog is its head. Every `show*` appends through an
  // updater, so calls made in the same tick all show, one after another, and
  // every promise settles.
  const [queue, setQueue] = useState<Dialog[]>([]);
  const dialogState = queue[0] ?? null;

  const enqueue = useCallback((dialog: Dialog) => setQueue(current => [...current, dialog]), []);

  const showAlert = useCallback(
    (title: string, message: string): Promise<void> =>
      new Promise(resolve => {
        enqueue({ id: nextDialogId++, type: 'alert', title, message, resolve });
      }),
    [enqueue]
  );

  const showConfirm = useCallback(
    (title: string, message: string, confirmLabel?: string): Promise<boolean> =>
      new Promise(resolve => {
        enqueue({
          id: nextDialogId++,
          type: 'confirm',
          title,
          message,
          confirmLabel,
          isDestructive: false,
          resolve,
        });
      }),
    [enqueue]
  );

  const showDestructiveConfirm = useCallback(
    (title: string, message: string, confirmLabel?: string): Promise<boolean> =>
      new Promise(resolve => {
        enqueue({
          id: nextDialogId++,
          type: 'confirm',
          title,
          message,
          confirmLabel,
          isDestructive: true,
          resolve,
        });
      }),
    [enqueue]
  );

  /** Settles a dialog and lets the next one in. A double click settles nothing twice. */
  const settle = useCallback((dialog: Dialog, confirmed: boolean) => {
    if (dialog.type === 'confirm') dialog.resolve(confirmed);
    else dialog.resolve();
    setQueue(current => current.filter(entry => entry.id !== dialog.id));
  }, []);

  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const messageId = useId();
  // Stays active from one queued dialog to the next, so focus returns to the
  // opener only once the queue is empty
  useOverlay({
    active: dialogState !== null,
    onEscape: () => {
      if (dialogState) settle(dialogState, false);
    },
    containerRef: cardRef,
    trapFocus: true,
    restoreFocus: true,
  });

  const contextValue = useMemo(
    () => ({ showAlert, showConfirm, showDestructiveConfirm }),
    [showAlert, showConfirm, showDestructiveConfirm]
  );

  // Register alert context globally for utility functions (non-React code)
  useEffect(() => {
    setAlertContext(contextValue);
    return () => setAlertContext(null);
  }, [contextValue]);

  return (
    <AlertContext.Provider value={contextValue}>
      {children}
      {dialogState && (
        <>
          {/* Backdrop */}
          <div
            className="animate-fade-in fixed inset-0 z-50 bg-black/50"
            onClick={() => {
              // Only a confirm has an obvious answer for a backdrop click
              if (dialogState.type === 'confirm') settle(dialogState, false);
            }}
          />
          {/* Dialog Content */}
          <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
            <div
              key={dialogState.id}
              ref={cardRef}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={messageId}
              tabIndex={-1}
              className="animate-scale-in pointer-events-auto w-full max-w-md rounded-lg bg-white p-6 shadow-xl outline-none"
              onClick={e => e.stopPropagation()}
            >
              <h2 id={titleId} className="mb-3 text-xl font-semibold text-gray-900">
                {dialogState.title}
              </h2>
              <p id={messageId} className="mb-6 break-words whitespace-pre-wrap text-gray-700">
                {dialogState.message}
              </p>
              <div className="flex justify-end gap-3">
                {dialogState.type === 'alert' ? (
                  <button
                    className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700"
                    onClick={() => settle(dialogState, true)}
                    autoFocus
                  >
                    OK
                  </button>
                ) : (
                  <>
                    {/* A destructive confirm starts on Cancel so Enter/Space can't delete */}
                    <button
                      className="rounded-lg border border-gray-300 px-4 py-2 font-medium text-gray-700 transition-colors hover:bg-gray-50"
                      onClick={() => settle(dialogState, false)}
                      autoFocus={dialogState.isDestructive}
                    >
                      Cancel
                    </button>
                    <button
                      className={`rounded-lg px-4 py-2 font-medium transition-colors ${
                        dialogState.isDestructive
                          ? 'bg-red-600 text-white hover:bg-red-700'
                          : 'bg-blue-600 text-white hover:bg-blue-700'
                      }`}
                      onClick={() => settle(dialogState, true)}
                      autoFocus={!dialogState.isDestructive}
                    >
                      {dialogState.confirmLabel || 'Confirm'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </AlertContext.Provider>
  );
}
