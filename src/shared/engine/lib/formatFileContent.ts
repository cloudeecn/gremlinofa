/**
 * Format file content with line numbers.
 * Line numbers are 6 characters, right-aligned, followed by tab.
 *
 * Shared across fsTool and memoryTool (and anything else that needs
 * the same `=== /path ===` + numbered-lines format).
 */
export function formatFileWithLineNumbers(
  content: string,
  startLine = 1,
  endLine?: number
): string {
  const lines = content.split('\n');
  const start = startLine - 1;
  const end = endLine !== undefined ? endLine : lines.length;
  const selectedLines = lines.slice(start, end);

  return selectedLines.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`).join('\n');
}

/**
 * Resolve the effective `noLineNumbers` (negative) from the three-level
 * precedence: per-call tool input > loop option > project setting.
 *
 * `withLineNumbers` and `fileLineNumbers` are positive booleans (true = show);
 * `projectNoLineNumbers` keeps the existing negative polarity. `undefined` at a
 * level defers to the next one down.
 */
export function resolveNoLineNumbers(
  withLineNumbers: boolean | undefined,
  fileLineNumbers: boolean | undefined,
  projectNoLineNumbers: boolean | undefined
): boolean {
  if (withLineNumbers !== undefined) return !withLineNumbers;
  if (fileLineNumbers !== undefined) return !fileLineNumbers;
  return !!projectNoLineNumbers;
}
