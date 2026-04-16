/**
 * Project bundle types — the on-disk shape of a `.gremlin.json` export.
 *
 * Phase 1.8 hoist: previously these types lived in
 * `src/utils/projectExport.ts` next to the impure download trigger.
 * The relocation puts them on the protocol surface so the worker's
 * `runProjectExport` / `runProjectImport` runtime can read/write the
 * shape directly without reaching back into a frontend file.
 */

/** Entry in the exported files array. Files have `content`; directories use `type: 'directory'`. */
export interface BundleFileEntry {
  path: string;
  type?: 'directory'; // omitted for files
  content?: string;
  isBinary?: boolean;
  mime?: string;
}

/** The exported project bundle on disk (`.gremlin.json`). */
export interface ProjectBundle {
  version: 1;
  exportedAt: string;
  project: Record<string, unknown>;
  files: BundleFileEntry[];
}
