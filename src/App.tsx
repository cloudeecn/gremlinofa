import { useState, useEffect } from 'react';
import { HashRouter, Routes, Route, useParams } from 'react-router-dom';
import { AppProvider } from './contexts/AppContext';
import { AlertProvider } from './contexts/AlertProvider';
import { ErrorProvider } from './contexts/ErrorProvider';
import { ErrorFloatingButton } from './components/ErrorFloatingButton';
import Sidebar from './components/Sidebar';
import SettingsPage from './components/SettingsPage';
import DataManagerPage from './components/DataManagerPage';
import { useApp } from './hooks/useApp';
import ProjectView from './components/project/ProjectView';
import ProjectSettingsView from './components/project/ProjectSettingsView';
import VfsManagerView from './components/project/VfsManagerView';
import ChatView from './components/chat/ChatView';
import { AttachmentManagerView } from './components/AttachmentManagerView';
import { OOBEScreen } from './components/OOBEScreen';
import { OOBEComplete } from './components/OOBEComplete';
import { encryptionService } from './services/encryption/encryptionService';

// OOBE result type
interface OOBEResult {
  mode: 'fresh' | 'import' | 'existing';
  cek: string;
  storageType: 'indexeddb' | 'remote';
  importStats?: {
    imported: number;
    skipped: number;
    errors: string[];
  };
}

// OOBE state: checking, needs-oobe, complete, or launched
type OOBEState = 'checking' | 'needs-oobe' | 'complete' | 'launched';

function AppContent() {
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  const { isInitializing } = useApp();

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

  return (
    <div className="safe-area-inset-x flex h-dvh overflow-hidden">
      {/* Desktop Sidebar */}
      <div className="hidden md:flex md:w-80 md:flex-shrink-0">
        <Sidebar />
      </div>

      {/* Mobile Sidebar Overlay */}
      <div
        className={`fixed inset-0 z-40 bg-black transition-opacity duration-300 md:hidden ${
          isMobileSidebarOpen ? 'opacity-50' : 'pointer-events-none opacity-0'
        }`}
        onClick={() => setIsMobileSidebarOpen(false)}
      />
      {/* Sidebar */}
      <div
        className={`fixed inset-y-0 left-0 z-50 w-80 transition-transform duration-300 ease-out md:hidden ${
          isMobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar onClose={() => setIsMobileSidebarOpen(false)} />
      </div>

      {/* Main Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <Routes>
          <Route
            path="/"
            element={<WelcomeScreen onMenuPress={() => setIsMobileSidebarOpen(true)} />}
          />
          <Route
            path="/project/:projectId"
            element={<ProjectViewRoute onMenuPress={() => setIsMobileSidebarOpen(true)} />}
          />
          <Route
            path="/project/:projectId/settings"
            element={<ProjectSettingsViewRoute onMenuPress={() => setIsMobileSidebarOpen(true)} />}
          />
          <Route
            path="/project/:projectId/vfs/*"
            element={<VfsManagerViewRoute onMenuPress={() => setIsMobileSidebarOpen(true)} />}
          />
          <Route
            path="/chat/:chatId"
            element={<ChatViewRoute onMenuPress={() => setIsMobileSidebarOpen(true)} />}
          />
          <Route
            path="/attachments"
            element={<AttachmentManagerView onMenuPress={() => setIsMobileSidebarOpen(true)} />}
          />
          <Route
            path="/settings"
            element={<SettingsPage onMenuPress={() => setIsMobileSidebarOpen(true)} />}
          />
          <Route
            path="/data"
            element={<DataManagerPage onMenuPress={() => setIsMobileSidebarOpen(true)} />}
          />
        </Routes>
      </div>
    </div>
  );
}

// Welcome screen component
function WelcomeScreen({ onMenuPress }: { onMenuPress?: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center bg-white">
      <div className="p-10 text-center">
        <h1 className="mb-3 text-3xl font-semibold text-gray-800">
          Welcome to Gremlin Of The Friday Afternoon
        </h1>
        <p className="hidden text-lg text-gray-600 md:block">
          Create or select a project to get started
        </p>
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

// Route wrapper components that extract params
function ProjectViewRoute({ onMenuPress }: { onMenuPress?: () => void }) {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return null;
  return <ProjectView projectId={projectId} onMenuPress={onMenuPress} />;
}

function ProjectSettingsViewRoute({ onMenuPress }: { onMenuPress?: () => void }) {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return null;
  return <ProjectSettingsView projectId={projectId} onMenuPress={onMenuPress} />;
}

function VfsManagerViewRoute({ onMenuPress }: { onMenuPress?: () => void }) {
  const { projectId, '*': splatPath } = useParams<{ projectId: string; '*': string }>();
  if (!projectId) return null;
  // Convert splat path to VFS path (add leading slash if present)
  const initialPath = splatPath ? `/${splatPath}` : undefined;
  return (
    <VfsManagerView
      key={initialPath || 'root'}
      projectId={projectId}
      initialPath={initialPath}
      onMenuPress={onMenuPress}
    />
  );
}

function ChatViewRoute({ onMenuPress }: { onMenuPress?: () => void }) {
  const { chatId } = useParams<{ chatId: string }>();
  if (!chatId) return null;
  // key={chatId} forces remount when switching chats, preventing stale state issues
  return <ChatView key={chatId} chatId={chatId} onMenuPress={onMenuPress} />;
}

function App() {
  const [oobeState, setOobeState] = useState<OOBEState>('checking');
  const [oobeResult, setOobeResult] = useState<OOBEResult | null>(null);

  // Check if OOBE is needed (no CEK exists)
  useEffect(() => {
    const checkOOBE = () => {
      const hasCEK = encryptionService.hasCEK();
      console.debug('[App] OOBE check: hasCEK =', hasCEK);
      setOobeState(hasCEK ? 'launched' : 'needs-oobe');
    };

    checkOOBE();
  }, []);

  // Handle OOBE completion
  const handleOOBEComplete = (result: OOBEResult) => {
    console.debug('[App] OOBE complete:', result.mode);
    setOobeResult(result);
    setOobeState('complete');
  };

  // Show loading while checking OOBE status
  if (oobeState === 'checking') {
    return (
      <div className="flex h-dvh items-center justify-center bg-gray-50">
        <div className="text-center">
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  // Show OOBE screen if needed (no CEK)
  if (oobeState === 'needs-oobe') {
    return <OOBEScreen onComplete={handleOOBEComplete} />;
  }

  // Show OOBE complete screen after setup
  if (oobeState === 'complete' && oobeResult) {
    return (
      <OOBEComplete
        mode={oobeResult.mode}
        cek={oobeResult.cek}
        storageType={oobeResult.storageType}
        importStats={oobeResult.importStats}
      />
    );
  }

  // Normal app - CEK exists, initialize and run
  return (
    <ErrorProvider>
      <AppProvider>
        <AlertProvider>
          <HashRouter>
            <AppContent />
          </HashRouter>
        </AlertProvider>
      </AppProvider>
      <ErrorFloatingButton />
    </ErrorProvider>
  );
}

export default App;
