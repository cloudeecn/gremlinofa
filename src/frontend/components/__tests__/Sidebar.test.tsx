import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Sidebar from '../Sidebar';

const mockSaveProject = vi.hoisted(() => vi.fn());

vi.mock('../../hooks/useApp', () => ({
  useProjects: () => [],
  useAppActions: () => ({ saveProject: mockSaveProject }),
}));
vi.mock('../../hooks/useAlert', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }));
vi.mock('../activeLoops/RunningLoopsSection', () => ({ default: () => null }));

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>
  );
}

describe('Sidebar', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('probes /dev/ once per page load, across remounts', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const first = renderSidebar();
    expect(await screen.findByText('🔧 Dev Mode')).toBeInTheDocument();
    first.unmount();

    // Collapse/expand or a drawer reopen remounts the Sidebar
    renderSidebar();
    expect(screen.getByText('🔧 Dev Mode')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/dev/', { method: 'HEAD' });
  });

  it('creates one project when Enter is pressed again while the first save runs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }))
    );
    let finishSave: () => void = () => {};
    mockSaveProject.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishSave = resolve;
        })
    );
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: '+ New Project' }));
    const nameField = screen.getByPlaceholderText('Project name');
    fireEvent.change(nameField, { target: { value: 'Garden' } });
    await act(async () => fireEvent.keyDown(nameField, { key: 'Enter' }));
    await act(async () => fireEvent.keyDown(nameField, { key: 'Enter' }));
    expect(mockSaveProject).toHaveBeenCalledTimes(1);

    await act(async () => finishSave());
  });

  it('opens with a notch spacer, so the header clears the iOS status bar', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }))
    );
    const { container } = renderSidebar();
    const root = container.firstElementChild!;
    expect(root.firstElementChild).toHaveClass('safe-area-inset-top');
    expect(root.firstElementChild).toBeEmptyDOMElement();
  });
});
