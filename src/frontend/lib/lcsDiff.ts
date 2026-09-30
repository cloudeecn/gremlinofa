/**
 * Line-by-line diff: common prefix/suffix trimming plus a Longest Common
 * Subsequence (LCS) on the changed middle (a DP table for small middles, Myers
 * for large ones with few edits).
 * Produces unified diff output showing additions, removals, and unchanged lines.
 */

export interface DiffLine {
  type: 'add' | 'remove' | 'same';
  content: string;
}

export interface DiffHunk {
  startLine: number; // 0-based index into the original diff array
  lines: DiffLine[];
}

/**
 * Largest (m+1)*(n+1) LCS table built for the changed middle: 4M Uint32 cells is
 * 16 MB and ~20-35 ms on a desktop (roughly a 2000 x 2000 line rewrite). Larger
 * middles go through Myers instead.
 */
const MAX_LCS_CELLS = 4_000_000;

/**
 * Edit budget for Myers on middles past the table cap. The backtrack keeps one
 * snapshot per edit step, (D+1)^2 Int32 cells in total, so 2000 edits is the
 * same 16 MB as the table. Past it the middle is shown as a block replacement
 * instead of freezing the tab.
 */
const MAX_MYERS_EDITS = 2_000;

/**
 * Diff the changed middle (everything between the common prefix and suffix),
 * appending to `out`. Removals land before additions within a replaced run.
 */
function appendMiddleDiff(out: DiffLine[], oldLines: string[], newLines: string[]): void {
  const m = oldLines.length;
  const n = newLines.length;

  if (m > 0 && n > 0) {
    if ((m + 1) * (n + 1) <= MAX_LCS_CELLS) {
      appendTableDiff(out, oldLines, newLines);
      return;
    }
    // e.g. a header and a footer edit in a long file: nothing to trim, few edits
    if (appendMyersDiff(out, oldLines, newLines)) return;
  }

  for (const line of oldLines) out.push({ type: 'remove', content: line });
  for (const line of newLines) out.push({ type: 'add', content: line });
}

/**
 * Full O(m*n) LCS table. Ties in the backtrack prefer 'add' when walking
 * backwards, so removals land before additions.
 */
function appendTableDiff(out: DiffLine[], oldLines: string[], newLines: string[]): void {
  const m = oldLines.length;
  const n = newLines.length;
  const cols = n + 1;

  // lcs[i * cols + j] = LCS length of oldLines[0..i-1] and newLines[0..j-1]
  const lcs = new Uint32Array((m + 1) * cols);
  for (let i = 1; i <= m; i++) {
    const row = i * cols;
    const prevRow = row - cols;
    const oldLine = oldLines[i - 1];
    for (let j = 1; j <= n; j++) {
      lcs[row + j] =
        oldLine === newLines[j - 1]
          ? lcs[prevRow + j - 1] + 1
          : Math.max(lcs[prevRow + j], lcs[row + j - 1]);
    }
  }

  const reversed: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      reversed.push({ type: 'same', content: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i * cols + j - 1] >= lcs[(i - 1) * cols + j])) {
      reversed.push({ type: 'add', content: newLines[j - 1] });
      j--;
    } else {
      reversed.push({ type: 'remove', content: oldLines[i - 1] });
      i--;
    }
  }

  for (let k = reversed.length - 1; k >= 0; k--) out.push(reversed[k]);
}

/**
 * Myers' greedy shortest edit script: O((m+n)*D) time for D edits, so it stays
 * cheap on huge inputs as long as few lines changed. Ties prefer deletions going
 * forward, so removals land before additions like the table's output. Returns
 * false, leaving `out` untouched, when the script needs more than
 * MAX_MYERS_EDITS edits.
 */
