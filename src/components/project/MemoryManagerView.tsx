import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  loadMemory,
  clearMemory,
  saveMemory,
  loadJournal,
  clearJournal,
  getJournalVersion,
  createEmptyFileSystem,
  saveJournalEntry,
} from '../../services/memory/memoryStorage';
import type {
  MemoryFileSystem,
  MemoryFile,
  JournalEntryWithMeta,
} from '../../services/memory/memoryStorage';
import { MemoryToolInstance } from '../../services/tools/memoryTool';
import { useAlert } from '../../hooks/useAlert';
import Modal from '../ui/Modal';

interface MemoryManagerViewProps {
  onMenuPress?: () => void;
}

/** Replay journal entries to reconstruct filesystem at a given version */
function replayJournal(
  entries: JournalEntryWithMeta[],
  upToVersion: number
): { fs: MemoryFileSystem; errors: string[] } {
  const instance = new MemoryToolInstance('replay', createEmptyFileSystem());
  const errors: string[] = [];

  const entriesToApply = entries.slice(0, upToVersion);
  for (let i = 0; i < entriesToApply.length; i++) {
    const { entry } = entriesToApply[i];
    const command = entry.command as string;

    // Skip view commands (shouldn't be in journal, but just in case)
    if (command === 'view') continue;

    let result;
    switch (command) {
      case 'create':
        result = instance.handleCreate(entry.path as string, entry.file_text as string);
        break;
      case 'str_replace':
        result = instance.handleStrReplace(
          entry.path as string,
          entry.old_str as string,
          entry.new_str as string
        );
        break;
      case 'insert':
        result = instance.handleInsert(
          entry.path as string,
          entry.insert_line as number,
          entry.insert_text as string
        );
        break;
      case 'delete':
        result = instance.handleDelete(entry.path as string);
        // Treat deleting non-existing file as success during replay
        // (file might have been deleted earlier or never created)
        if (result.isError && result.content.includes('does not exist')) {
          result = { content: result.content, isError: false };
        }
        break;
      case 'rename':
        result = instance.handleRename(entry.old_path as string, entry.new_path as string);
        break;
      case 'user_edit':
      case 'user_rollback': {
        // Full file replacement: delete if exists, then create
        const deletePath = entry.path as string;
        instance.handleDelete(deletePath); // Ignore errors (file may not exist)
        result = instance.handleCreate(deletePath, entry.file_text as string);
        break;
      }
      default:
        errors.push(`Unknown command at entry ${i + 1}: ${command}`);
        continue;
    }

    if (result.isError) {
      errors.push(`Entry ${i + 1} (${command}): ${result.content}`);
    }
  }

  return { fs: instance.getFileSystem(), errors };
}

/** Compare two filesystems and return differences */
function compareFileSystems(
  a: MemoryFileSystem,
  b: MemoryFileSystem
): { added: string[]; removed: string[]; modified: string[] } {
  const aFiles = new Set(Object.keys(a.files));
  const bFiles = new Set(Object.keys(b.files));

  const added = [...bFiles].filter(f => !aFiles.has(f));
  const removed = [...aFiles].filter(f => !bFiles.has(f));
  const modified = [...aFiles].filter(
    f => bFiles.has(f) && a.files[f].content !== b.files[f].content
  );

  return { added, removed, modified };
}

/** Generate inline diff between two strings */
function generateInlineDiff(oldContent: string, newContent: string): string[] {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const diff: string[] = [];

  // Simple LCS-based diff
  const lcs = computeLCS(oldLines, newLines);
  let oldIdx = 0;
  let newIdx = 0;
  let lcsIdx = 0;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    if (lcsIdx < lcs.length && oldIdx < oldLines.length && oldLines[oldIdx] === lcs[lcsIdx]) {
      if (newIdx < newLines.length && newLines[newIdx] === lcs[lcsIdx]) {
        diff.push(`  ${oldLines[oldIdx]}`);
        oldIdx++;
        newIdx++;
        lcsIdx++;
      } else if (newIdx < newLines.length) {
        diff.push(`+ ${newLines[newIdx]}`);
        newIdx++;
      } else {
        diff.push(`- ${oldLines[oldIdx]}`);
        oldIdx++;
      }
    } else if (
      oldIdx < oldLines.length &&
      (lcsIdx >= lcs.length || oldLines[oldIdx] !== lcs[lcsIdx])
    ) {
      diff.push(`- ${oldLines[oldIdx]}`);
      oldIdx++;
    } else if (newIdx < newLines.length) {
      diff.push(`+ ${newLines[newIdx]}`);
      newIdx++;
    }
  }

  return diff;
}

