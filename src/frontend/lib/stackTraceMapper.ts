/// <reference types="vite/client" />
import StackTrace from 'stacktrace-js';

/**
 * Maps a minified stack trace to original source locations using source maps.
 * Only works in production builds where source maps are available.
 *
 * @param error - The error object with stack trace to map
 * @returns Formatted stack trace with original source locations
 */
export async function mapStackTrace(error: Error): Promise<string> {
  try {
    const stackframes = await StackTrace.fromError(error, {
      // Use sourceCache to avoid re-fetching source maps
      offline: false,
    });

    if (stackframes.length === 0) {
      return error.stack || 'No stack trace available';
    }

    // Format stack frames similar to native stack trace format
    const mappedLines = stackframes.map(frame => {
      const functionName = frame.functionName || '<anonymous>';
      const fileName = frame.fileName || '<unknown>';
      const lineNumber = frame.lineNumber ?? '?';
      const columnNumber = frame.columnNumber ?? '?';

      return `    at ${functionName} (${fileName}:${lineNumber}:${columnNumber})`;
    });

    return `${error.name}: ${error.message}\n${mappedLines.join('\n')}`;
  } catch (mappingError) {
    // If source map resolution fails, return original stack
    console.debug('[stackTraceMapper] Failed to map stack trace:', mappingError);
    return error.stack || 'No stack trace available';
  }
}

/**
 * Maps a raw stack trace string to original source locations.
 * Useful when you only have the stack string, not the Error object.
 *
 * @param stackString - Raw stack trace string
 * @returns Formatted stack trace with original source locations
 */
export async function mapStackString(stackString: string): Promise<string> {
  try {
    // Parse the stack string to extract message and create a pseudo-error
    const lines = stackString.split('\n');
    const messageLine = lines[0] || 'Error';

    // Extract error name and message from first line (e.g., "Error: Something went wrong")
    const colonIndex = messageLine.indexOf(':');
    const errorName = colonIndex > -1 ? messageLine.slice(0, colonIndex).trim() : 'Error';
    const errorMessage =
      colonIndex > -1 ? messageLine.slice(colonIndex + 1).trim() : messageLine.trim();

    // Create an error object to use with stacktrace-js
    const error = new Error(errorMessage);
    error.name = errorName;
    error.stack = stackString;

    return await mapStackTrace(error);
  } catch (mappingError) {
    console.debug('[stackTraceMapper] Failed to map stack string:', mappingError);
    return stackString;
  }
}

/**
 * Check if we're in a production build where source maps would be available
 */
export function isProductionBuild(): boolean {
  // In dev mode, import.meta.env.DEV is true
  // Source map resolution is only useful in production
  return !import.meta.env.DEV;
}
