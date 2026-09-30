/**
 * Frontend-only download trigger for the project bundle.
 *
 * Phase 1.8 split: the previous `src/utils/projectExport.ts` mixed pure
 * helpers (`collectLiveEntries`, `stripProjectForExport`), the bundle
 * types, and this DOM-touching download trigger. The split moves the
 * pure helpers into `src/shared/engine/projectBundle.ts` (where the
 * impure runtime already lived), the types into
 * `src/shared/protocol/types/projectBundle.ts`, and leaves only this
 * single function in `src/frontend/lib/`.
 */

import { downloadBlob } from './download';

/** Trigger a browser download for the exported project blob. */
export function triggerProjectDownload(blob: Blob, projectName: string): void {
  const date = new Date().toISOString().split('T')[0];
  const safeName = projectName.replace(/[^a-zA-Z0-9_-]/g, '_');
  downloadBlob(blob, `${safeName}-export-${date}.gremlin.json`);
}
