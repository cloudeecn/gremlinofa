import { useState, useEffect, useRef, useCallback, useId, useMemo } from 'react';
import type { ReactNode } from 'react';
import { AlertContext } from './AlertContext';
import type { AlertOptions, ConfirmOptions, PromptOptions } from './AlertContext';
import { setAlertContext } from '../lib/alerts';
import { useOverlay } from '../hooks/useOverlay';
import { useImeSafeEnter } from '../hooks/useImeSafeEnter';

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

interface PromptDialog extends PromptOptions {
  id: number;
  type: 'prompt';
  resolve: (value: string | null) => void;
}

type Dialog = AlertDialog | ConfirmDialog | PromptDialog;

const CANCEL_BUTTON_CLASS =
  'rounded-lg border border-gray-300 px-4 py-2 font-medium text-gray-700 transition-colors hover:bg-gray-50';
const PRIMARY_BUTTON_CLASS =
  'rounded-lg bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700';

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

  const showPrompt = useCallback(
    (options: PromptOptions): Promise<string | null> =>
      new Promise(resolve => {
        enqueue({ ...options, id: nextDialogId++, type: 'prompt', resolve });
      }),
    [enqueue]
  );

  /**
   * Settles a dialog and lets the next one in. A double click settles nothing
   * twice. `answer` is the prompt's text, or true/false for confirm/cancel.
   */
  const settle = useCallback((dialog: Dialog, answer: boolean | string) => {
    switch (dialog.type) {
      case 'alert':
        dialog.resolve();
        break;
      case 'confirm':
        dialog.resolve(answer === true);
        break;
      case 'prompt':
        dialog.resolve(typeof answer === 'string' ? answer : null);
        break;
    }
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
    () => ({ showAlert, showConfirm, showDestructiveConfirm, showPrompt }),
    [showAlert, showConfirm, showDestructiveConfirm, showPrompt]
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
              // An alert has no obvious answer for a backdrop click; the others cancel
              if (dialogState.type !== 'alert') settle(dialogState, false);
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
              aria-describedby={dialogState.message ? messageId : undefined}
              tabIndex={-1}
              className="animate-scale-in pointer-events-auto w-full max-w-md rounded-lg bg-white p-6 shadow-xl outline-none"
              onClick={e => e.stopPropagation()}
            >
              <h2 id={titleId} className="mb-3 text-xl font-semibold text-gray-900">
                {dialogState.title}
              </h2>
              {dialogState.message && (
                <p id={messageId} className="mb-6 break-words whitespace-pre-wrap text-gray-700">
                  {dialogState.message}
                </p>
              )}
              {dialogState.type === 'prompt' ? (
                <PromptForm
                  dialog={dialogState}
                  onSubmit={value => settle(dialogState, value)}
                  onCancel={() => settle(dialogState, false)}
                />
              ) : (
                <div className="flex justify-end gap-3">
                  {dialogState.type === 'alert' ? (
                    <button
                      className={PRIMARY_BUTTON_CLASS}
                      onClick={() => settle(dialogState, true)}
                      autoFocus
                    >
                      OK
                    </button>
                  ) : (
                    <>
                      {/* A destructive confirm starts on Cancel so Enter/Space can't delete */}
                      <button
                        className={CANCEL_BUTTON_CLASS}
                        onClick={() => settle(dialogState, false)}
                        autoFocus={dialogState.isDestructive}
                      >
                        Cancel
                      </button>
                      <button
                        className={
                          dialogState.isDestructive
                            ? 'rounded-lg bg-red-600 px-4 py-2 font-medium text-white transition-colors hover:bg-red-700'
                            : PRIMARY_BUTTON_CLASS
                        }
                        onClick={() => settle(dialogState, true)}
                        autoFocus={!dialogState.isDestructive}
                      >
                        {dialogState.confirmLabel || 'Confirm'}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </AlertContext.Provider>
  );
}

interface PromptFormProps {
  dialog: PromptDialog;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function PromptForm({ dialog, onSubmit, onCancel }: PromptFormProps) {
  const [value, setValue] = useState(dialog.defaultValue ?? '');
  // Shown only after a rejected submit, then kept in step with the typing
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();
  const { onCompositionEnd, isImeEnter } = useImeSafeEnter();

  // No autoFocus: on a phone, focusing the field pops the keyboard over the
  // dialog before the user asked for it. Keyboard devices get the caret
  // right away. This runs before useOverlay focuses the card, which then
  // leaves focus where it is.
  useEffect(() => {
    const input = inputRef.current;
    if (!input || window.matchMedia?.('(pointer: coarse)').matches) return;
    input.focus();
    input.select();
  }, []);

  const check = (text: string) =>
    dialog.validate ? dialog.validate(text) : text ? null : 'Enter a value.';

  const submit = () => {
    const trimmed = value.trim();
    const problem = check(trimmed);
    if (problem) {
      setError(problem);
      return;
    }
    onSubmit(trimmed);
  };

  return (
    <>
      <label htmlFor={inputId} className="sr-only">
        {dialog.label}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        value={value}
        placeholder={dialog.placeholder}
        aria-invalid={error !== null}
        aria-describedby={error ? errorId : undefined}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={e => {
          setValue(e.target.value);
          if (error) setError(check(e.target.value.trim()));
        }}
        onCompositionEnd={onCompositionEnd}
        onKeyDown={e => {
          if (e.key !== 'Enter' || isImeEnter(e)) return;
          e.preventDefault();
          submit();
        }}
        className="w-full rounded-lg border border-gray-300 px-4 py-2 text-base focus:ring-2 focus:ring-blue-500 focus:outline-none aria-[invalid=true]:border-red-400"
      />
      <p id={errorId} role="alert" className="mt-1 min-h-5 text-sm text-red-600">
        {error}
      </p>
      <div className="mt-4 flex justify-end gap-3">
        <button className={CANCEL_BUTTON_CLASS} onClick={onCancel}>
          Cancel
        </button>
        <button className={PRIMARY_BUTTON_CLASS} onClick={submit}>
          {dialog.confirmLabel || 'OK'}
        </button>
      </div>
    </>
  );
}
