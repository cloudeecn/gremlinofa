import { useState, useEffect, useCallback, useMemo } from 'react';
import * as vfsService from '../../services/vfs/vfsService';
import { getBasename, type VersionInfo } from '../../services/vfs/vfsService';
import { computeLcsDiff, splitLines, getDiffStats, type DiffLine } from '../../utils/lcsDiff';

export interface VfsDiffViewerProps {
  projectId: string;
  path: string;
  onRollback: () => void;
  onClose: () => void;
}

interface DiffState {
  loading: boolean;
  error: string | null;
  versions: VersionInfo[];
  fileId: string | null;
  currentVersion: number;
  minStoredVersion: number; // Minimum stored version (can't navigate below this)
  // Single viewing version - shows diff from (viewingVersion-1) to viewingVersion
  viewingVersion: number;
  // Content
  prevContent: string; // Content of viewingVersion-1 (empty string for v1 or minStoredVersion)
  currentContent: string; // Content of viewingVersion
}

export default function VfsDiffViewer({
  projectId,
  path,
  onRollback,
  onClose,
}: VfsDiffViewerProps) {
  const [state, setState] = useState<DiffState>({
    loading: true,
    error: null,
    versions: [],
    fileId: null,
    currentVersion: 1,
    minStoredVersion: 1,
    viewingVersion: 1,
    prevContent: '',
    currentContent: '',
  });
  const [rolling, setRolling] = useState(false);

  // Load content for a specific version (shows diff from prev to this version)
  const loadVersionContent = useCallback(
    async (fileId: string, version: number, minVersion: number) => {
      setState(prev => ({ ...prev, loading: true, error: null }));

      try {
        // Load current version content
        const currentContent = await vfsService.getVersion(projectId, fileId, version);
        if (currentContent === null) {
          throw new Error('Version content not found');
        }

        // Load previous version content (empty string for minStoredVersion or v1)
        let prevContent = '';
        if (version > minVersion) {
          const prev = await vfsService.getVersion(projectId, fileId, version - 1);
          if (prev === null) {
            throw new Error('Previous version content not found');
          }
          prevContent = prev;
        }

        setState(prev => ({
          ...prev,
          loading: false,
          viewingVersion: version,
          prevContent,
          currentContent,
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load version content';
        setState(prev => ({
          ...prev,
          loading: false,
          error: message,
        }));
      }
    },
    [projectId]
  );

  // Load versions list
  const loadVersions = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      const fileId = await vfsService.getFileId(projectId, path);
      if (!fileId) {
        throw new Error('File not found');
      }

      // Get file metadata including minStoredVersion
      const meta = await vfsService.getFileMeta(projectId, path);
      if (!meta) {
        throw new Error('File metadata not found');
      }

      const { version: currentVersion, minStoredVersion, storedVersionCount } = meta;
      if (storedVersionCount < 2) {
        throw new Error('No version history available');
      }

      // Build versions list for UI (only stored versions)
      const versions: VersionInfo[] = [];
      for (let v = minStoredVersion; v <= currentVersion; v++) {
        versions.push({ version: v, createdAt: 0 }); // Timestamps not needed for UI
      }

      setState(prev => ({
        ...prev,
        fileId,
        versions,
        currentVersion,
        minStoredVersion,
      }));

      // Start by showing the current version (latest changes)
      await loadVersionContent(fileId, currentVersion, minStoredVersion);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load versions';
      setState(prev => ({
        ...prev,
        loading: false,
        error: message,
      }));
    }
  }, [projectId, path, loadVersionContent]);

  // Navigation handlers
  const handlePrev = useCallback(() => {
    if (state.viewingVersion > state.minStoredVersion && state.fileId) {
      loadVersionContent(state.fileId, state.viewingVersion - 1, state.minStoredVersion);
    }
  }, [state.viewingVersion, state.minStoredVersion, state.fileId, loadVersionContent]);

  const handleNext = useCallback(() => {
    if (state.viewingVersion < state.currentVersion && state.fileId) {
      loadVersionContent(state.fileId, state.viewingVersion + 1, state.minStoredVersion);
    }
  }, [
    state.viewingVersion,
    state.currentVersion,
    state.minStoredVersion,
    state.fileId,
    loadVersionContent,
  ]);

  // Rollback handler - restores to the viewing version
  const handleRollback = useCallback(async () => {
    setRolling(true);
    try {
      // Rollback creates new version with viewing version's content
      await vfsService.updateFile(projectId, path, state.currentContent);
      onRollback();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to rollback';
      setState(prev => ({ ...prev, error: message }));
      setRolling(false);
    }
  }, [projectId, path, state.currentContent, onRollback]);

  // Load on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      loadVersions();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadVersions]);

  // Compute diff
  const diff = useMemo(() => {
    if (!state.prevContent && !state.currentContent) return [];
    return computeLcsDiff(splitLines(state.prevContent), splitLines(state.currentContent));
  }, [state.prevContent, state.currentContent]);

  const stats = useMemo(() => getDiffStats(diff), [diff]);

  const filename = getBasename(path);

  // Navigation state
  const canPrev = state.viewingVersion > state.minStoredVersion;
  const canNext = state.viewingVersion < state.currentVersion;
  const canRollback = state.viewingVersion < state.currentVersion;

  if (state.loading) {
    return (
      <div className="flex h-full flex-col">
        <Header filename={filename} onClose={onClose} />
        <div className="flex flex-1 items-center justify-center">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="flex h-full flex-col">
        <Header filename={filename} onClose={onClose} />
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4">
          <span className="text-red-500">⚠️</span>
          <p className="text-center text-sm text-gray-600">{state.error}</p>
          <button
            type="button"
            className="mt-2 text-sm text-blue-600 hover:underline"
            onClick={loadVersions}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Header filename={filename} onClose={onClose} />

      {/* Version selector - simplified single version navigation */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-gray-50 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">
            {state.viewingVersion === state.minStoredVersion
              ? state.minStoredVersion === 1
                ? 'Created:'
                : 'Oldest stored:'
              : 'Changes in:'}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-200 disabled:opacity-30"
              onClick={handlePrev}
              disabled={!canPrev}
              title="Previous version"
            >
              ◀
            </button>
            <span className="min-w-[3rem] text-center text-sm font-medium text-gray-700">
              v{state.viewingVersion}
            </span>
            <button
              type="button"
              className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-200 disabled:opacity-30"
              onClick={handleNext}
              disabled={!canNext}
              title="Next version"
            >
              ▶
            </button>
          </div>
          {state.viewingVersion === state.currentVersion && (
            <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">current</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-green-600">+{stats.added}</span>
          <span className="text-red-600">-{stats.removed}</span>
          <span className="text-gray-500">{stats.unchanged} unchanged</span>
        </div>
      </div>

      {/* Diff display */}
      <div className="flex-1 overflow-auto bg-white">
        <DiffDisplay diff={diff} />
      </div>

      {/* Action bar */}
      <div className="flex justify-between gap-3 border-t border-gray-200 bg-white px-4 py-3">
        <button
          type="button"
          className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-700 disabled:opacity-50"
          onClick={handleRollback}
          disabled={rolling || !canRollback}
          title={
            canRollback
              ? `Restore file to version ${state.viewingVersion}`
              : 'Already at current version'
          }
        >
          {rolling ? 'Rolling back...' : `Rollback to v${state.viewingVersion}`}
        </button>
        <button
          type="button"
          className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}

interface HeaderProps {
  filename: string;
  onClose: () => void;
}

function Header({ filename, onClose }: HeaderProps) {
  return (
    <div className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3">
      <div className="min-w-0 flex-1">
        <span className="truncate font-medium text-gray-900">{filename}</span>
        <span className="ml-2 text-sm text-gray-500">(version history)</span>
      </div>
      <button
        type="button"
        className="rounded p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
        onClick={onClose}
        title="Close"
      >
        ✕
      </button>
    </div>
  );
}

interface DiffDisplayProps {
  diff: DiffLine[];
}

function DiffDisplay({ diff }: DiffDisplayProps) {
  // Show "No differences" when empty or all lines are unchanged
  const hasChanges = diff.some(line => line.type !== 'same');
  if (diff.length === 0 || !hasChanges) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-sm text-gray-500">No differences</span>
      </div>
    );
  }

  return (
    <div className="font-mono text-sm">
      {diff.map((line, index) => (
        <DiffLineRow key={index} line={line} lineNumber={index + 1} />
      ))}
    </div>
  );
}

interface DiffLineRowProps {
  line: DiffLine;
  lineNumber: number;
}

function DiffLineRow({ line, lineNumber }: DiffLineRowProps) {
  const bgClass =
    line.type === 'add'
      ? 'bg-green-50'
      : line.type === 'remove'
        ? 'bg-red-50'
        : 'bg-white hover:bg-gray-50';

  const textClass =
    line.type === 'add'
      ? 'text-green-800'
      : line.type === 'remove'
        ? 'text-red-800'
        : 'text-gray-700';

  const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
  const prefixClass =
    line.type === 'add'
      ? 'text-green-600'
      : line.type === 'remove'
        ? 'text-red-600'
        : 'text-gray-400';

  return (
    <div className={`flex ${bgClass}`}>
      <span className="w-12 shrink-0 border-r border-gray-200 px-2 py-0.5 text-right text-xs text-gray-400 select-none">
        {lineNumber}
      </span>
      <span className={`w-5 shrink-0 py-0.5 text-center select-none ${prefixClass}`}>{prefix}</span>
      <span className={`flex-1 py-0.5 pr-4 break-words whitespace-pre-wrap ${textClass}`}>
        {line.content || '\u00A0'}
      </span>
    </div>
  );
}
