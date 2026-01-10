/**
 * Line-by-line diff using Longest Common Subsequence (LCS) algorithm.
 * Produces unified diff output showing additions, removals, and unchanged lines.
 */

export interface DiffLine {
  type: 'add' | 'remove' | 'same';
  content: string;
}

/**
 * Compute LCS table for two arrays of strings.
 * Returns a 2D array where lcs[i][j] = length of LCS for oldLines[0..i-1] and newLines[0..j-1]
 */
function computeLcsTable(oldLines: string[], newLines: string[]): number[][] {
  const m = oldLines.length;
  const n = newLines.length;

  // Initialize (m+1) x (n+1) table with zeros
  const lcs: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  // Fill LCS table
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      }
    }
  }

  return lcs;
}

/**
 * Iterative backtrack to avoid stack overflow on large files.
 * Produces same output as recursive version.
 */
function backtrackDiffIterative(
  lcs: number[][],
  oldLines: string[],
  newLines: string[]
): DiffLine[] {
  let i = oldLines.length;
  let j = newLines.length;
  const reversedResult: DiffLine[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      reversedResult.push({ type: 'same', content: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      reversedResult.push({ type: 'add', content: newLines[j - 1] });
      j--;
    } else if (i > 0) {
      reversedResult.push({ type: 'remove', content: oldLines[i - 1] });
      i--;
    }
  }

  return reversedResult.reverse();
}

/**
 * Compute line-by-line diff between two arrays of strings.
 *
 * Uses Longest Common Subsequence (LCS) algorithm:
 * - O(m*n) time and space where m, n are line counts
 * - For very large files, consider chunking or streaming
 *
 * @param oldLines Lines from the old version
 * @param newLines Lines from the new version
 * @returns Array of DiffLine objects showing changes
 */
export function computeLcsDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  // Edge cases
  if (oldLines.length === 0 && newLines.length === 0) {
    return [];
  }

  if (oldLines.length === 0) {
    return newLines.map(line => ({ type: 'add' as const, content: line }));
  }

  if (newLines.length === 0) {
    return oldLines.map(line => ({ type: 'remove' as const, content: line }));
  }

  // Compute LCS table
  const lcs = computeLcsTable(oldLines, newLines);

  // Backtrack to produce diff (iterative to handle large files)
  return backtrackDiffIterative(lcs, oldLines, newLines);
}

/**
 * Split text content into lines for diffing.
 * Handles empty strings and preserves empty lines.
 */
export function splitLines(content: string): string[] {
  if (content === '') {
    return [];
  }
  return content.split('\n');
}

/**
 * Get diff statistics: counts of added, removed, and unchanged lines.
 */
export function getDiffStats(diff: DiffLine[]): {
  added: number;
  removed: number;
  unchanged: number;
} {
  let added = 0;
  let removed = 0;
  let unchanged = 0;

  for (const line of diff) {
    switch (line.type) {
      case 'add':
        added++;
        break;
      case 'remove':
        removed++;
        break;
      case 'same':
        unchanged++;
        break;
    }
  }

  return { added, removed, unchanged };
}
