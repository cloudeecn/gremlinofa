import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router-dom';
import { useEffect, useSyncExternalStore } from 'react';
import type { AppStatus } from '../contexts/createAppContext';

const harness = vi.hoisted(() => {
  const viewportListeners = new Set<() => void>();
  return {
    isMobile: false,
    viewportListeners,
    setMobile(isMobile: boolean) {
      this.isMobile = isMobile;
      for (const listener of viewportListeners) listener();
    },
    status: { isInitializing: false, initError: null } as AppStatus,
    startLoops: vi.fn(),
    sidebarMounts: 0,
    chatViewRenders: 0,
    // The banner renders straight from AppContent, so it counts shell renders
    shellRenders: 0,
    vfsMounts: 0,
    projectViewMounts: 0,
    projectSettingsMounts: 0,
    projectViewThrows: false,
    navigate: null as NavigateFunction | null,
  };
});

vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () =>
    useSyncExternalStore(
      listener => {
        harness.viewportListeners.add(listener);
        return () => harness.viewportListeners.delete(listener);
      },
      () => harness.isMobile
    ),
}));

vi.mock('../hooks/useApp', () => ({
  useAppStatus: () => harness.status,
  useApp: () => ({ storageQuota: null, refreshStorageQuota: async () => {} }),
}));

vi.mock('../client', () => ({
  activeLoopsStore: { start: harness.startLoops },
}));

vi.mock('../components/Sidebar', async () => {
  const { useEffect } = await import('react');
  return {
    default: function SidebarStub(props: { onClose?: () => void; onCollapse?: () => void }) {
      useEffect(() => {
        harness.sidebarMounts++;
      }, []);
      return (
        <div data-testid="sidebar">
          {props.onClose && <button onClick={props.onClose}>Close drawer</button>}
          {props.onCollapse && <button onClick={props.onCollapse}>Collapse</button>}
        </div>
      );
    },
  };
});

vi.mock('../components/chat/ChatView', () => ({
  default: function ChatViewStub({ onMenuPress }: { onMenuPress?: () => void }) {
    harness.chatViewRenders++;
    return <button onClick={onMenuPress}>Menu</button>;
  },
}));

vi.mock('../components/DataManagerPage', () => ({
  default: () => <div>Data manager page</div>,
}));
vi.mock('../components/SettingsPage', () => ({ default: () => null }));
vi.mock('../components/project/ProjectView', async () => {
  const { useEffect } = await import('react');
  return {
    default: function ProjectViewStub() {
      useEffect(() => {
        harness.projectViewMounts++;
      }, []);
      if (harness.projectViewThrows) throw new Error('project page exploded');
      return null;
    },
  };
});
vi.mock('../components/project/ProjectSettingsView', async () => {
  const { useEffect } = await import('react');
  return {
    default: function ProjectSettingsViewStub() {
      useEffect(() => {
        harness.projectSettingsMounts++;
      }, []);
      return null;
    },
  };
});
vi.mock('../components/project/VfsManagerView', async () => {
  const { useEffect } = await import('react');
  return {
    default: function VfsManagerViewStub(props: { projectId: string; initialPath?: string }) {
      useEffect(() => {
        harness.vfsMounts++;
      }, []);
      return (
        <div data-testid="vfs-view">
          {props.projectId}:{props.initialPath}
        </div>
      );
    },
  };
});
vi.mock('../components/AttachmentManagerView', () => ({ AttachmentManagerView: () => null }));
vi.mock('../components/ConnectionStatusBanner', () => ({
  ConnectionStatusBanner: () => {
    harness.shellRenders++;
    return null;
  },
}));

import { AppContent } from '../App';
import { setStorageConfig } from '../lib/localStorageBoot';

/** Rendered beside AppContent so a test can navigate without touching it. */
function NavigateProbe() {
  const navigate = useNavigate();
  useEffect(() => {
    harness.navigate = navigate;
  }, [navigate]);
  return null;
}

function renderShell(path = '/chat/chat_1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppContent />
      <NavigateProbe />
    </MemoryRouter>
  );
}

