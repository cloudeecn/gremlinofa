/**
 * Browser-only download trigger for project bundles. Used by the
 * Export Project modal to push a `Blob` to the user as a file
 * via an anchor element.
 *
 * The bundle itself is built backend-side by
 * `gremlinClient.exportProjectBundle` (which streams chunks back
 * through `engine/projectBundle.ts`). This function only owns the
 * main-thread DOM bits. Phase 1.8 split it out from the now-shared
 * `projectBundleSchema.ts`.
 */
export function triggerProjectDownload(blob: Blob, projectName: string): void {
  const date = new Date().toISOString().split('T')[0];
  const safeName = projectName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${safeName}-export-${date}.gremlin.json`;

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
