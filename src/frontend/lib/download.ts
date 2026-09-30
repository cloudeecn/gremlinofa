/**
 * How long the object URL outlives the click. Revoking right after `click()`
 * can cancel a large download in Safari and Firefox, which read the blob
 * asynchronously; 40 s is FileSaver.js's delay.
 */
export const REVOKE_DELAY_MS = 40_000;

/** Save a Blob through a temporary `<a download>` click. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
