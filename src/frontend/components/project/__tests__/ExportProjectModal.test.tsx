import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../client', () => ({
  gremlinClient: { exportProjectBundle: vi.fn() },
}));
vi.mock('../../../lib/projectExport', () => ({ triggerProjectDownload: vi.fn() }));

import ExportProjectModal from '../ExportProjectModal';
import { gremlinClient } from '../../../client';
import { triggerProjectDownload } from '../../../lib/projectExport';

type ExportResult = Awaited<ReturnType<typeof gremlinClient.exportProjectBundle>>;

const bundle: ExportResult = { bundleJson: '{}', fileCount: 3, dirCount: 0, projectName: 'Proj' };

/**
 * exportProjectBundle that stays pending until the test settles it, and
 * honours its signal the way GremlinClient does: abort rejects with AbortError.
 */
function pendingExport() {
  const call = {
    signal: undefined as AbortSignal | undefined,
    onProgress: undefined as ((loaded: number, total: number) => void) | undefined,
    resolve: (_result: ExportResult) => {},
    reject: (_error: unknown) => {},
  };
  vi.mocked(gremlinClient.exportProjectBundle).mockImplementation(
    (_projectId, onProgress, signal) =>
      new Promise<ExportResult>((resolve, reject) => {
        call.signal = signal;
        call.onProgress = onProgress;
        call.resolve = resolve;
        call.reject = reject;
        signal?.addEventListener('abort', () =>
          reject(new DOMException('Project export aborted', 'AbortError'))
        );
      })
  );
  return call;
}

/** Parent that closes the modal on onClose, like ProjectView. */
function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <ExportProjectModal
      isOpen={open}
      onClose={() => {
        onClose();
        setOpen(false);
      }}
      projectId="p1"
      projectName="Proj"
    />
  );
}

async function startExport() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  });
  expect(screen.getByText('Exporting...')).toBeInTheDocument();
}

const backdrop = () => document.querySelector<HTMLElement>('.bg-black\\/50')!;

describe('ExportProjectModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('downloads the bundle and shows the summary when the export finishes', async () => {
    const call = pendingExport();
    render(<Harness onClose={vi.fn()} />);
    await startExport();

    await act(async () => {
      call.onProgress?.(3, 3);
      call.resolve(bundle);
    });

    expect(triggerProjectDownload).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Project Exported')).toBeInTheDocument();
  });

  it('Cancel stays enabled while running and aborts the export', async () => {
    const call = pendingExport();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await startExport();

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeEnabled();
    await act(async () => {
      fireEvent.click(cancel);
    });

    expect(call.signal?.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(triggerProjectDownload).not.toHaveBeenCalled();
  });

  it('Escape while running aborts and closes', async () => {
    const call = pendingExport();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await startExport();

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(call.signal?.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(triggerProjectDownload).not.toHaveBeenCalled();
  });

  it('the backdrop while running aborts and closes', async () => {
    const call = pendingExport();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await startExport();

    await act(async () => {
      fireEvent.click(backdrop());
    });

    expect(call.signal?.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(triggerProjectDownload).not.toHaveBeenCalled();
  });

  it('aborts when unmounted mid-export (leaving the project page)', async () => {
    const call = pendingExport();
    const { unmount } = render(<Harness onClose={vi.fn()} />);
    await startExport();

    unmount();
    await act(async () => {});

    expect(call.signal?.aborted).toBe(true);
    expect(triggerProjectDownload).not.toHaveBeenCalled();
  });

  it('shows an abort as neither an error nor a result when the parent keeps it open', async () => {
    pendingExport();
    render(<ExportProjectModal isOpen onClose={vi.fn()} projectId="p1" projectName="Proj" />);
    await startExport();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });

    expect(screen.queryByText('Export Failed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
    expect(triggerProjectDownload).not.toHaveBeenCalled();
  });

  it('shows a real failure as an error', async () => {
    const call = pendingExport();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    render(<Harness onClose={vi.fn()} />);
    await startExport();

    await act(async () => {
      call.reject(new Error('disk on fire'));
    });

    expect(screen.getByText('Export Failed')).toBeInTheDocument();
    expect(screen.getByText('disk on fire')).toBeInTheDocument();
    debug.mockRestore();
  });
});
