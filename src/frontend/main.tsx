import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import App from './App.tsx';
import { startBootstrap } from './client/bootstrapClient';
import { CrashView } from './components/ErrorBoundary';

// Tool registration happens inside `GremlinServer.init()` against the
// per-server `ClientSideToolRegistry`. The frontend never reads from a
// module-level registry — it goes through `gremlinClient.listTools()`
// for the inventory and through the streaming RPCs for everything else.

// Start bringing up the backend, but mount right away: React replaces the
// index.html splash with a boot screen that shows which step is running
// and where it failed. Awaiting the bootstrap here left a blank page
// whenever the backend never answered. With no CEK, `App` routes to OOBE,
// which calls gremlinClient.init itself once the user picks a flow.
const boot = startBootstrap();

const app = import.meta.env.DEV ? (
  <StrictMode>
    <App boot={boot} />
  </StrictMode>
) : (
  <App boot={boot} />
);

let hasCrashed = false;
const root = createRoot(document.getElementById('root')!, {
  // ErrorProvider's boundary covers everything below App; an error above it
  // would otherwise unmount the whole tree and leave the page blank. Once
  // only, so a CrashView that throws can't loop.
  onUncaughtError: error => {
    console.error('[main] Uncaught render error:', error);
    if (hasCrashed) return;
    hasCrashed = true;
    root.render(
      <div className="flex h-dvh">
        <CrashView error={error instanceof Error ? error : new Error(String(error))} />
      </div>
    );
  },
});
root.render(app);