describe('AppContent', () => {
  beforeEach(() => {
    harness.isMobile = false;
    harness.viewportListeners.clear();
    harness.status = { isInitializing: false, initError: null };
    harness.sidebarMounts = 0;
    harness.chatViewRenders = 0;
    harness.shellRenders = 0;
    harness.vfsMounts = 0;
    harness.projectViewMounts = 0;
    harness.projectSettingsMounts = 0;
    harness.projectViewThrows = false;
    harness.navigate = null;
    harness.startLoops.mockClear();
  });

  it('mounts only the desktop Sidebar on a wide viewport', () => {
    renderShell();
    expect(screen.getAllByTestId('sidebar')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-drawer')).toBeNull();
  });

  it('mounts no Sidebar on a phone until the drawer opens', () => {
    harness.isMobile = true;
    renderShell();
    expect(screen.queryByTestId('sidebar')).toBeNull();
    expect(screen.getByTestId('mobile-drawer')).toHaveAttribute('inert');

    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getAllByTestId('sidebar')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Close drawer' })).toBeInTheDocument();
    expect(screen.getByTestId('mobile-drawer')).not.toHaveAttribute('inert');
  });

  it('starts the running-loops stream on a phone before the drawer ever opens', () => {
    harness.isMobile = true;
    renderShell();
    expect(screen.queryByTestId('sidebar')).toBeNull();
    // useChat seeds the soft-stop state from this store's snapshot
    expect(harness.startLoops).toHaveBeenCalled();
  });

  it('starts the running-loops stream only once the backend is up', () => {
    harness.status = { isInitializing: true, initError: null };
    const { rerender } = renderShell();
    expect(harness.startLoops).not.toHaveBeenCalled();

    harness.status = { isInitializing: false, initError: 'CEK_MISMATCH' };
    rerender(
      <MemoryRouter initialEntries={['/chat/chat_1']}>
        <AppContent />
      </MemoryRouter>
    );
    expect(harness.startLoops).not.toHaveBeenCalled();
  });

  it("unmounts the drawer's Sidebar once the slide-out transition ends", () => {
    harness.isMobile = true;
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));

    const drawer = screen.getByTestId('mobile-drawer');
    expect(drawer).toHaveAttribute('inert');
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();

    // A transition inside the Sidebar bubbles up but isn't the slide
    fireEvent.transitionEnd(screen.getByTestId('sidebar'));
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();

    fireEvent.transitionEnd(drawer);
    expect(screen.queryByTestId('sidebar')).toBeNull();

    // Reopening mounts a fresh one
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getAllByTestId('sidebar')).toHaveLength(1);
    expect(harness.sidebarMounts).toBe(2);
  });

  it("unmounts the drawer's Sidebar even if transitionend never fires", () => {
    vi.useFakeTimers();
    try {
      harness.isMobile = true;
      renderShell();
      fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
      fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
      act(() => vi.advanceTimersByTime(900));
      expect(screen.getByTestId('sidebar')).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(100));
      expect(screen.queryByTestId('sidebar')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the drawer mounted when reopened before the slide-out ends', () => {
    harness.isMobile = true;
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    fireEvent.transitionEnd(screen.getByTestId('mobile-drawer'));
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(harness.sidebarMounts).toBe(1);
  });

  it('closes the drawer when the viewport widens to desktop', () => {
    harness.isMobile = true;
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));

    act(() => harness.setMobile(false));
    expect(screen.getAllByTestId('sidebar')).toHaveLength(1);
    expect(screen.queryByTestId('mobile-drawer')).toBeNull();

    act(() => harness.setMobile(true));
    expect(screen.queryByTestId('sidebar')).toBeNull();
    expect(screen.getByTestId('mobile-drawer')).toHaveAttribute('inert');
  });

  it('does not re-render the page for drawer or collapse toggles', () => {
    harness.isMobile = true;
    renderShell();
    const renders = harness.chatViewRenders;

    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
    fireEvent.transitionEnd(screen.getByTestId('mobile-drawer'));
    act(() => harness.setMobile(false));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    fireEvent.click(screen.getByTitle('Expand sidebar'));

    expect(harness.chatViewRenders).toBe(renders);
  });

  it('does not re-render the shell on navigation', () => {
    renderShell('/chat/chat_1');
    const renders = harness.shellRenders;

    act(() => harness.navigate!('/chat/chat_2'));
    act(() => harness.navigate!('/settings'));

    expect(harness.shellRenders).toBe(renders);
  });

  it('remounts the VFS manager when the project changes on the same path', () => {
    renderShell('/project/p1/vfs/notes.txt');
    expect(screen.getByTestId('vfs-view')).toHaveTextContent('p1:/notes.txt');

    act(() => harness.navigate!('/project/p2/vfs/notes.txt'));
    expect(screen.getByTestId('vfs-view')).toHaveTextContent('p2:/notes.txt');
    // A kept instance would carry p1's selection or open editor over to p2
    expect(harness.vfsMounts).toBe(2);
  });

  it('remounts the project page and its settings when the project changes', () => {
    renderShell('/project/p1');
    act(() => harness.navigate!('/project/p2'));
    // A kept instance would carry p1's new-chat text and model override to p2
    expect(harness.projectViewMounts).toBe(2);

    act(() => harness.navigate!('/project/p1/settings'));
    act(() => harness.navigate!('/project/p2/settings'));
    expect(harness.projectSettingsMounts).toBe(2);
  });

  it('keeps the sidebar when a page throws, and recovers on navigation', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    harness.projectViewThrows = true;
    renderShell('/project/p1');

    expect(screen.getByRole('alert')).toHaveTextContent('project page exploded');
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();

    act(() => harness.navigate!('/chat/chat_1'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Menu' })).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("shows a Couldn't start screen when init fails", () => {
    harness.status = { isInitializing: false, initError: 'CEK_MISMATCH' };
    renderShell('/');
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't start");
    expect(screen.getByText('CEK_MISMATCH')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar')).toBeNull();
    // Worker-side Detach needs the backend that just failed to start
    expect(screen.queryByRole('button', { name: 'Open Data Manager' })).toBeNull();
  });

  it('offers Data Manager from the error screen in server mode', () => {
    setStorageConfig({ type: 'server', wsUrl: 'ws://localhost:1234' });
    harness.status = { isInitializing: false, initError: 'connect ECONNREFUSED' };
    renderShell('/');

    fireEvent.click(screen.getByRole('button', { name: 'Open Data Manager' }));
    expect(screen.getByText('Data manager page')).toBeInTheDocument();
  });
});
