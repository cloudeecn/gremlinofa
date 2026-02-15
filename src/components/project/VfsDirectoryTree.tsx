import { useState, useEffect, useCallback, useRef } from 'react';
import * as vfsService from '../../services/vfs/vfsService';
import type { DirEntry } from '../../services/vfs/vfsService';

// TODO: Add toggle to show deleted files/directories/orphan nodes

export interface VfsDirectoryTreeProps {
  projectId: string;
  selectedPath: string | null;
  initialPath?: string; // Auto-expand directories to reveal this path
  refreshToken?: number; // Change to reload expanded directories without remounting
  onSelectFile: (path: string) => void;
  onSelectDir: (path: string) => void;
}

interface TreeNodeState {
  expanded: boolean;
  children: DirEntry[] | null; // null = not loaded yet
  loading: boolean;
}

export default function VfsDirectoryTree({
  projectId,
  selectedPath,
  initialPath,
  refreshToken,
  onSelectFile,
  onSelectDir,
}: VfsDirectoryTreeProps) {
  // Track expanded state and children for each directory path
  const [nodeStates, setNodeStates] = useState<Record<string, TreeNodeState>>({
    '/': { expanded: true, children: null, loading: false },
  });

  // Track if we've processed the initial path (use ref to avoid effect re-triggers)
  const initialPathProcessedRef = useRef(false);

  const loadDirectory = useCallback(
    async (path: string) => {
      setNodeStates(prev => ({
        ...prev,
        [path]: { ...prev[path], loading: true },
      }));

      try {
        const entries = await vfsService.readDir(projectId, path);
        setNodeStates(prev => ({
          ...prev,
          [path]: { expanded: true, children: entries, loading: false },
        }));
      } catch (error) {
        console.debug('[VfsDirectoryTree] Failed to load directory:', path, error);
        setNodeStates(prev => ({
          ...prev,
          [path]: { ...prev[path], children: [], loading: false },
        }));
      }
    },
    [projectId]
  );

  const toggleExpand = useCallback(
    (path: string) => {
      const state = nodeStates[path];

      if (!state || state.children === null) {
        // First expansion - load children
        loadDirectory(path);
      } else {
        // Toggle expanded state
        setNodeStates(prev => ({
          ...prev,
          [path]: { ...prev[path], expanded: !prev[path].expanded },
        }));
      }
    },
    [nodeStates, loadDirectory]
  );

  // Load root directory on mount (deferred to avoid synchronous setState in effect)
  useEffect(() => {
    const timer = setTimeout(() => {
      loadDirectory('/');
    }, 0);
    return () => clearTimeout(timer);
  }, [loadDirectory]);

  // Expand all parent directories when initialPath is set (after root loads)
  useEffect(() => {
    if (!initialPath || initialPathProcessedRef.current) return;

    // Wait for root to be loaded first
    const rootState = nodeStates['/'];
    if (!rootState?.children) return;

    // Get all parent directory paths that need to be expanded
    const segments = vfsService.getPathSegments(initialPath);
    if (segments.length === 0) {
      initialPathProcessedRef.current = true;
      return;
    }

    // Mark as processed immediately to prevent re-runs
    initialPathProcessedRef.current = true;

    const expandParents = async () => {
      // Build list of parent directories to expand (excluding the target if it's a file)
      const pathsToExpand: string[] = [];
      let currentPath = '';

      for (let i = 0; i < segments.length; i++) {
        currentPath = currentPath + '/' + segments[i];

        // Check if this is a directory
        const isDir = await vfsService.isDirectory(projectId, currentPath);
        if (isDir) {
          pathsToExpand.push(currentPath);
        }
      }

      // Load each directory in sequence
      for (const dirPath of pathsToExpand) {
        await loadDirectory(dirPath);
      }
    };

    expandParents();
  }, [initialPath, nodeStates, projectId, loadDirectory]);

  // Reload all expanded directories when refreshToken changes (preserves expanded state)
  const refreshTokenRef = useRef(refreshToken);
  const nodeStatesRef = useRef(nodeStates);
  useEffect(() => {
    nodeStatesRef.current = nodeStates;
  });
  useEffect(() => {
    if (refreshToken === undefined || refreshToken === refreshTokenRef.current) return;
    refreshTokenRef.current = refreshToken;

    // Collect paths that are currently expanded and loaded
    const expandedPaths = Object.entries(nodeStatesRef.current)
      .filter(([, state]) => state.expanded && state.children !== null)
      .map(([path]) => path);

    if (expandedPaths.length === 0) return;

    // Reload all expanded directories in parallel (deferred like initial load)
    const timer = setTimeout(() => {
      for (const path of expandedPaths) {
        loadDirectory(path);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [refreshToken, loadDirectory]);

  const handleItemClick = useCallback(
    (entry: DirEntry, parentPath: string) => {
      const fullPath = parentPath === '/' ? `/${entry.name}` : `${parentPath}/${entry.name}`;

      if (entry.type === 'dir') {
        onSelectDir(fullPath);
        toggleExpand(fullPath);
      } else {
        onSelectFile(fullPath);
      }
    },
    [onSelectDir, onSelectFile, toggleExpand]
  );

  const renderEntry = (entry: DirEntry, parentPath: string, depth: number) => {
    const fullPath = parentPath === '/' ? `/${entry.name}` : `${parentPath}/${entry.name}`;
    const state = nodeStates[fullPath];
    const isExpanded = state?.expanded ?? false;
    const isLoading = state?.loading ?? false;
    const isSelected = selectedPath === fullPath;

    return (
      <div key={fullPath}>
        <button
          type="button"
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
            isSelected ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100'
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => handleItemClick(entry, parentPath)}
        >
          {/* Expand/collapse chevron for directories */}
          {entry.type === 'dir' ? (
            <span className="flex h-4 w-4 items-center justify-center text-gray-400">
              {isLoading ? (
                <span className="h-3 w-3 animate-spin rounded-full border border-gray-400 border-t-transparent" />
              ) : (
                <svg
                  className={`h-3 w-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </span>
          ) : (
            <span className="h-4 w-4" /> // Spacer for files
          )}

          {/* Icon */}
          <span>{entry.type === 'dir' ? '📁' : '📄'}</span>

          {/* Name */}
          <span className="flex-1 truncate">{entry.name}</span>

          {/* File size */}
          {entry.type === 'file' && entry.size !== undefined && (
            <span className="text-xs text-gray-400">{formatSize(entry.size)}</span>
          )}
        </button>

        {/* Render children if expanded */}
        {entry.type === 'dir' && isExpanded && state?.children && (
          <div>
            {state.children.length === 0 ? (
              <div
                className="py-1 text-xs text-gray-400 italic"
                style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
              >
                (empty)
              </div>
            ) : (
              state.children.map(child => renderEntry(child, fullPath, depth + 1))
            )}
          </div>
        )}
      </div>
    );
  };

  const rootState = nodeStates['/'];
  const rootChildren = rootState?.children;
  const isRootLoading = rootState?.loading ?? false;

  return (
    <div className="h-full overflow-y-auto">
      {/* Root header */}
      <div className="sticky top-0 bg-white px-3 py-2">
        <div className="text-xs font-medium tracking-wide text-gray-500 uppercase">
          Memory Files
        </div>
      </div>

      {/* Tree content */}
      <div className="px-1 pb-4">
        {isRootLoading ? (
          <div className="flex items-center justify-center py-8">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
          </div>
        ) : rootChildren === null || rootChildren.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-400">No files yet</div>
        ) : (
          rootChildren.map(entry => renderEntry(entry, '/', 0))
        )}
      </div>
    </div>
  );
}

/**
 * Format file size in human-readable format
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
