/**
 * Type-only declarations shared between the frontend (modal callbacks,
 * progress UI) and the backend export/import runtime under
 * `src/backend/dataExport.ts` / `src/backend/dataImport.ts`.
 *
 * These types live here so frontend code can `import type` them without
 * crossing the boundary lint rule into `src/services/**` or `src/backend/**`.
 */

/**
 * Progress callback for streaming export. Receives the number of records
 * exported so far (excluding the CSV header row): for the first record, then
 * at most every 100 ms, then once with the final count before the export ends.
 */
export type ExportProgressCallback = (count: number) => void;

/**
 * Progress payload reported by the streaming import.
 */
export interface ImportProgress {
  processed: number;
  imported: number;
  skipped: number;
  errors: number;
  /** Estimated total (may be undefined if unknown) */
  estimatedTotal?: number;
}

export type ImportProgressCallback = (progress: ImportProgress) => void;
