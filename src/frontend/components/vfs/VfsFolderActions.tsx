import { useRef } from 'react';
import VfsButton from './VfsButton';
import type { VfsActions } from '../../hooks/useVfsActions';
import { VFS_ROOT } from '../../lib/vfsPath';

interface VfsFolderActionsProps {
  dir: string;
  actions: VfsActions;
  /** `toolbar`: wraps inside the desktop folder header. `bar`: the mobile bottom bar, scrolls sideways. */
  variant: 'toolbar' | 'bar';
}

export default function VfsFolderActions({ dir, actions, variant }: VfsFolderActionsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const disabled = actions.busy !== null;
  const buttonClass = variant === 'bar' ? 'h-10' : '';

  return (
    <div
      className={
        variant === 'bar'
          ? 'ios-scroll flex gap-2 overflow-x-auto overscroll-x-contain'
          : 'flex flex-wrap gap-2'
      }
    >
      <VfsButton
        icon="📄"
        label="New file"
        tone="primary"
        className={buttonClass}
        disabled={disabled}
        onClick={() => void actions.createFile(dir)}
      />
      <VfsButton
        icon="📁"
        label="New folder"
        className={buttonClass}
        disabled={disabled}
        onClick={() => void actions.createFolder(dir)}
      />
      <VfsButton
        icon="⬆️"
        label="Upload"
        className={buttonClass}
        disabled={disabled}
        onClick={() => fileInputRef.current?.click()}
      />
      <VfsButton
        icon="📦"
        label="Upload ZIP"
        className={buttonClass}
        disabled={disabled}
        onClick={() => zipInputRef.current?.click()}
      />
      <VfsButton
        icon="📦"
        label="Download ZIP"
        className={buttonClass}
        disabled={disabled}
        onClick={() => void actions.downloadZip(dir)}
      />
      {dir !== VFS_ROOT && (
        <VfsButton
          icon="🗑️"
          label="Delete"
          tone="danger"
          className={buttonClass}
          disabled={disabled}
          onClick={() => void actions.deleteEntry(dir, 'dir')}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        data-testid="vfs-upload-input"
        onChange={event => {
          const files = Array.from(event.target.files ?? []);
          // Cleared so picking the same file again still fires onChange
          event.target.value = '';
          if (files.length > 0) void actions.uploadFiles(dir, files);
        }}
      />
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip,application/zip"
        hidden
        data-testid="vfs-zip-input"
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void actions.uploadZip(dir, file);
        }}
      />
    </div>
  );
}
