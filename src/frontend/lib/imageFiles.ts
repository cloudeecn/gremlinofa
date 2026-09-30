/**
 * Picks the images to stage from a pick, paste or drop. A batch that would go
 * over the limit is rejected whole (same as the 📎 picker always did); other
 * file types are dropped with an error while the images still go through.
 */
export function pickImageFiles(
  files: readonly File[],
  stagedCount: number,
  maxAttachments: number
): { images: File[]; error?: string } {
  if (files.length === 0) return { images: [] };

  if (stagedCount + files.length > maxAttachments) {
    return {
      images: [],
      error: `Maximum ${maxAttachments} images allowed. You can add ${Math.max(0, maxAttachments - stagedCount)} more.`,
    };
  }

  const images = files.filter(file => file.type.startsWith('image/'));
  return images.length < files.length
    ? { images, error: 'Only image files are allowed' }
    : { images };
}

/** Image files on the clipboard (a pasted screenshot or copied image). */
export function clipboardImageFiles(data: DataTransfer): File[] {
  const fromFiles = Array.from(data.files).filter(file => file.type.startsWith('image/'));
  if (fromFiles.length > 0) return fromFiles;
  // Some browsers expose a pasted image only through items
  return Array.from(data.items)
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null);
}
