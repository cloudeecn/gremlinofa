import { useContext } from 'react';
import { AppContext } from '../contexts/createAppContext';

export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}