function appendMyersDiff(out: DiffLine[], oldLines: string[], newLines: string[]): boolean {
  const n = oldLines.length;
  const m = newLines.length;
  const maxEdits = Math.min(n + m, MAX_MYERS_EDITS);
  const offset = maxEdits + 1;
  // frontier[offset + k] = furthest x reached on diagonal k = x - y
  const frontier = new Int32Array(2 * maxEdits + 3);
  // snapshots[d] = frontier[-d..d] before step d, replayed by the backtrack
  const snapshots: Int32Array[] = [];

  let edits = -1;
  for (let d = 0; d <= maxEdits && edits < 0; d++) {
    snapshots.push(frontier.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && frontier[offset + k - 1] < frontier[offset + k + 1])
          ? frontier[offset + k + 1]
          : frontier[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }
      frontier[offset + k] = x;
      if (x >= n && y >= m) {
        edits = d;
        break;
      }
    }
  }
  if (edits < 0) return false;

  const reversed: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = edits; d > 0; d--) {
    const snapshot = snapshots[d];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && snapshot[d + k - 1] < snapshot[d + k + 1]) ? k + 1 : k - 1;
    const prevX = snapshot[d + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push({ type: 'same', content: oldLines[x - 1] });
      x--;
      y--;
    }
    if (x === prevX) {
      reversed.push({ type: 'add', content: newLines[prevY] });
    } else {
      reversed.push({ type: 'remove', content: oldLines[prevX] });
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0) {
    reversed.push({ type: 'same', content: oldLines[x - 1] });
    x--;
  }

  for (let i = reversed.length - 1; i >= 0; i--) out.push(reversed[i]);
  return true;
}

/**
 * Line-by-line diff between two versions.
 *
 * The common prefix and suffix are emitted as 'same' without entering the LCS,
 * so a typical edit only runs the O(m*n) table on the few lines that changed.
 * A changed middle larger than MAX_LCS_CELLS goes through Myers, which is cheap
 * when few lines changed (e.g. a header and a footer edit in a long file). One
 * that also needs more than MAX_MYERS_EDITS edits falls back to "all old middle
 * removed, all new middle added": correct, just not minimal.
 */
export function computeLcsDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const oldLen = oldLines.length;
  const newLen = newLines.length;
  const shorter = Math.min(oldLen, newLen);

  let prefix = 0;
  while (prefix < shorter && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    oldLines[oldLen - 1 - suffix] === newLines[newLen - 1 - suffix]
  ) {
    suffix++;
  }

  const diff: DiffLine[] = [];
  for (let k = 0; k < prefix; k++) diff.push({ type: 'same', content: oldLines[k] });
  appendMiddleDiff(
    diff,
    oldLines.slice(prefix, oldLen - suffix),
    newLines.slice(prefix, newLen - suffix)
  );
  for (let k = oldLen - suffix; k < oldLen; k++) diff.push({ type: 'same', content: oldLines[k] });
  return diff;
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

/**
 * Filter a diff to only show hunks around changed lines, with surrounding context.
 * Returns an array of hunks (each hunk is a contiguous slice of the diff).
 * Overlapping or adjacent context regions are merged into a single hunk.
 */
export function filterDiffContext(diff: DiffLine[], contextLines: number): DiffHunk[] {
  // Find indices of changed lines
  const changedIndices: number[] = [];
  for (let i = 0; i < diff.length; i++) {
    if (diff[i].type !== 'same') {
      changedIndices.push(i);
    }
  }

  if (changedIndices.length === 0) return [];

  // Build merged ranges: each range is [start, end] inclusive
  const ranges: [number, number][] = [];
  let rangeStart = Math.max(0, changedIndices[0] - contextLines);
  let rangeEnd = Math.min(diff.length - 1, changedIndices[0] + contextLines);

  for (let i = 1; i < changedIndices.length; i++) {
    const newStart = Math.max(0, changedIndices[i] - contextLines);
    const newEnd = Math.min(diff.length - 1, changedIndices[i] + contextLines);

    if (newStart <= rangeEnd + 1) {
      // Overlapping or adjacent — merge
      rangeEnd = newEnd;
    } else {
      ranges.push([rangeStart, rangeEnd]);
      rangeStart = newStart;
      rangeEnd = newEnd;
    }
  }
  ranges.push([rangeStart, rangeEnd]);

  return ranges.map(([start, end]) => ({ startLine: start, lines: diff.slice(start, end + 1) }));
}
