import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import Spinner from '../ui/Spinner';
import { formatBytes } from '../../lib/formatBytes';
import { VFS_ROOT, dirname } from '../../lib/vfsPath';
import { flattenVisibleRows } from '../../hooks/useVfsTree';
import type { EntryType, TreeRow, VfsTreeState } from '../../hooks/useVfsTree';

export interface VfsTreeProps {
  tree: VfsTreeState;
  selectedPath: string | null;
  onSelect: (path: string, type: EntryType) => void;
  /** False for pickers that only accept files: a folder row then just toggles. */
  selectDirs?: boolean;
  label?: string;
}

type EntryRow = Extract<TreeRow, { kind: 'entry' }>;

const INDENT_PX = 16;
const indent = (level: number) => ({ paddingLeft: (level - 1) * INDENT_PX + 8 });
/** Status rows line up with the names of their siblings, past the chevron slot. */
const statusIndent = (level: number) => ({ paddingLeft: (level - 1) * INDENT_PX + 34 });

/**
 * WAI-ARIA tree over `useVfsTree` state. One row is in the tab order; the
 * arrow keys move focus between rows, Enter/Space selects. Focus moving
 * doesn't select: selecting rewrites the URL, which shouldn't happen on
 * every keypress.
 */
export default function VfsTree({
  tree,
  selectedPath,
  onSelect,
  selectDirs = true,
  label = 'Memory files',
}: VfsTreeProps) {
  const rows = useMemo(
    () => flattenVisibleRows(tree.dirs, tree.expanded),
    [tree.dirs, tree.expanded]
  );
  const entryRows = useMemo(
    () => rows.filter((row): row is EntryRow => row.kind === 'entry'),
    [rows]
  );

  const [focusPath, setFocusPath] = useState<string | null>(null);
  const rowElements = useRef(new Map<string, HTMLDivElement>());

  const tabStop =
    [focusPath, selectedPath].find(path => path && entryRows.some(row => row.path === path)) ??
    VFS_ROOT;

  // Scroll the selection into view once its row exists, e.g. a deep link
  // whose folders are still loading, or a file created in a collapsed folder.
  // Only once per selection, so expanding other folders doesn't yank the view.
  const scrolledForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedPath || scrolledForRef.current === selectedPath) return;
    const element = rowElements.current.get(selectedPath);
    if (!element) return;
    scrolledForRef.current = selectedPath;
    element.scrollIntoView?.({ block: 'nearest' });
  }, [selectedPath, rows]);

  const activate = (row: EntryRow) => {
    if (row.type === 'file') {
      onSelect(row.path, 'file');
    } else if (!selectDirs || row.path === selectedPath) {
      tree.toggle(row.path);
    } else {
      onSelect(row.path, 'dir');
      if (!row.expanded) tree.expand(row.path);
    }
  };

  const moveFocus = (path: string | undefined) => {
    if (!path) return;
    setFocusPath(path);
    rowElements.current.get(path)?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: EntryRow) => {
    const index = entryRows.indexOf(row);
    switch (event.key) {
      case 'ArrowDown':
        moveFocus(entryRows[index + 1]?.path);
        break;
      case 'ArrowUp':
        moveFocus(entryRows[index - 1]?.path);
        break;
      case 'Home':
        moveFocus(entryRows[0]?.path);
        break;
      case 'End':
        moveFocus(entryRows[entryRows.length - 1]?.path);
        break;
      case 'ArrowRight': {
        if (row.type !== 'dir') break;
        const next = entryRows[index + 1];
        if (!row.expanded) tree.expand(row.path);
        else if (next && next.level > row.level) moveFocus(next.path);
        break;
      }
      case 'ArrowLeft':
        if (row.type === 'dir' && row.expanded) tree.collapse(row.path);
        else if (row.path !== VFS_ROOT) moveFocus(dirname(row.path));
        break;
      case 'Enter':
      case ' ':
        activate(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div role="tree" aria-label={label} className="px-1 py-1 text-sm">
      {rows.map(row => {
        if (row.kind === 'empty') {
          return (
            <div
              key={row.key}
              role="none"
              className="py-1 text-xs text-gray-400 italic"
              style={statusIndent(row.level)}
            >
              Empty
            </div>
          );
        }
        if (row.kind === 'error') {
          return (
            <div
              key={row.key}
              role="none"
              className="flex items-center gap-2 py-1 text-xs text-red-600"
              style={statusIndent(row.level)}
            >
              <span className="min-w-0 truncate" title={row.message}>
                Couldn’t load: {row.message}
              </span>
              <button
                type="button"
                className="shrink-0 text-blue-600 hover:underline"
                onClick={() => tree.refresh(row.dir)}
              >
                Retry
              </button>
            </div>
          );
        }

        const isSelected = row.path === selectedPath;
        return (
          <div
            key={row.path}
            ref={element => {
              if (element) rowElements.current.set(row.path, element);
              else rowElements.current.delete(row.path);
            }}
            role="treeitem"
            aria-level={row.level}
            aria-expanded={row.type === 'dir' ? row.expanded : undefined}
            aria-selected={isSelected}
            tabIndex={row.path === tabStop ? 0 : -1}
            onClick={() => activate(row)}
            onFocus={() => setFocusPath(row.path)}
            onKeyDown={event => handleKeyDown(event, row)}
            className={`flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md pr-2 outline-none select-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
              isSelected ? 'bg-blue-50 text-blue-800' : 'text-gray-800 hover:bg-gray-100'
            }`}
            style={indent(row.level)}
          >
            <span
              aria-hidden="true"
              className="flex h-5 w-5 shrink-0 items-center justify-center text-gray-400"
              onClick={
                row.type === 'dir'
                  ? event => {
                      event.stopPropagation();
                      tree.toggle(row.path);
                    }
                  : undefined
              }
            >
              {row.type === 'dir' &&
                (row.loading ? <Spinner size={12} /> : <Chevron open={row.expanded} />)}
            </span>
            <span aria-hidden="true" className="shrink-0">
              {row.type === 'file' ? '📄' : row.expanded ? '📂' : '📁'}
            </span>
            <span
              className={`min-w-0 flex-1 truncate ${row.path === VFS_ROOT ? 'font-medium' : ''}`}
            >
              {row.name}
            </span>
            {row.type === 'file' && row.size !== undefined && (
              <span className="shrink-0 text-xs text-gray-400">{formatBytes(row.size)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`}
      fill="currentColor"
      viewBox="0 0 20 20"
    >
      <path
        fillRule="evenodd"
        d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}
