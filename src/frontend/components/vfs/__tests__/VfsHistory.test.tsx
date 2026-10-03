import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import VfsHistory from '../VfsHistory';
import type { VfsAdapter } from '../../../../shared/protocol/types/vfs';

const VERSIONS: Record<number, string> = {
  1: 'alpha',
  2: 'alpha\nbeta',
  3: 'alpha\nbeta\ngamma',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeAdapter(versions: Record<number, string> = VERSIONS) {
  return {
    getFileId: vi.fn().mockResolvedValue('file_1'),
    listVersions: vi.fn().mockResolvedValue(
      Object.keys(versions).map(v => ({
        version: Number(v),
        createdAt: 1_700_000_000_000 + Number(v),
      }))
    ),
    getVersion: vi.fn(
      async (_id: string, version: number): Promise<string | null> => versions[version] ?? null
    ),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
}

let adapter: ReturnType<typeof makeAdapter>;
const onRolledBack = vi.fn();

function renderHistory(props: Partial<Parameters<typeof VfsHistory>[0]> = {}) {
  return render(
    <VfsHistory
      adapter={adapter as unknown as VfsAdapter}
      path="/notes.md"
      currentVersion={3}
      minStoredVersion={1}
      onRolledBack={onRolledBack}
      {...props}
    />
  );
}

const versionSelect = () => screen.getByRole('combobox', { name: 'Version' });

beforeEach(() => {
  vi.clearAllMocks();
  adapter = makeAdapter();
});

describe('VfsHistory', () => {
  it('opens on the current version’s changes', async () => {
    renderHistory();
    expect(await screen.findByText('gamma')).toBeInTheDocument();
    expect(versionSelect()).toHaveValue('3');
    expect(screen.getByText('current')).toBeInTheDocument();
    expect(screen.getByText('Changes in')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next version' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Roll back to v3/ })).toBeDisabled();
  });

  it('lists every stored version with its date', async () => {
    renderHistory();
    await screen.findByText('gamma');
    const options = screen.getAllByRole('option').map(o => o.textContent);
    expect(options).toHaveLength(3);
    expect(options[0]).toMatch(/^v3 · /);
  });

  it('steps back, labelling the first version "Created"', async () => {
    renderHistory();
    await screen.findByText('gamma');

    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }));
    await waitFor(() => expect(versionSelect()).toHaveValue('2'));
    expect(await screen.findByText('Changes in')).toBeInTheDocument();
    expect(screen.queryByText('gamma')).not.toBeInTheDocument();

    fireEvent.change(versionSelect(), { target: { value: '1' } });
    expect(await screen.findByText('Created')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous version' })).toBeDisabled();
  });

  it('labels the oldest kept version when older ones were dropped', async () => {
    renderHistory({ minStoredVersion: 2 });
    await screen.findByText('gamma');
    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }));
    expect(await screen.findByText('Oldest stored')).toBeInTheDocument();
    // v2 is shown whole: there is no v1 to diff against
    expect(adapter.getVersion).not.toHaveBeenCalledWith('file_1', 1);
  });

  it('fetches each version once while stepping back and forth', async () => {
    renderHistory();
    await screen.findByText('gamma');

    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }));
    await waitFor(() => expect(versionSelect()).toHaveValue('2'));
    await screen.findByText('Changes in');
    fireEvent.click(screen.getByRole('button', { name: 'Next version' }));
    await screen.findByText('gamma');

    const fetched = adapter.getVersion.mock.calls.map(([, v]) => v).sort();
    expect(fetched).toEqual([1, 2, 3]);
  });

  it('shows only the latest step when an earlier one lands late', async () => {
    const slow = deferred<string | null>();
    adapter.getVersion.mockImplementation(async (_id: string, version: number) =>
      version === 1 ? slow.promise : VERSIONS[version]
    );
    renderHistory();
    await screen.findByText('gamma');

    // v2 needs v1, which hangs; then the user jumps back to v3 (cached)
    fireEvent.change(versionSelect(), { target: { value: '2' } });
    fireEvent.change(versionSelect(), { target: { value: '3' } });
    await act(async () => slow.resolve('alpha'));

    expect(versionSelect()).toHaveValue('3');
    expect(screen.getByText('gamma')).toBeInTheDocument();
  });

  it('rolls back by writing the shown version as a new one', async () => {
    renderHistory();
    await screen.findByText('gamma');
    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Roll back to v2/ })).toBeEnabled()
    );

    fireEvent.click(screen.getByRole('button', { name: /Roll back to v2/ }));
    await waitFor(() => expect(onRolledBack).toHaveBeenCalled());
    expect(adapter.writeFile).toHaveBeenCalledWith('/notes.md', 'alpha\nbeta');
  });

  it('reports a failed rollback inline', async () => {
    adapter.writeFile.mockRejectedValue(new Error('READONLY'));
    renderHistory();
    await screen.findByText('gamma');
    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Roll back to v2/ })).toBeEnabled()
    );

    fireEvent.click(screen.getByRole('button', { name: /Roll back to v2/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Rollback failed: READONLY');
    expect(onRolledBack).not.toHaveBeenCalled();
  });

  it('shows a load error with a working Retry', async () => {
    adapter.getFileId.mockResolvedValueOnce(null);
    renderHistory();
    expect(
      await screen.findByText(/Couldn’t load the history: File not found/)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('gamma')).toBeInTheDocument();
  });

  describe('context and line numbers', () => {
    // v2 → v3: insert INSERTED after line 4 and drop line 40, so old and new
    // numbering drift apart by one between the two edits and re-converge after.
    const shifted = () => {
      const base = Array.from({ length: 50 }, (_, i) => `line ${i}`);
      const edited = [...base];
      edited.splice(40, 1);
      edited.splice(5, 0, 'INSERTED');
      return { 1: 'x', 2: base.join('\n'), 3: edited.join('\n') };
    };

    const gutterOf = (text: string) => {
      const row = screen.getByText(text).parentElement!;
      return [row.children[0].textContent, row.children[1].textContent];
    };

    it('shows old and new line numbers for the whole file', async () => {
      adapter = makeAdapter(shifted());
      renderHistory();
      await screen.findByText('INSERTED');

      expect(gutterOf('line 0')).toEqual(['1', '1']);
      expect(gutterOf('INSERTED')).toEqual(['', '6']);
      expect(gutterOf('line 20')).toEqual(['21', '22']);
      expect(gutterOf('line 40')).toEqual(['41', '']);
      expect(gutterOf('line 49')).toEqual(['50', '50']);
    });

    it('keeps file line numbers inside ±10 hunks, separated by ··· rows', async () => {
      adapter = makeAdapter(shifted());
      renderHistory();
      await screen.findByText('INSERTED');

      const toggle = screen.getByRole('button', { name: '±10' });
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await waitFor(() => expect(screen.queryByText('line 20')).not.toBeInTheDocument());

      expect(screen.getAllByText('···').length).toBeGreaterThanOrEqual(1);
      expect(gutterOf('INSERTED')).toEqual(['', '6']);
      expect(gutterOf('line 10')).toEqual(['11', '12']);
      expect(gutterOf('line 35')).toEqual(['36', '37']);
      expect(gutterOf('line 40')).toEqual(['41', '']);
      expect(gutterOf('line 45')).toEqual(['46', '46']);
    });

    it('says so when two versions are identical', async () => {
      adapter = makeAdapter({ 1: 'same', 2: 'same', 3: 'same' });
      renderHistory();
      expect(await screen.findByText('No differences')).toBeInTheDocument();
    });
  });
});
