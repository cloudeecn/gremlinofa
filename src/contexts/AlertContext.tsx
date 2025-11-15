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

interface AlertContextType {
  showAlert: (title: string, message: string) => Promise<void>;
  showConfirm: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
  showDestructiveConfirm: (
    title: string,
    message: string,
    confirmLabel?: string
  ) => Promise<boolean>;
}

export const AlertContext = createContext<AlertContextType | undefined>(undefined);