/** Compute longest common subsequence */
function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find LCS
  const lcs: string[] = [];
  let i = m,
    j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lcs.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return lcs;
}

export default function MemoryManagerView({ onMenuPress }: MemoryManagerViewProps) {
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const { showDestructiveConfirm, showAlert } = useAlert();

  const [fileSystem, setFileSystem] = useState<MemoryFileSystem | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [journalVersion, setJournalVersion] = useState(0);
  const [journal, setJournal] = useState<JournalEntryWithMeta[]>([]);

  // Diff view state
  const [isDiffMode, setIsDiffMode] = useState(false);
  const [diffVersion, setDiffVersion] = useState(0); // Version being compared (N-1)
  const [diffContent, setDiffContent] = useState<string[] | null>(null);
  const [replayErrors, setReplayErrors] = useState<string[]>([]);

  // Edit modal state
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editContent, setEditContent] = useState('');

  // Load memory and journal on mount
  useEffect(() => {
    if (!projectId) return;

    let mounted = true;

    Promise.all([loadMemory(projectId), loadJournal(projectId), getJournalVersion(projectId)]).then(
      ([fs, journalEntries, version]) => {
        if (mounted) {
          setFileSystem(fs);
          setJournal(journalEntries);
          setJournalVersion(version);
          setIsLoading(false);
        }
      }
    );

    return () => {
      mounted = false;
    };
  }, [projectId]);

  // Update diff when version changes - compares version N to version N+1
  const updateDiff = useCallback(
    (fromVersion: number) => {
      if (!selectedFile || journal.length === 0) return;

      const allErrors: string[] = [];

      // Get "from" state (version N)
      let oldContent = '';
      if (fromVersion > 0) {
        const { fs: fromFs, errors } = replayJournal(journal, fromVersion);
        oldContent = fromFs.files[selectedFile]?.content ?? '';
        allErrors.push(...errors);
      }

      // Get "to" state (version N+1)
      const toVersion = fromVersion + 1;
      const { fs: toFs, errors: toErrors } = replayJournal(journal, toVersion);
      const newContent = toFs.files[selectedFile]?.content ?? '';
      allErrors.push(...toErrors);

      const diff = generateInlineDiff(oldContent, newContent);
      setDiffContent(diff);
      setReplayErrors(allErrors);
    },
    [selectedFile, journal]
  );

  const handleBack = () => {
    navigate(`/project/${projectId}/settings`);
  };

  const handleClearAll = async () => {
    if (!projectId) return;

    const confirmed = await showDestructiveConfirm(
      'Clear All Memory',
      "Delete all memory files and version history? This clears Claude's memory completely—files and all recorded changes will be permanently lost.",
      'Clear All'
    );

    if (confirmed) {
      await clearMemory(projectId);
      await clearJournal(projectId);
      setFileSystem({ files: {} });
      setJournal([]);
      setJournalVersion(0);
      setSelectedFile(null);
      setIsDiffMode(false);
    }
  };

  const handleDeleteFile = async (path: string) => {
    if (!fileSystem || !projectId) return;

    const confirmed = await showDestructiveConfirm(
      'Delete File',
      `Delete "${path}"? This cannot be undone.`,
      'Delete'
    );

    if (confirmed) {
      const newFiles = { ...fileSystem.files };
      delete newFiles[path];
      const newFs: MemoryFileSystem = { files: newFiles };
      await saveMemory(projectId, newFs);

      // Record deletion in journal (same format as memory tool delete command)
      await saveJournalEntry(projectId, {
        command: 'delete',
        path: `/memories/${path}`,
      });

      // Refresh journal state
      const [newJournal, newVersion] = await Promise.all([
        loadJournal(projectId),
        getJournalVersion(projectId),
      ]);

      setFileSystem(newFs);
      setJournal(newJournal);
      setJournalVersion(newVersion);

      if (selectedFile === path) {
        setSelectedFile(null);
        setIsDiffMode(false);
      }
    }
  };

  const handleReplay = async () => {
    if (!projectId || journal.length === 0) return;

    const { fs: replayedFs, errors } = replayJournal(journal, journal.length);
    const diff = compareFileSystems(replayedFs, fileSystem!);

    const hasChanges = diff.added.length > 0 || diff.removed.length > 0 || diff.modified.length > 0;

    if (errors.length > 0) {
      await showAlert(
        'Replay Errors',
        `${errors.length} error(s) during replay:\n${errors.join('\n')}`
      );
    }

    if (!hasChanges) {
      await showAlert(
        'Replay Complete',
        'Journal replay matches current state. No differences found.'
      );
      return;
    }

    const changeList = [
      ...diff.added.map(f => `+ ${f}`),
      ...diff.removed.map(f => `- ${f}`),
      ...diff.modified.map(f => `~ ${f}`),
    ].join('\n');

    const confirmed = await showDestructiveConfirm(
      'Differences Found',
      `Replayed state differs from current:\n${changeList}\n\nOverwrite current state with replayed version?`,
      'Overwrite'
    );

    if (confirmed) {
      await saveMemory(projectId, replayedFs);
      setFileSystem(replayedFs);
      setSelectedFile(null);
      setIsDiffMode(false);
    }
  };

  const handleToggleDiff = () => {
    if (!selectedFile || journalVersion === 0) return;

    if (isDiffMode) {
      setIsDiffMode(false);
      setDiffContent(null);
    } else {
      setIsDiffMode(true);
      const initialVersion = Math.max(0, journalVersion - 1);
      setDiffVersion(initialVersion);
      updateDiff(initialVersion);
    }
  };

  const handleDiffPrev = () => {
    if (diffVersion > 0) {
      const newVersion = diffVersion - 1;
      setDiffVersion(newVersion);
      updateDiff(newVersion);
    }
  };

  const handleDiffNext = () => {
    if (diffVersion < journalVersion - 1) {
      const newVersion = diffVersion + 1;
      setDiffVersion(newVersion);
      updateDiff(newVersion);
    }
  };

  const handleOpenEdit = () => {
    if (!selectedFileData) return;
    setEditContent(selectedFileData.content);
    setIsEditModalOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!projectId || !selectedFile || !fileSystem) return;

    const originalContent = fileSystem.files[selectedFile]?.content ?? '';
    if (editContent === originalContent) {
      setIsEditModalOpen(false);
      return;
    }

    const now = new Date().toISOString();
    const updatedFile: MemoryFile = {
      ...fileSystem.files[selectedFile],
      content: editContent,
      updatedAt: now,
    };

    const newFs: MemoryFileSystem = {
      files: { ...fileSystem.files, [selectedFile]: updatedFile },
    };
    await saveMemory(projectId, newFs);

    await saveJournalEntry(projectId, {
      command: 'user_edit',
      path: `/memories/${selectedFile}`,
      file_text: editContent,
    });

    const [newJournal, newVersion] = await Promise.all([
      loadJournal(projectId),
      getJournalVersion(projectId),
    ]);

    setFileSystem(newFs);
    setJournal(newJournal);
    setJournalVersion(newVersion);
    setIsEditModalOpen(false);
  };

  const handleRollback = async () => {
    if (!projectId || !selectedFile || !fileSystem) return;

    // Get the content at the target version (diffVersion + 1)
    const targetVersion = diffVersion + 1;
    const { fs: targetFs } = replayJournal(journal, targetVersion);
    const targetContent = targetFs.files[selectedFile]?.content;

    if (targetContent === undefined) {
      await showAlert(
        'Rollback Failed',
        `File "${selectedFile}" does not exist at version ${targetVersion}.`
      );
      return;
    }

    const currentContent = fileSystem.files[selectedFile]?.content ?? '';
    if (targetContent === currentContent) {
      await showAlert('No Changes', 'File content is already at this version.');
      return;
    }

    const confirmed = await showDestructiveConfirm(
      'Rollback File',
      `Replace current content with version ${targetVersion}?`,
      'Rollback'
    );

    if (!confirmed) return;

    const now = new Date().toISOString();
    const updatedFile: MemoryFile = {
      ...fileSystem.files[selectedFile],
      content: targetContent,
      updatedAt: now,
    };

    const newFs: MemoryFileSystem = {
      files: { ...fileSystem.files, [selectedFile]: updatedFile },
    };
    await saveMemory(projectId, newFs);

    await saveJournalEntry(projectId, {
      command: 'user_rollback',
      path: `/memories/${selectedFile}`,
      file_text: targetContent,
    });

    const [newJournal, newVersion] = await Promise.all([
      loadJournal(projectId),
      getJournalVersion(projectId),
    ]);

    setFileSystem(newFs);
    setJournal(newJournal);
    setJournalVersion(newVersion);
    setIsDiffMode(false);
    setDiffContent(null);
  };

  if (!projectId) {
    return null;
  }

  const files = fileSystem ? Object.keys(fileSystem.files).sort() : [];
  const selectedFileData: MemoryFile | null =
    selectedFile && fileSystem ? fileSystem.files[selectedFile] : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-gray-50">
      {/* Header with safe area */}
      <div className="border-b border-gray-200 bg-white">
        <div className="safe-area-inset-top" />
        <div className="flex h-14 items-center px-4">
          {onMenuPress && (
            <button
              onClick={onMenuPress}
              className="flex h-11 w-11 items-center justify-center text-gray-700 hover:text-gray-900 md:hidden"
            >
              <span className="text-2xl">☰</span>
            </button>
          )}
          <button
            onClick={handleBack}
            className="flex h-11 w-11 items-center justify-center text-gray-700 hover:text-gray-900"
          >
            <span className="text-xl">←</span>
          </button>
          <div className="flex-1 text-center">
            <h1 className="text-lg font-semibold text-gray-900">Memory Files</h1>
            {journalVersion > 0 && (
              <p className="text-xs text-gray-500">
                v{journalVersion} ({journal.length} writes)
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {journal.length > 0 && (
              <button
                onClick={handleReplay}
                className="flex h-11 items-center justify-center px-2 text-sm text-blue-600 hover:text-blue-700"
                title="Replay journal and compare"
              >
                Verify
              </button>
            )}
            <button
              onClick={handleClearAll}
              disabled={files.length === 0 && journal.length === 0}
              className="flex h-11 items-center justify-center px-2 text-sm text-red-600 hover:text-red-700 disabled:text-gray-400"
            >
              Clear All
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="ios-scroll flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        {/* File List */}
        <div className="border-b border-gray-200 bg-white md:w-64 md:border-r md:border-b-0">
          <div className="ios-scroll max-h-48 overflow-y-auto overscroll-y-contain md:h-full md:max-h-none">
            {isLoading ? (
              <div className="flex items-center justify-center p-8">
                <span className="text-gray-500">Loading...</span>
              </div>
            ) : files.length === 0 ? (
              <div className="p-4 text-center text-gray-500">
                <p className="mb-2">No memory files yet</p>
                <p className="text-xs">Claude will create files as needed during conversations</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {files.map(path => {
                  const file = fileSystem!.files[path];
                  const isSelected = selectedFile === path;
                  return (
                    <div
                      key={path}
                      onClick={() => {
                        setSelectedFile(path);
                        setIsDiffMode(false);
                        setDiffContent(null);
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedFile(path);
                          setIsDiffMode(false);
                          setDiffContent(null);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      className={`flex cursor-pointer items-center justify-between p-3 transition-colors ${
                        isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <p
                          className={`truncate text-sm font-medium ${isSelected ? 'text-blue-700' : 'text-gray-900'}`}
                        >
                          📄 {path}
                        </p>
                        <p className="text-xs text-gray-500">
                          {new Date(file.updatedAt).toLocaleDateString()}
                        </p>
                      </div>
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          handleDeleteFile(path);
                        }}
                        className="ml-2 p-1 text-gray-400 hover:text-red-600"
                        title="Delete file"
                      >
                        🗑️
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* File Content */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-white">
          {selectedFileData ? (
            <>
              <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
                <div>
                  <h2 className="font-medium text-gray-900">{selectedFile}</h2>
                  <p className="text-xs text-gray-500">
                    Created: {new Date(selectedFileData.createdAt).toLocaleString()} • Updated:{' '}
                    {new Date(selectedFileData.updatedAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {isDiffMode ? (
                    <>
                      <button
                        onClick={handleDiffPrev}
                        disabled={diffVersion <= 0}
                        className="flex h-8 w-8 items-center justify-center rounded text-gray-600 hover:bg-gray-100 disabled:text-gray-300"
                        title="Previous version"
                      >
                        ◀
                      </button>
                      <span className="min-w-[60px] text-center text-xs text-gray-600">
                        v{diffVersion} → v{diffVersion + 1}
                      </span>
                      <button
                        onClick={handleDiffNext}
                        disabled={diffVersion >= journalVersion - 1}
                        className="flex h-8 w-8 items-center justify-center rounded text-gray-600 hover:bg-gray-100 disabled:text-gray-300"
                        title="Next version"
                      >
                        ▶
                      </button>
                      <button
                        onClick={handleRollback}
                        className="ml-2 rounded bg-orange-100 px-2 py-1 text-xs text-orange-700 hover:bg-orange-200"
                        title="Restore file to this version"
                      >
                        Rollback
                      </button>
                      <button
                        onClick={handleToggleDiff}
                        className="rounded bg-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-300"
                      >
                        Exit Diff
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={handleOpenEdit}
                        className="rounded bg-green-100 px-2 py-1 text-xs text-green-700 hover:bg-green-200"
                        title="Edit file content"
                      >
                        Edit
                      </button>
                      {journalVersion > 0 && (
                        <button
                          onClick={handleToggleDiff}
                          className="rounded bg-blue-100 px-2 py-1 text-xs text-blue-700 hover:bg-blue-200"
                          title="Show diff with previous version"
                        >
                          Diff
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
              <div className="ios-scroll scroll-safe-bottom flex-1 overflow-y-auto overscroll-y-contain">
                {isDiffMode && diffContent ? (
                  <div className="p-4">
                    {replayErrors.length > 0 && (
                      <div className="mb-4 rounded bg-yellow-50 p-2 text-xs text-yellow-800">
                        ⚠️ {replayErrors.length} replay error(s)
                      </div>
                    )}
                    <pre className="overflow-x-auto font-mono text-sm">
                      {diffContent.map((line, i) => {
                        const prefix = line.substring(0, 2);
                        let className = 'text-gray-800';
                        if (prefix === '+ ') className = 'bg-green-100 text-green-800';
                        else if (prefix === '- ') className = 'bg-red-100 text-red-800';
                        return (
                          <div key={i} className={className}>
                            {line}
                          </div>
                        );
                      })}
                    </pre>
                  </div>
                ) : (
                  <pre className="p-4 font-mono text-sm whitespace-pre-wrap text-gray-800">
                    {selectedFileData.content}
                  </pre>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-gray-500">
              {files.length > 0 ? 'Select a file to view its content' : 'No files to display'}
            </div>
          )}
        </div>
      </div>

      {/* Edit Modal */}
      <Modal isOpen={isEditModalOpen} onClose={() => setIsEditModalOpen(false)} size="lg">
        <div className="rounded-lg bg-white">
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
            <h3 className="font-medium text-gray-900">Edit: {selectedFile}</h3>
            <button
              onClick={() => setIsEditModalOpen(false)}
              className="text-gray-400 hover:text-gray-600"
            >
              ✕
            </button>
          </div>
          <div className="p-4">
            <textarea
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              className="h-80 w-full resize-none rounded border border-gray-300 p-3 font-mono text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
              placeholder="File content..."
            />
          </div>
          <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-3">
            <button
              onClick={() => setIsEditModalOpen(false)}
              className="rounded bg-gray-100 px-4 py-2 text-sm text-gray-700 hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              onClick={handleSaveEdit}
              className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
            >
              Save
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
