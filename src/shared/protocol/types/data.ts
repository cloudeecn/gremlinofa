/**
 * Type-only declarations shared between the frontend (modal callbacks,
 * progress UI) and the backend export/import runtime under
 * `src/backend/dataExport.ts` / `src/backend/dataImport.ts`.
 *
 * These types live here so frontend code can `import type` them without
 * crossing the boundary lint rule into `src/services/**` or `src/backend/**`.
 */

/**
 * Progress callback for streaming export. Called once per persisted record
 * (excluding the CSV header row).
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
