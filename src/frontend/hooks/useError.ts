import { useContext } from 'react';
import { ErrorContext, type ErrorContextValue } from '../contexts/ErrorContext';

export function useError(): ErrorContextValue {
  const context = useContext(ErrorContext);
  if (!context) {
    throw new Error('useError must be used within an ErrorProvider');
  }
  return context;
}
