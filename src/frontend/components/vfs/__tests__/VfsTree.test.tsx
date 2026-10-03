import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import VfsTree from '../VfsTree';
import { useVfsTree } from '../../../hooks/useVfsTree';
import type { EntryType } from '../../../hooks/useVfsTree';
import type { DirEntry, VfsAdapter } from '../../../../shared/protocol/types/vfs';

const entry = (name: string, type: 'file' | 'dir', size?: number): DirEntry => ({
  name,
  type,
  deleted: false,
  createdAt: 0,
  updatedAt: 0,
  size,
});

const LISTINGS: Record<string, DirEntry[]> = {
  '/': [entry('docs', 'dir'), entry('notes.md', 'file', 2048)],
  '/docs': [entry('guide.md', 'file', 10), entry('deep', 'dir')],
  '/docs/deep': [],
};

function makeAdapter(listings = LISTINGS) {
  return {
    readDir: vi.fn(async (path: string) => {
      if (!listings[path]) throw new Error(`Path not found: ${path}`);
      return listings[path];
    }),
  } as unknown as VfsAdapter;
}

function Harness({
  adapter,
  onSelect,
  selectDirs,
  initialSelected = null,
}: {
  adapter: VfsAdapter;
  onSelect?: (path: string, type: EntryType) => void;
  selectDirs?: boolean;
  initialSelected?: string | null;
}) {
  const tree = useVfsTree(adapter);
  const [selected, setSelected] = useState<string | null>(initialSelected);
  return (
    <VfsTree
      tree={tree}
      selectedPath={selected}
      selectDirs={selectDirs}
      onSelect={(path, type) => {
        setSelected(path);
        onSelect?.(path, type);
      }}
    />
  );
}

const row = (name: string) => screen.getByRole('treeitem', { name: new RegExp(name) });

async function renderTree(props: Partial<Parameters<typeof Harness>[0]> = {}) {
  const adapter = props.adapter ?? makeAdapter();
  render(<Harness adapter={adapter} {...props} />);
  await screen.findByRole('treeitem', { name: /notes\.md/ });
  return adapter;
}

describe('VfsTree', () => {
  it('renders an ARIA tree with levels, expansion state and file sizes', async () => {
    await renderTree();

    const tree = screen.getByRole('tree', { name: 'Memory files' });
    const root = within(tree).getAllByRole('treeitem')[0];
    expect(root).toHaveAttribute('aria-level', '1');
    expect(root).toHaveAttribute('aria-expanded', 'true');
    expect(row('docs')).toHaveAttribute('aria-level', '2');
    expect(row('docs')).toHaveAttribute('aria-expanded', 'false');
    expect(row('notes.md')).not.toHaveAttribute('aria-expanded');
    expect(row('notes.md')).toHaveTextContent('2 KB');
  });

  it('puts exactly one row in the tab order, the root before anything is selected', async () => {
    await renderTree();
    const tabbable = screen.getAllByRole('treeitem').filter(item => item.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveTextContent('/');
  });

  it('selects a file on click', async () => {
    const onSelect = vi.fn();
    await renderTree({ onSelect });
    fireEvent.click(row('notes.md'));
    expect(onSelect).toHaveBeenCalledWith('/notes.md', 'file');
    expect(row('notes.md')).toHaveAttribute('aria-selected', 'true');
  });

  it('selects and expands a folder; a second click on the selected folder collapses it', async () => {
    const onSelect = vi.fn();
    await renderTree({ onSelect });

    fireEvent.click(row('docs'));
    expect(onSelect).toHaveBeenCalledWith('/docs', 'dir');
    await screen.findByRole('treeitem', { name: /guide\.md/ });

    fireEvent.click(row('docs'));
    expect(row('docs')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('treeitem', { name: /guide\.md/ })).not.toBeInTheDocument();
  });

  it('selects an expanded folder without collapsing it', async () => {
    const onSelect = vi.fn();
    await renderTree({ onSelect, initialSelected: '/notes.md' });

    // Expand through the chevron, which doesn't select
    fireEvent.click(row('docs').firstElementChild!);
    await screen.findByRole('treeitem', { name: /guide\.md/ });
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(row('docs'));
    expect(onSelect).toHaveBeenCalledWith('/docs', 'dir');
    expect(row('docs')).toHaveAttribute('aria-expanded', 'true');
  });

  it('only toggles folders when folders are not selectable', async () => {
    const onSelect = vi.fn();
    await renderTree({ onSelect, selectDirs: false });

    fireEvent.click(row('docs'));
    await screen.findByRole('treeitem', { name: /guide\.md/ });
    fireEvent.click(row('docs'));
    expect(row('docs')).toHaveAttribute('aria-expanded', 'false');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows empty folders and failed listings with a retry', async () => {
    const adapter = makeAdapter({
      ...LISTINGS,
      '/docs': [entry('deep', 'dir'), entry('gone', 'dir')],
    });
    await renderTree({ adapter });
    fireEvent.click(row('docs'));
    fireEvent.click(await screen.findByRole('treeitem', { name: /deep/ }));
    expect(await screen.findByText('Empty')).toBeInTheDocument();

    fireEvent.click(row('gone'));
    expect(
      await screen.findByText(/Couldn’t load: Path not found: \/docs\/gone/)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(
        (adapter.readDir as ReturnType<typeof vi.fn>).mock.calls.filter(([p]) => p === '/docs/gone')
      ).toHaveLength(2)
    );
  });

  describe('keyboard', () => {
    it('moves focus with the arrow keys without selecting', async () => {
      const onSelect = vi.fn();
      await renderTree({ onSelect });
      const root = screen.getAllByRole('treeitem')[0];
      root.focus();

      fireEvent.keyDown(root, { key: 'ArrowDown' });
      expect(row('docs')).toHaveFocus();
      fireEvent.keyDown(row('docs'), { key: 'End' });
      expect(row('notes.md')).toHaveFocus();
      fireEvent.keyDown(row('notes.md'), { key: 'Home' });
      expect(root).toHaveFocus();
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('expands with ArrowRight, steps into children, and goes back up with ArrowLeft', async () => {
      await renderTree();
      row('docs').focus();

      fireEvent.keyDown(row('docs'), { key: 'ArrowRight' });
      await screen.findByRole('treeitem', { name: /guide\.md/ });
      fireEvent.keyDown(row('docs'), { key: 'ArrowRight' });
      // Folders sort first: "deep" comes before "guide.md"
      expect(row('deep')).toHaveFocus();

      fireEvent.keyDown(row('deep'), { key: 'ArrowLeft' });
      expect(row('docs')).toHaveFocus();
      fireEvent.keyDown(row('docs'), { key: 'ArrowLeft' });
      expect(row('docs')).toHaveAttribute('aria-expanded', 'false');
    });

    it('selects the focused row with Enter or Space', async () => {
      const onSelect = vi.fn();
      await renderTree({ onSelect });
      fireEvent.keyDown(row('notes.md'), { key: 'Enter' });
      expect(onSelect).toHaveBeenCalledWith('/notes.md', 'file');
      fireEvent.keyDown(row('docs'), { key: ' ' });
      expect(onSelect).toHaveBeenCalledWith('/docs', 'dir');
    });
  });
});
