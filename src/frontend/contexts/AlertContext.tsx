import { createContext } from 'react';

export interface AlertOptions {
  title: string;
  message: string;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  isDestructive?: boolean;
}

export interface PromptOptions {
  title: string;
  message?: string;
  /** Accessible label of the text field */
  label: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /**
   * Gets the trimmed value; returns an error to show under the field, or null
   * to accept. Without it, an empty value is refused.
   */
  validate?: (value: string) => string | null;
}

export interface AlertContextType {
  showAlert: (title: string, message: string) => Promise<void>;
  showConfirm: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
  showDestructiveConfirm: (
    title: string,
    message: string,
    confirmLabel?: string
  ) => Promise<boolean>;
  /** Resolves the trimmed value, or null when cancelled */
  showPrompt: (options: PromptOptions) => Promise<string | null>;
}

export const AlertContext = createContext<AlertContextType | undefined>(undefined);
