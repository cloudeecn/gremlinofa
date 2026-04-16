/**
 * Web implementation of alert/confirm dialogs
 * Uses in-page custom dialogs via AlertContext
 *
 * Note: These functions should be used via useAlert() hook in React components.
 * This module provides fallback to native browser dialogs when context is not available.
 */

let alertContext: {
  showAlert: (title: string, message: string) => Promise<void>;
  showConfirm: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
  showDestructiveConfirm: (
    title: string,
    message: string,
    confirmLabel?: string
  ) => Promise<boolean>;
} | null = null;

/**
 * Set the alert context (called by AlertProvider)
 */
export function setAlertContext(context: typeof alertContext) {
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
export async function showConfirm(title: string, message: string): Promise<boolean> {
  if (alertContext) {
    return alertContext.showConfirm(title, message);
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
