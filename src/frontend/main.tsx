import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import App from './App.tsx';
import { bootstrap } from './client/bootstrapClient';

// Tool registration happens inside `GremlinServer.init()` against the
// per-server `ClientSideToolRegistry`. The frontend never reads from a
// module-level registry — it goes through `gremlinClient.listTools()`
// for the inventory and through the streaming RPCs for everything else.

// Bring up the worker via gremlinClient.init before mounting React. The
// bootstrap call reads CEK + storage config from localStorage on the main
// thread and posts them through the protocol's `init` method. If either is
// missing, we still mount React — `App` routes to OOBE which calls
// gremlinClient.init itself once the user picks a flow.
//
// On a hard error (corrupted CEK, mismatched remote storage), we mount
// anyway so the user can reach Data Manager → Detach. AppContext surfaces
// the error to the rest of the app via its existing error UI.
async function main() {
  try {
    const result = await bootstrap();
    if (result.error) {
      console.error('[main] bootstrap failed:', result.error);
    } else if (result.needsOOBE) {
      console.debug('[main] bootstrap returned needsOOBE — App will route to OOBE');
    } else {
      console.debug('[main] bootstrap complete');
    }
  } catch (err) {
    console.error('[main] bootstrap threw unexpectedly:', err);
  }

  const app = import.meta.env.DEV ? (
    <StrictMode>
      <App />
    </StrictMode>
  ) : (
    <App />
  );

  createRoot(document.getElementById('root')!).render(app);
}

void main();
