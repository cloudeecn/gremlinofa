import { useState, useEffect, useRef, useCallback } from 'react';
import type { ReactNode } from 'react';
import { AlertContext } from './AlertContext';
import type { AlertOptions, ConfirmOptions } from './AlertContext';
import { setAlertContext } from '../utils/alerts';

interface AlertState extends AlertOptions {
  type: 'alert';
  resolve: () => void;
}

interface ConfirmState extends ConfirmOptions {
  type: 'confirm';
  resolve: (confirmed: boolean) => void;
}

type DialogState = AlertState | ConfirmState | null;

export function AlertProvider({ children }: { children: ReactNode }) {
  const [dialogState, setDialogState] = useState<DialogState>(null);
  const [_queue, setQueue] = useState<DialogState[]>([]);

  // Ref tracks current dialogState so stable callbacks can read it
  const dialogStateRef = useRef<DialogState>(null);
  useEffect(() => {
    dialogStateRef.current = dialogState;
  }, [dialogState]);

  const showNext = useCallback(() => {
    setQueue(prev => {
      if (prev.length > 0) {
        const [next, ...rest] = prev;
        setDialogState(next);
        return rest;
      }
      return prev;
    });
  }, []);

  const showAlert = useCallback(
    (title: string, message: string): Promise<void> => {
      return new Promise(resolve => {
        const alertState: AlertState = {
          type: 'alert',
          title,
          message,
          resolve: () => {
            resolve();
            setDialogState(null);
            showNext();
          },
        };

        if (dialogStateRef.current === null) {
          setDialogState(alertState);
        } else {
          setQueue(prev => [...prev, alertState]);
        }
      });
    },
    [showNext]
  );

  const showConfirm = useCallback(
    (title: string, message: string, confirmLabel?: string): Promise<boolean> => {
      return new Promise(resolve => {
        const confirmState: ConfirmState = {
          type: 'confirm',
          title,
          message,
          confirmLabel,
          isDestructive: false,
          resolve: (confirmed: boolean) => {
            resolve(confirmed);
            setDialogState(null);
            showNext();
          },
        };

        if (dialogStateRef.current === null) {
          setDialogState(confirmState);
        } else {
          setQueue(prev => [...prev, confirmState]);
        }
      });
    },
    [showNext]
  );

  const showDestructiveConfirm = useCallback(
    (title: string, message: string, confirmLabel?: string): Promise<boolean> => {
      return new Promise(resolve => {
        const confirmState: ConfirmState = {
          type: 'confirm',
          title,
          message,
          confirmLabel,
          isDestructive: true,
          resolve: (confirmed: boolean) => {
            resolve(confirmed);
            setDialogState(null);
            showNext();
          },
        };

        if (dialogStateRef.current === null) {
          setDialogState(confirmState);
        } else {
          setQueue(prev => [...prev, confirmState]);
        }
      });
    },
    [showNext]
  );

  // Register alert context globally for utility functions (non-React code)
  useEffect(() => {
    setAlertContext({ showAlert, showConfirm, showDestructiveConfirm });
    return () => setAlertContext(null);
  }, [showAlert, showConfirm, showDestructiveConfirm]);

  return (
    <AlertContext.Provider value={{ showAlert, showConfirm, showDestructiveConfirm }}>
      {children}
      {dialogState && (
        <>
          {/* Backdrop */}
          <div
            className="animate-fade-in fixed inset-0 z-50 bg-black/50"
            onClick={() => {
              // Clicked backdrop
              if (dialogState.type === 'confirm') {
                dialogState.resolve(false);
              }
            }}
          />
          {/* Dialog Content */}
          <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
            <div
              className="animate-scale-in pointer-events-auto w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
              onClick={e => e.stopPropagation()}
            >
              <h2 className="mb-3 text-xl font-semibold text-gray-900">{dialogState.title}</h2>
              <p className="mb-6 whitespace-pre-wrap text-gray-700">{dialogState.message}</p>
              <div className="flex justify-end gap-3">
                {dialogState.type === 'alert' ? (
                  <button
                    className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700"
                    onClick={() => dialogState.resolve()}
                    autoFocus
                  >
                    OK
                  </button>
                ) : (
                  <>
                    <button
                      className="rounded-lg border border-gray-300 px-4 py-2 font-medium text-gray-700 transition-colors hover:bg-gray-50"
                      onClick={() => dialogState.resolve(false)}
                    >
                      Cancel
                    </button>
                    <button
                      className={`rounded-lg px-4 py-2 font-medium transition-colors ${
                        dialogState.isDestructive
                          ? 'bg-red-600 text-white hover:bg-red-700'
                          : 'bg-blue-600 text-white hover:bg-blue-700'
                      }`}
                      onClick={() => dialogState.resolve(true)}
                      autoFocus
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
