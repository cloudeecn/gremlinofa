/**
 * CSV Helper Utilities
 * RFC 4180 compliant CSV escaping and parsing
 */

/**
 * Escape a value for CSV format
 * - Wrap in quotes if contains comma, quote, or newline
 * - Escape quotes by doubling them
 */
export function escapeCSV(value: string | undefined | null): string {
  if (value === undefined || value === null) return '';

  const str = String(value);

  // Empty string
  if (str === '') return '';

  // If contains comma, quote, newline, or carriage return, wrap in quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    // Escape quotes by doubling them
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Parse a CSV string into an array of rows
 * Handles quoted fields with commas and newlines
 * RFC 4180 compliant
 */
export function parseCSV(content: string): string[][] {
  const lines: string[][] = [];
  let currentLine: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (inQuotes) {
      if (char === '"') {
        // Check if this is an escaped quote (doubled quote)
        if (content[i + 1] === '"') {
          currentField += '"';
          i++; // Skip next quote
        } else {
          // End of quoted field
          inQuotes = false;
        }
      } else {
        // Regular character inside quotes
        currentField += char;
      }
    } else {
      if (char === '"') {
        // Start of quoted field
        inQuotes = true;
      } else if (char === ',') {
        // Field separator
        currentLine.push(currentField);
        currentField = '';
      } else if (char === '\n') {
        // Line separator (handle \r\n)
        if (currentField || currentLine.length > 0) {
          currentLine.push(currentField);
          lines.push(currentLine);
          currentLine = [];
          currentField = '';
        }
      } else if (char === '\r') {
        // Skip \r (will be handled by \n)
        if (content[i + 1] === '\n') {
          // \r\n - skip \r
          continue;
        } else {
          // Standalone \r (treat as line separator)
          if (currentField || currentLine.length > 0) {
            currentLine.push(currentField);
            lines.push(currentLine);
            currentLine = [];
            currentField = '';
          }
        }
      } else {
        // Regular character
        currentField += char;
      }
    }
  }

  // Handle last field/line
  if (currentField || currentLine.length > 0) {
    currentLine.push(currentField);
    if (currentLine.length > 0) {
      lines.push(currentLine);
    }
  }

  return lines;
}

/**
 * Build a CSV line from an array of values
 */
export function buildCSVLine(values: (string | undefined | null)[]): string {
  return values.map(escapeCSV).join(',');
}

/**
 * Streaming CSV parser state
 * Maintains parsing state between chunks for incremental parsing
 */
export interface CSVParserState {
  currentField: string;
  currentLine: string[];
  inQuotes: boolean;
  pendingCarriageReturn: boolean;
}

/**
 * Create initial parser state
 */
export function createCSVParserState(): CSVParserState {
  return {
    currentField: '',
    currentLine: [],
    inQuotes: false,
    pendingCarriageReturn: false,
  };
}

/**
 * Parse a chunk of CSV content incrementally
 * Returns completed rows and updates the state for next chunk
 *
 * @param chunk - Text chunk to parse
 * @param state - Parser state (will be mutated)
 * @returns Array of completed rows
 */
export function parseCSVChunk(chunk: string, state: CSVParserState): string[][] {
  const completedRows: string[][] = [];

  for (let i = 0; i < chunk.length; i++) {
    const char = chunk[i];

    // Handle pending \r from previous iteration
    if (state.pendingCarriageReturn) {
      state.pendingCarriageReturn = false;
      if (char === '\n') {
        // \r\n - the \r already ended the line, skip \n
        continue;
      }
      // Standalone \r was already handled
    }

    if (state.inQuotes) {
      if (char === '"') {
        // Check if this is an escaped quote (doubled quote)
        if (chunk[i + 1] === '"') {
          state.currentField += '"';
          i++; // Skip next quote
        } else {
          // End of quoted field
          state.inQuotes = false;
        }
      } else {
        // Regular character inside quotes
        state.currentField += char;
      }
    } else {
      if (char === '"') {
        // Start of quoted field
        state.inQuotes = true;
      } else if (char === ',') {
        // Field separator
        state.currentLine.push(state.currentField);
        state.currentField = '';
      } else if (char === '\n') {
        // Line separator
        if (state.currentField || state.currentLine.length > 0) {
          state.currentLine.push(state.currentField);
          completedRows.push(state.currentLine);
          state.currentLine = [];
          state.currentField = '';
        }
      } else if (char === '\r') {
        // Handle \r - complete the line now
        if (state.currentField || state.currentLine.length > 0) {
          state.currentLine.push(state.currentField);
          completedRows.push(state.currentLine);
          state.currentLine = [];
          state.currentField = '';
        }
        state.pendingCarriageReturn = true;
      } else {
        // Regular character
        state.currentField += char;
      }
    }
  }

  return completedRows;
}

/**
 * Finalize parser state - returns any remaining row
 *
 * @param state - Parser state
 * @returns Final row if any, or null
 */
export function finalizeCSVParser(state: CSVParserState): string[] | null {
  if (state.currentField || state.currentLine.length > 0) {
    state.currentLine.push(state.currentField);
    const finalRow = state.currentLine;
    // Reset state
    state.currentField = '';
    state.currentLine = [];
    return finalRow;
  }
  return null;
}

/**
 * Read a file chunk using FileReader (for environments without ReadableStream)
 */
function readChunk(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Async generator that streams CSV rows from a File
 * Memory-efficient: processes chunks without loading entire file
 *
 * @param file - File to parse
 * @param chunkSize - Size of each chunk to read (default: 64KB)
 * @yields CSV rows as string arrays
 */
export async function* streamCSVRows(
  file: File,
  chunkSize: number = 64 * 1024
): AsyncGenerator<string[], void, unknown> {
  const state = createCSVParserState();
  const decoder = new TextDecoder('utf-8');

  let offset = 0;

  while (offset < file.size) {
    // Slice and read only the chunk we need
    const end = Math.min(offset + chunkSize, file.size);
    const blob = file.slice(offset, end);

    // Use FileReader to read the chunk (more compatible than blob.text())
    const buffer = await readChunk(blob);

    // Decode chunk to string
    const isLastChunk = end >= file.size;
    const chunk = decoder.decode(buffer, { stream: !isLastChunk });

    // Parse the chunk and yield completed rows
    const rows = parseCSVChunk(chunk, state);
    for (const row of rows) {
      yield row;
    }

    offset = end;
  }

  // Finalize any remaining content
  const finalRow = finalizeCSVParser(state);
  if (finalRow) {
    yield finalRow;
  }
}
