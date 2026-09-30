import { useState, type DragEvent } from 'react';

function carriesFiles(e: DragEvent) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Drag-and-drop of files onto an element. Only file drags are taken (dragging
 * selected text over it behaves as usual), and taking them also stops the
 * browser from navigating to a file dropped a few pixels off target.
 * `onFiles` receives every dropped file; filtering is the caller's job so it
 * can report what it rejected.
 */
export function useImageDropZone(onFiles: (files: File[]) => void) {
  const [isDragging, setIsDragging] = useState(false);

  const dropZoneProps = {
    onDragEnter: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      setIsDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent) => {
      // dragleave also fires when moving onto a child; only leaving the zone counts
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIsDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      setIsDragging(false);
      onFiles(Array.from(e.dataTransfer.files));
    },
  };

  return { isDragging, dropZoneProps };
}
