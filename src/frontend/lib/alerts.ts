/**
 * Web implementation of alert/confirm/prompt dialogs
 * Uses in-page custom dialogs via AlertContext
 *
 * Note: These functions should be used via useAlert() hook in React components.
 * This module provides fallback to native browser dialogs when context is not available.
 */
import type { AlertContextType, PromptOptions } from '../contexts/AlertContext';

let alertContext: AlertContextType | null = null;

/**
 * Set the alert context (called by AlertProvider)
 */
export function setAlertContext(context: AlertContextType | null) {
  alertContext = context;
}

/**
 * Show a simple alert dialog
 */
export function showAlert(title: string, message: string): Promise<void> {
  if (alertContext) {
    return alertContext.showAlert(title, message);
  }
  // Fallback to native alert
  window.alert(`${title}\n\n${message}`);
  return Promise.resolve();
}

/**
 * Show a confirmation dialog
 * @returns Promise<boolean> - true if user confirmed, false if cancelled
 */
export async function showConfirm(
  title: string,
  message: string,
  confirmLabel?: string
): Promise<boolean> {
  if (alertContext) {
    return alertContext.showConfirm(title, message, confirmLabel);
  }
  // Fallback to native confirm
  const result = window.confirm(`${title}\n\n${message}`);
  return Promise.resolve(result);
}

/**
 * Show a destructive confirmation dialog
 * @returns Promise<boolean> - true if user confirmed, false if cancelled
 */
export async function showDestructiveConfirm(
  title: string,
  message: string,
  confirmLabel?: string
): Promise<boolean> {
  if (alertContext) {
    return alertContext.showDestructiveConfirm(title, message, confirmLabel);
  }
  // Fallback to native confirm
  const result = window.confirm(`${title}\n\n${message}`);
  return Promise.resolve(result);
}

/**
 * Ask for one line of text.
 * @returns the trimmed value, or null when cancelled. The native fallback
 * can't show a validation error, so a value `validate` rejects is null too.
 */
export async function showPrompt(options: PromptOptions): Promise<string | null> {
  if (alertContext) {
    return alertContext.showPrompt(options);
  }
  const text = options.message ? `${options.title}\n\n${options.message}` : options.title;
  const value = window.prompt(text, options.defaultValue)?.trim();
  if (value === undefined) return null;
  const problem = options.validate ? options.validate(value) : value ? null : 'empty';
  return problem ? null : value;
}
