import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { registerAllTools } from './services/tools';

// Register all client-side tools at startup
registerAllTools();

const app = import.meta.env.DEV ? (
  <StrictMode>
    <App />
  </StrictMode>
) : (
  <App />
);

createRoot(document.getElementById('root')!).render(app);
