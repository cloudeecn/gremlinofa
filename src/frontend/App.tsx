import { useState, useEffect, useRef, useCallback, useMemo, useContext } from 'react';
import {
  HashRouter,
  Outlet,
  Routes,
  Route,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { AppProvider } from './contexts/AppContext';
import { AlertProvider } from './contexts/AlertProvider';
import { ErrorProvider } from './contexts/ErrorProvider';
import { ErrorContext } from './contexts/ErrorContext';
import { CrashView, ErrorBoundary } from './components/ErrorBoundary';
import { ErrorFloatingButton } from './components/ErrorFloatingButton';
import Sidebar from './components/Sidebar';
import SettingsPage from './components/SettingsPage';
import DataManagerPage from './components/DataManagerPage';
import { useApp, useAppStatus } from './hooks/useApp';
import { useIsMobile } from './hooks/useIsMobile';
import { useOverlay } from './hooks/useOverlay';
import ProjectView from './components/project/ProjectView';
import ProjectSettingsView from './components/project/ProjectSettingsView';
import VfsManagerView from './components/project/VfsManagerView';
import ChatView from './components/chat/ChatView';
import { AttachmentManagerView } from './components/AttachmentManagerView';
import { ConnectionStatusBanner } from './components/ConnectionStatusBanner';
import { activeLoopsStore } from './client';
import { OOBEScreen } from './components/OOBEScreen';
import { OOBEComplete } from './components/OOBEComplete';
import { getCachedCEKString, getStorageConfig } from './lib/localStorageBoot';
import { formatStorageDisplay, shouldShowStorageWarning } from './lib/formatBytes';

// OOBE result type
interface OOBEResult {
  mode: 'fresh' | 'import' | 'existing';
  cek: string;
  storageType: 'indexeddb' | 'remote' | 'server';
  importStats?: {
    imported: number;
    skipped: number;
    errors: string[];
  };
}

// OOBE state: checking, needs-oobe, complete, or launched
type OOBEState = 'needs-oobe' | 'complete' | 'launched';

/** Drawer slide is `duration-300`; transitionend normally unmounts well before. */
const DRAWER_UNMOUNT_BACKSTOP_MS = 1000;

export function AppContent() {
  const isMobile = useIsMobile();
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  // The drawer's Sidebar mounts on open and stays until the slide-out ends
  const [isDrawerSidebarMounted, setIsDrawerSidebarMounted] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [wasMobile, setWasMobile] = useState(isMobile);
  const [isInitErrorDismissed, setIsInitErrorDismissed] = useState(false);

  // No useNavigate here: under a non-data router it subscribes to the
  // location, and every navigation would re-render the shell.
  const { isInitializing, initError } = useAppStatus();

  // The running-loops stream can't wait for a Sidebar: on a phone the drawer's
  // Sidebar mounts only while open, and useChat reads the store's snapshot
  // without subscribing to seed the soft-stop state on re-attach.
  const isBackendReady = !isInitializing && !initError;
  useEffect(() => {
    if (isBackendReady) activeLoopsStore.start();
  }, [isBackendReady]);

  // Crossing to desktop closes the drawer, so it doesn't pop back open when
  // the viewport shrinks again (tablet rotation).
  if (wasMobile !== isMobile) {
    setWasMobile(isMobile);
    if (!isMobile) {
      setIsMobileSidebarOpen(false);
      setIsDrawerSidebarMounted(false);
    }
  }

  const openMobileSidebar = useCallback(() => {
    setIsMobileSidebarOpen(true);
    setIsDrawerSidebarMounted(true);
  }, []);
  const closeMobileSidebar = useCallback(() => setIsMobileSidebarOpen(false), []);

  const mobileDrawerRef = useRef<HTMLDivElement>(null);
  useOverlay({
    active: isMobile && isMobileSidebarOpen,
    onEscape: closeMobileSidebar,
    containerRef: mobileDrawerRef,
    trapFocus: true,
    restoreFocus: true,
  });

  // Backstop for a slide-out whose transitionend never arrives (tab hidden
  // mid-slide, transition cancelled): the slide is long over by then.
  useEffect(() => {
    if (isMobileSidebarOpen || !isDrawerSidebarMounted) return;
    const timer = setTimeout(() => setIsDrawerSidebarMounted(false), DRAWER_UNMOUNT_BACKSTOP_MS);
    return () => clearTimeout(timer);
  }, [isMobileSidebarOpen, isDrawerSidebarMounted]);

  // Same element across drawer and collapse toggles, so they don't re-render
  // the page (ChatView included). Navigation still updates through the router.
  const routes = useMemo(
    () => (
      <Routes>
        <Route element={<RouteBoundary onMenuPress={openMobileSidebar} />}>
          <Route path="/" element={<WelcomeScreen onMenuPress={openMobileSidebar} />} />
          <Route
            path="/project/:projectId"
            element={<ProjectViewRoute onMenuPress={openMobileSidebar} />}
          />
          <Route
            path="/project/:projectId/settings"
            element={<ProjectSettingsViewRoute onMenuPress={openMobileSidebar} />}
          />
          <Route path="/project/:projectId/vfs/*" element={<VfsManagerViewRoute />} />
          <Route path="/chat/:chatId" element={<ChatViewRoute onMenuPress={openMobileSidebar} />} />
          <Route
            path="/attachments"
            element={<AttachmentManagerView onMenuPress={openMobileSidebar} />}
          />
          <Route path="/settings" element={<SettingsPage onMenuPress={openMobileSidebar} />} />
          <Route path="/data" element={<DataManagerPage onMenuPress={openMobileSidebar} />} />
        </Route>
      </Routes>
    ),
    [openMobileSidebar]
  );

  // Show loading screen while initializing storage
  if (isInitializing) {
    return (
      <div className="flex h-dvh items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="mb-4 text-4xl">⏳</div>
          <h2 className="mb-2 text-xl font-semibold text-gray-800">
            Initializing Gremlin Of The Friday Afternoon
          </h2>
          <p className="text-gray-600">Setting up storage...</p>
        </div>
      </div>
    );
  }

  if (initError && !isInitErrorDismissed) {
    return <InitErrorScreen message={initError} onDismiss={() => setIsInitErrorDismissed(true)} />;
  }

  return (
    <div className="safe-area-inset-x flex h-dvh overflow-hidden">
      {/* Desktop Sidebar */}
      {!isMobile && (
        <div
          className={`hidden overflow-hidden transition-[width] duration-300 ease-in-out md:flex md:flex-shrink-0 ${
            isSidebarCollapsed ? 'md:w-12' : 'md:w-80'
          }`}
        >
          {isSidebarCollapsed ? (
            <div className="flex h-full w-12 flex-col items-center bg-gray-900 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
              <button
                onClick={() => setIsSidebarCollapsed(false)}
                className="flex h-8 w-8 items-center justify-center rounded text-gray-400 transition-colors hover:bg-gray-700 hover:text-white"
                title="Expand sidebar"
              >
                <span className="text-xs font-bold">&gt;|</span>
              </button>
            </div>
          ) : (
            <Sidebar onCollapse={() => setIsSidebarCollapsed(true)} />
          )}
        </div>
      )}

      {isMobile && (
        <>
          {/* Backdrop — unmounted when closed so it cannot capture pointer
            events at stale layout-viewport coordinates after the iOS
            on-screen keyboard hides. */}
          {isMobileSidebarOpen && (
            <div
              className="animate-fade-in fixed inset-0 z-40 bg-black/50 md:hidden"
              onClick={closeMobileSidebar}
            />
          )}
          {/* The panel stays mounted for the slide transition; its Sidebar
            unmounts once the slide-out ends. inert covers the closing slide. */}
          <div
            ref={mobileDrawerRef}
            data-testid="mobile-drawer"
            tabIndex={-1}
            inert={!isMobileSidebarOpen}
            onTransitionEnd={e => {
              if (e.target === e.currentTarget && !isMobileSidebarOpen) {
                setIsDrawerSidebarMounted(false);
              }
            }}
            className={`fixed inset-y-0 left-0 z-50 w-80 transition-transform duration-300 ease-out outline-none md:hidden ${
              isMobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'
            }`}
          >
            {isDrawerSidebarMounted && <Sidebar onClose={closeMobileSidebar} />}
          </div>
        </>
      )}

      {/* Main Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <ConnectionStatusBanner />
        {routes}
      </div>
    </div>
  );
}

function InitErrorScreen({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="flex h-dvh items-center justify-center bg-gray-50 p-4">
      <div role="alert" className="max-w-md text-center">
        <div className="mb-4 text-4xl">🙀</div>
        <h2 className="mb-2 text-xl font-semibold text-gray-800">Couldn't start</h2>
        <p className="mb-6 break-words text-gray-600">{message}</p>
        <div className="flex flex-col items-center gap-3">
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-gray-900 px-6 py-3 text-white transition-colors hover:bg-gray-800"
          >
            Reload
          </button>
          {/* Escape hatch: server mode's Disconnect Backend only clears this
            device, so it works without a backend. Worker-side Detach calls
            clearCek, which waits on the init gate forever, so no button there. */}
          {getStorageConfig().type === 'server' && (
            <button
              onClick={() => {
                onDismiss();
                navigate('/data');
              }}
              className="text-sm text-gray-600 underline hover:text-gray-800"
            >
              Open Data Manager
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Welcome screen component
function WelcomeScreen({ onMenuPress }: { onMenuPress?: () => void }) {
  const { storageQuota, refreshStorageQuota } = useApp();

  useEffect(() => {
    refreshStorageQuota();
  }, [refreshStorageQuota]);

  // Calculate storage display info (irrelevant in server mode — already using remote storage)
  const isServerMode = getStorageConfig().type === 'server';
  const storageInfo =
    !isServerMode && storageQuota
      ? formatStorageDisplay(storageQuota.usage, storageQuota.quota)
      : null;
  const showWarning =
    !isServerMode && storageQuota
      ? shouldShowStorageWarning(storageQuota.usage, storageQuota.quota)
      : false;

  return (
    <div className="flex flex-1 items-center justify-center bg-white">
      <div className="p-10 text-center">
        <h1 className="mb-3 text-3xl font-semibold text-gray-800">
          Welcome to Gremlin Of The Friday Afternoon
        </h1>
        <p className="hidden text-lg text-gray-600 md:block">
          Create or select a project to get started
        </p>

        {/* Storage quota display */}
        {storageInfo && (
          <div className="mt-4">
            <p className={`text-sm ${storageInfo.colorClass}`}>💾 Storage: {storageInfo.text}</p>
          </div>
        )}

        {/* Storage warning */}
        {showWarning && (
          <div className="mx-auto mt-4 max-w-md rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-left">
            <p className="text-sm text-yellow-800">
              <span className="mr-1">⚠️</span>
              If you are seriously using this, please consider migrating to{' '}
              <a
                className="text-blue-600"
                href="https://github.com/cloudeecn/gremlinofa/blob/main/storage-backend/README.md"
                rel="noopener noreferrer"
                target="_blank"
              >
                self hosted remote storage
              </a>{' '}
              for data persistance
            </p>
          </div>
        )}

        {onMenuPress && (
          <p>
            <button
              onClick={onMenuPress}
              className="mt-6 rounded-lg bg-gray-900 px-6 py-3 text-white transition-colors hover:bg-gray-800 md:hidden"
            >
              Get started
            </button>
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * One error boundary around whichever page is showing, so a page that throws
 * leaves the sidebar usable. Reads the location itself (AppContent must not
 * subscribe to it) and resets on navigation. `useContext`, not `useError`:
 * the shell also renders without an ErrorProvider in tests.
 */
function RouteBoundary({ onMenuPress }: { onMenuPress: () => void }) {
  const { pathname } = useLocation();
  const addError = useContext(ErrorContext)?.addError;
  return (
    <ErrorBoundary
      resetKey={pathname}
      onError={addError}
      fallback={(error, reset) => (
        <CrashView error={error} onRetry={reset} onMenuPress={onMenuPress} />
      )}
    >
      <Outlet />
    </ErrorBoundary>
  );
}

// Route wrapper components that extract params
function ProjectViewRoute({ onMenuPress }: { onMenuPress?: () => void }) {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return null;
  // Keyed like ChatViewRoute: project A's new-chat text, attachments and
  // model override must not carry over to B
  return <ProjectView key={projectId} projectId={projectId} onMenuPress={onMenuPress} />;
}

function ProjectSettingsViewRoute({ onMenuPress }: { onMenuPress?: () => void }) {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return null;
  // Keyed so the form re-seeds from the new project instead of keeping A's edits
  return <ProjectSettingsView key={projectId} projectId={projectId} onMenuPress={onMenuPress} />;
}

function VfsManagerViewRoute() {
  const { projectId, '*': splatPath } = useParams<{ projectId: string; '*': string }>();
  if (!projectId) return null;
  // Convert splat path to VFS path (add leading slash if present)
  const initialPath = splatPath ? `/${splatPath}` : undefined;
  // Keyed by project too: switching projects on the same path must not carry
  // the old project's selection or open editor over to the new adapter.
  return (
    <VfsManagerView
      key={`${projectId}:${initialPath ?? ''}`}
      projectId={projectId}
      initialPath={initialPath}
    />
  );
}

function ChatViewRoute({ onMenuPress }: { onMenuPress?: () => void }) {
  const { chatId } = useParams<{ chatId: string }>();
  if (!chatId) return null;
  // key={chatId} forces remount when switching chats, preventing stale state issues.
  // No `initialPending` flag — the project view starts the loop on the backend
  // before navigating, and the chat view's `attachChat` subscription picks up
  // the live event stream (which delivers `loop_started` to set the phase).
  return <ChatView key={chatId} chatId={chatId} onMenuPress={onMenuPress} />;
}

function App() {
  // Decide OOBE-vs-launched up front by reading the cached CEK out of
  // localStorage. The main thread doesn't hold an encryption instance —
  // the worker owns the per-server encryption built from the cek posted
  // via `gremlinClient.init({ cek })`. The storage config flows separately
  // through `gremlinClient.configureWorker(...)` (Phase 1.5). The OOBE
  // screen is responsible for both calls; here we only need to know
  // whether to show OOBE or skip straight to the app, and that decision
  // never changes mid-mount.
  const [oobeState, setOobeState] = useState<OOBEState>(() =>
    getCachedCEKString() !== null ? 'launched' : 'needs-oobe'
  );
  const [oobeResult, setOobeResult] = useState<OOBEResult | null>(null);

  // Handle OOBE completion
  const handleOOBEComplete = (result: OOBEResult) => {
    console.debug('[App] OOBE complete:', result.mode);
    setOobeResult(result);
    setOobeState('complete');
  };

  let screen;
  if (oobeState === 'needs-oobe') {
    // No CEK yet
    screen = <OOBEScreen onComplete={handleOOBEComplete} />;
  } else if (oobeState === 'complete' && oobeResult) {
    screen = (
      <OOBEComplete
        mode={oobeResult.mode}
        cek={oobeResult.cek}
        storageType={oobeResult.storageType}
        importStats={oobeResult.importStats}
      />
    );
  } else {
    // Normal app - CEK exists, initialize and run
    screen = (
      <AppProvider>
        <HashRouter>
          <AppContent />
        </HashRouter>
      </AppProvider>
    );
  }

  // Neither provider needs the backend or the router, so setup gets the
  // error boundary and in-page dialogs too
  return (
    <ErrorProvider>
      <AlertProvider>{screen}</AlertProvider>
      <ErrorFloatingButton />
    </ErrorProvider>
  );
}

export default App;
