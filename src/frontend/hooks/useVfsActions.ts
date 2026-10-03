import { useState } from 'react';
import type { VfsAdapter } from '../../shared/protocol/types/vfs';
import { useAlert } from './useAlert';
import type { EntryType, VfsTreeState } from './useVfsTree';
import { downloadBlob } from '../lib/download';
import { VFS_ROOT, basename, dirname, joinPath, validateEntryName } from '../lib/vfsPath';
import {
  collectFolderFiles,
  importZip,
  planZipImport,
  toFileContent,
  unzipArchive,
  zipFiles,
} from '../lib/vfsArchive';
import type { ZipImportPlan } from '../lib/vfsArchive';

export interface VfsBusy {
  label: string;
  done?: number;
  total?: number;
}

export interface VfsActions {
  busy: VfsBusy | null;
  createFile: (dir: string) => Promise<void>;
  createFolder: (dir: string) => Promise<void>;
  uploadFiles: (dir: string, files: File[]) => Promise<void>;
  uploadZip: (dir: string, file: File) => Promise<void>;
  downloadZip: (dir: string) => Promise<void>;
  deleteEntry: (path: string, type: EntryType) => Promise<void>;
}

interface UseVfsActionsOptions {
  adapter: VfsAdapter;
  tree: VfsTreeState;
  /** Shows a new or uploaded entry. `isNew`: created empty here, not uploaded */
  onCreated: (path: string, type: EntryType, isNew: boolean) => void;
  onDeleted: (path: string) => void;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** At most this many failures are listed in a summary dialog. */
const MAX_LISTED_FAILURES = 8;

function failureSummary(failed: Array<{ path: string; message: string }>): string {
  const listed = failed.slice(0, MAX_LISTED_FAILURES).map(f => `• ${f.path}: ${f.message}`);
  if (failed.length > MAX_LISTED_FAILURES) {
    listed.push(`…and ${failed.length - MAX_LISTED_FAILURES} more`);
  }
  return listed.join('\n');
}

/**
 * Folder and entry mutations of the VFS manager. One runs at a time; `busy`
 * drives the status strip and disables the buttons. Failures end in a
 * dialog, never only in the console.
 */
export function useVfsActions({
  adapter,
  tree,
  onCreated,
  onDeleted,
}: UseVfsActionsOptions): VfsActions {
  const { showAlert, showDestructiveConfirm, showPrompt } = useAlert();
  const [busy, setBusy] = useState<VfsBusy | null>(null);

  const run = async (
    label: string,
    task: (progress: (done: number, total: number) => void) => Promise<void>
  ) => {
    if (busy) return;
    setBusy({ label });
    try {
      await task((done, total) => setBusy({ label, done, total }));
    } finally {
      setBusy(null);
    }
  };

  const createFile = async (dir: string) => {
    const name = await showPrompt({
      title: 'New file',
      message: `In ${dir}`,
      label: 'File name',
      placeholder: 'notes.md',
      confirmLabel: 'Create',
      validate: validateEntryName,
    });
    if (name === null) return;
    const path = joinPath(dir, name);
    await run('Creating file', async () => {
      try {
        await adapter.createFile(path, '');
      } catch (error) {
        await showAlert('Couldn’t create file', errorMessage(error));
        return;
      }
      tree.refresh(dir);
      onCreated(path, 'file', true);
    });
  };

  const createFolder = async (dir: string) => {
    const name = await showPrompt({
      title: 'New folder',
      message: `In ${dir}`,
      label: 'Folder name',
      confirmLabel: 'Create',
      validate: validateEntryName,
    });
    if (name === null) return;
    const path = joinPath(dir, name);
    await run('Creating folder', async () => {
      try {
        await adapter.mkdir(path);
      } catch (error) {
        await showAlert('Couldn’t create folder', errorMessage(error));
        return;
      }
      tree.refresh(dir);
      onCreated(path, 'dir', true);
    });
  };

  const uploadFiles = (dir: string, files: File[]) =>
    run('Uploading', async progress => {
      const failed: Array<{ path: string; message: string }> = [];
      for (const [index, file] of files.entries()) {
        const path = joinPath(dir, file.name);
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          await adapter.writeFile(path, toFileContent(bytes));
        } catch (error) {
          failed.push({ path, message: errorMessage(error) });
        }
        progress(index + 1, files.length);
      }
      tree.refresh(dir);
      if (files.length === 1 && failed.length === 0)
        onCreated(joinPath(dir, files[0].name), 'file', false);
      if (failed.length > 0) {
        const uploaded = files.length - failed.length;
        await showAlert(
          'Some files weren’t uploaded',
          `Uploaded ${uploaded} of ${files.length}.\n\n${failureSummary(failed)}`
        );
      }
    });

  const uploadZip = (dir: string, file: File) =>
    run('Extracting ZIP', async progress => {
      let plan: ZipImportPlan;
      try {
        plan = planZipImport(await unzipArchive(new Uint8Array(await file.arrayBuffer())));
      } catch (error) {
        await showAlert('Couldn’t read the ZIP', errorMessage(error));
        return;
      }
      const skippedNote =
        plan.skipped.length > 0
          ? `\n\nSkipped ${plan.skipped.length} entries pointing outside the folder: ${plan.skipped.join(', ')}`
          : '';
      if (plan.files.length === 0 && plan.emptyDirs.length === 0) {
        await showAlert('Nothing to extract', `The ZIP has no files.${skippedNote}`);
        return;
      }

      const result = await importZip(adapter, dir, plan, progress);
      tree.refresh(dir);
      tree.expand(dir);
      if (result.failed.length > 0 || plan.skipped.length > 0) {
        const failedNote = result.failed.length > 0 ? `\n\n${failureSummary(result.failed)}` : '';
        await showAlert(
          'ZIP partly extracted',
          `Extracted ${result.written} of ${plan.files.length} files.${failedNote}${skippedNote}`
        );
      }
    });

  const downloadZip = (dir: string) =>
    run('Preparing ZIP', async progress => {
      try {
        const files = await collectFolderFiles(adapter, dir, progress);
        if (Object.keys(files).length === 0) {
          await showAlert('Nothing to download', 'This folder has no files.');
          return;
        }
        const archive = await zipFiles(files);
        const name = dir === VFS_ROOT ? 'memory-files' : basename(dir);
        downloadBlob(new Blob([archive], { type: 'application/zip' }), `${name}.zip`);
      } catch (error) {
        await showAlert('Couldn’t build the ZIP', errorMessage(error));
      }
    });

  const deleteEntry = async (path: string, type: EntryType) => {
    const name = basename(path);
    const confirmed = await showDestructiveConfirm(
      type === 'dir' ? 'Delete folder' : 'Delete file',
      type === 'dir'
        ? `Delete “${name}” and everything in it? The files are marked as deleted and leave the tree.`
        : `Delete “${name}”? The file is marked as deleted and leaves the tree.`,
      'Delete'
    );
    if (!confirmed) return;
    await run('Deleting', async () => {
      try {
        if (type === 'dir') await adapter.rmdir(path, true);
        else await adapter.deleteFile(path);
      } catch (error) {
        await showAlert(
          type === 'dir' ? 'Couldn’t delete folder' : 'Couldn’t delete file',
          errorMessage(error)
        );
        return;
      }
      tree.refresh(dirname(path));
      onDeleted(path);
    });
  };

  return { busy, createFile, createFolder, uploadFiles, uploadZip, downloadZip, deleteEntry };
}
