import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import PromptFileList from '../PromptFileList';
import type { VfsAdapter } from '../../../../../shared/protocol/types/vfs';

/** `exists()` calls that stay pending until the test settles them, per path. */
function deferredAdapter() {
  const pending: Record<string, ((found: boolean) => void)[]> = {};
  const adapter = {
    exists: vi.fn(
      (path: string) =>
        new Promise<boolean>(resolve => {
          (pending[path] ??= []).push(resolve);
        })
    ),
  } as unknown as VfsAdapter;
  return { adapter, pending };
}

describe('PromptFileList existence badges', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the latest batch when an older one resolves after it', async () => {
    const { adapter, pending } = deferredAdapter();
    const onChange = vi.fn();
    const { rerender } = render(
      <PromptFileList paths={['/a.md']} adapter={adapter} onChange={onChange} />
    );

    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(adapter.exists).toHaveBeenCalledTimes(1);

    rerender(<PromptFileList paths={['/a.md', '/b.md']} adapter={adapter} onChange={onChange} />);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(adapter.exists).toHaveBeenCalledTimes(3);

    await act(async () => {
      pending['/a.md'][1](true);
      pending['/b.md'][0](true);
    });
    expect(screen.getAllByTitle('File exists')).toHaveLength(2);

    // The first batch (paths = ['/a.md']) finishes last and must be dropped
    await act(async () => {
      pending['/a.md'][0](false);
    });
    expect(screen.getAllByTitle('File exists')).toHaveLength(2);
    expect(screen.queryByTitle(/Not found/)).not.toBeInTheDocument();
  });

  it('debounces: no lookup until the paths stop changing', async () => {
    const { adapter } = deferredAdapter();
    const { rerender } = render(
      <PromptFileList paths={['/a']} adapter={adapter} onChange={vi.fn()} />
    );

    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    rerender(<PromptFileList paths={['/ab']} adapter={adapter} onChange={vi.fn()} />);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(adapter.exists).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(adapter.exists).toHaveBeenCalledTimes(1);
    expect(adapter.exists).toHaveBeenCalledWith('/ab');
  });
});
