import { createContext } from 'react';

export interface CapturedError {
  id: string;
  message: string;
  stack: string;
  /** Stack trace mapped to original source locations (production only) */
  mappedStack?: string;
  timestamp: number;
}

export interface ErrorContextValue {
  errors: CapturedError[];
  addError: (error: Error) => void;
  removeError: (id: string) => void;
  clearErrors: () => void;
}

export const ErrorContext = createContext<ErrorContextValue | null>(null);
