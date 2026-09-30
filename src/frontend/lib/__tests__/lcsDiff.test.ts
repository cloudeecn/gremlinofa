import { describe, it, expect } from 'vitest';
import {
  computeLcsDiff,
  splitLines,
  getDiffStats,
  filterDiffContext,
  type DiffLine,
} from '../lcsDiff';

describe('lcsDiff', () => {
  describe('computeLcsDiff', () => {
    describe('edge cases', () => {
      it('returns empty array for two empty arrays', () => {
        const result = computeLcsDiff([], []);
        expect(result).toEqual([]);
      });

      it('returns all additions when old is empty', () => {
        const result = computeLcsDiff([], ['a', 'b', 'c']);
        expect(result).toEqual([
          { type: 'add', content: 'a' },
          { type: 'add', content: 'b' },
          { type: 'add', content: 'c' },
        ]);
      });

      it('returns all removals when new is empty', () => {
        const result = computeLcsDiff(['a', 'b', 'c'], []);
        expect(result).toEqual([
          { type: 'remove', content: 'a' },
          { type: 'remove', content: 'b' },
          { type: 'remove', content: 'c' },
        ]);
      });

      it('handles single line comparison', () => {
        expect(computeLcsDiff(['a'], ['a'])).toEqual([{ type: 'same', content: 'a' }]);
        expect(computeLcsDiff(['a'], ['b'])).toEqual([
          { type: 'remove', content: 'a' },
          { type: 'add', content: 'b' },
        ]);
      });
    });

    describe('basic diffs', () => {
      it('detects unchanged content', () => {
        const lines = ['line 1', 'line 2', 'line 3'];
        const result = computeLcsDiff(lines, lines);
        expect(result).toEqual([
          { type: 'same', content: 'line 1' },
          { type: 'same', content: 'line 2' },
          { type: 'same', content: 'line 3' },
        ]);
      });

      it('detects single line addition at end', () => {
        const result = computeLcsDiff(['a', 'b'], ['a', 'b', 'c']);
        expect(result).toEqual([
          { type: 'same', content: 'a' },
          { type: 'same', content: 'b' },
          { type: 'add', content: 'c' },
        ]);
      });

      it('detects single line addition at start', () => {
        const result = computeLcsDiff(['b', 'c'], ['a', 'b', 'c']);
        expect(result).toEqual([
          { type: 'add', content: 'a' },
          { type: 'same', content: 'b' },
          { type: 'same', content: 'c' },
        ]);
      });

      it('detects single line removal at end', () => {
        const result = computeLcsDiff(['a', 'b', 'c'], ['a', 'b']);
        expect(result).toEqual([
          { type: 'same', content: 'a' },
          { type: 'same', content: 'b' },
          { type: 'remove', content: 'c' },
        ]);
      });

      it('detects single line removal at start', () => {
        const result = computeLcsDiff(['a', 'b', 'c'], ['b', 'c']);
        expect(result).toEqual([
          { type: 'remove', content: 'a' },
          { type: 'same', content: 'b' },
          { type: 'same', content: 'c' },
        ]);
      });

      it('detects replacement (remove + add)', () => {
        const result = computeLcsDiff(['a', 'b', 'c'], ['a', 'x', 'c']);
        expect(result).toEqual([
          { type: 'same', content: 'a' },
          { type: 'remove', content: 'b' },
          { type: 'add', content: 'x' },
          { type: 'same', content: 'c' },
        ]);
      });
    });

    describe('complex diffs', () => {
      it('handles multiple insertions', () => {
        const result = computeLcsDiff(['a', 'c'], ['a', 'b', 'c', 'd']);
        expect(result).toEqual([
          { type: 'same', content: 'a' },
          { type: 'add', content: 'b' },
          { type: 'same', content: 'c' },
          { type: 'add', content: 'd' },
        ]);
      });

      it('handles multiple deletions', () => {
        const result = computeLcsDiff(['a', 'b', 'c', 'd'], ['a', 'd']);
        expect(result).toEqual([
          { type: 'same', content: 'a' },
          { type: 'remove', content: 'b' },
          { type: 'remove', content: 'c' },
          { type: 'same', content: 'd' },
        ]);
      });

      it('handles interleaved changes', () => {
        const result = computeLcsDiff(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'y']);
        expect(result).toEqual([
          { type: 'same', content: 'a' },
          { type: 'remove', content: 'b' },
          { type: 'add', content: 'x' },
          { type: 'same', content: 'c' },
          { type: 'remove', content: 'd' },
          { type: 'add', content: 'y' },
        ]);
      });

      it('handles completely different content', () => {
        const result = computeLcsDiff(['a', 'b'], ['x', 'y', 'z']);
        expect(result).toEqual([
          { type: 'remove', content: 'a' },
          { type: 'remove', content: 'b' },
          { type: 'add', content: 'x' },
          { type: 'add', content: 'y' },
          { type: 'add', content: 'z' },
        ]);
      });
    });

    describe('whitespace handling', () => {
      it('preserves empty lines', () => {
        const result = computeLcsDiff(['a', '', 'b'], ['a', '', 'b']);
        expect(result).toEqual([
          { type: 'same', content: 'a' },
          { type: 'same', content: '' },
          { type: 'same', content: 'b' },
        ]);
      });

      it('detects added empty line', () => {
        const result = computeLcsDiff(['a', 'b'], ['a', '', 'b']);
        expect(result).toEqual([
          { type: 'same', content: 'a' },
          { type: 'add', content: '' },
          { type: 'same', content: 'b' },
        ]);
      });

      it('treats lines with different whitespace as different', () => {
        const result = computeLcsDiff(['  a'], ['a']);
        expect(result).toEqual([
          { type: 'remove', content: '  a' },
          { type: 'add', content: 'a' },
        ]);
      });
    });

    describe('performance sanity check', () => {
      it('handles moderately large files', () => {
        const oldLines: string[] = [];
        const newLines: string[] = [];

        // Create 100 lines with every 10th line different
        for (let i = 0; i < 100; i++) {
          oldLines.push(`line ${i}`);
          newLines.push(i % 10 === 0 ? `modified line ${i}` : `line ${i}`);
        }

        const result = computeLcsDiff(oldLines, newLines);

        // Should complete without timing out
        expect(result.length).toBeGreaterThan(0);

        // Count changes
        const stats = getDiffStats(result);
        expect(stats.added).toBe(10); // 10 modified lines
        expect(stats.removed).toBe(10);
        expect(stats.unchanged).toBe(90);
      });

      it('diffs a one-line edit in 12k lines quickly', () => {
        const oldLines = Array.from({ length: 12_000 }, (_, i) => `line ${i}`);
        const newLines = [...oldLines];
        newLines[6_000] = 'edited';

        const start = performance.now();
        const result = computeLcsDiff(oldLines, newLines);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(200);
        expect(result).toHaveLength(12_001);
        const changes = result.filter(line => line.type !== 'same');
        expect(changes).toEqual([
          { type: 'remove', content: 'line 6000' },
          { type: 'add', content: 'edited' },
        ]);
        expect(result[6_000]).toEqual({ type: 'remove', content: 'line 6000' });
      });
    });

    describe('prefix/suffix trimming', () => {
      it('handles an edit with only a common prefix', () => {
        expect(computeLcsDiff(['a', 'b', 'c'], ['a', 'b', 'x', 'y'])).toEqual([
          { type: 'same', content: 'a' },
          { type: 'same', content: 'b' },
          { type: 'remove', content: 'c' },
          { type: 'add', content: 'x' },
          { type: 'add', content: 'y' },
        ]);
      });

      it('handles an edit with only a common suffix', () => {
        expect(computeLcsDiff(['a', 'b', 'c'], ['x', 'y', 'b', 'c'])).toEqual([
          { type: 'remove', content: 'a' },
          { type: 'add', content: 'x' },
          { type: 'add', content: 'y' },
          { type: 'same', content: 'b' },
          { type: 'same', content: 'c' },
        ]);
      });

      it('does not let prefix and suffix overlap on repeated lines', () => {
        const result = computeLcsDiff(['a', 'a', 'a'], ['a', 'a']);
        expect(getDiffStats(result)).toEqual({ added: 0, removed: 1, unchanged: 2 });
        expect(result).toHaveLength(3);
      });
    });

    describe('large changed middle', () => {
      /** Old and new versions read back out of a diff */
      const sides = (diff: DiffLine[]) => ({
        old: diff.filter(line => line.type !== 'add').map(line => line.content),
        new: diff.filter(line => line.type !== 'remove').map(line => line.content),
      });

      /** Reference LCS length, independent of the implementation under test */
      const lcsLength = (a: string[], b: string[]) => {
        let prev = new Uint16Array(b.length + 1);
        let curr = new Uint16Array(b.length + 1);
        for (let i = 1; i <= a.length; i++) {
          for (let j = 1; j <= b.length; j++) {
            curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
          }
          [prev, curr] = [curr, prev];
        }
        return prev[b.length];
      };

      it('finds the few edits when both ends of a long file change', () => {
        // Differing first and last lines leave nothing to trim, so the middle is
        // 2500 x 2501 lines (> 4M table cells).
        const oldLines = Array.from({ length: 2_500 }, (_, i) => `L${i}`);
        const newLines = ['N', ...oldLines.slice(0, -1), 'M'];

        const result = computeLcsDiff(oldLines, newLines);

        expect(getDiffStats(result)).toEqual({ added: 2, removed: 1, unchanged: 2_499 });
        expect(result).toHaveLength(2_502);
        expect(result[0]).toEqual({ type: 'add', content: 'N' });
        expect(result[1]).toEqual({ type: 'same', content: 'L0' });
        expect(result.slice(-2)).toEqual([
          { type: 'remove', content: 'L2499' },
          { type: 'add', content: 'M' },
        ]);
      });

      it('keeps the diff minimal for scattered edits past the table cap', () => {
        // Deterministic LCG so a failure is reproducible
        let seed = 42;
        const random = (below: number) => {
          seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
          return seed % below;
        };
        const oldLines = Array.from({ length: 2_100 }, (_, i) => `line ${i % 700}`);
        const newLines = [...oldLines];
        newLines[0] = 'first edited';
        newLines[newLines.length - 1] = 'last edited';
        for (let edit = 0; edit < 60; edit++) {
          const at = random(newLines.length);
          const kind = random(3);
          if (kind === 0) newLines.splice(at, 1);
          else if (kind === 1) newLines.splice(at, 0, `inserted ${edit}`);
          else newLines[at] = `replaced ${edit}`;
        }

        const result = computeLcsDiff(oldLines, newLines);

        expect(sides(result)).toEqual({ old: oldLines, new: newLines });
        expect(getDiffStats(result).unchanged).toBe(lcsLength(oldLines, newLines));
      });

      it('falls back to remove-all then add-all when a huge middle mostly changed', () => {
        const oldLines = Array.from({ length: 2_500 }, (_, i) => `old ${i}`);
        const newLines = Array.from({ length: 2_501 }, (_, i) => `new ${i}`);

        const start = performance.now();
        const result = computeLcsDiff(oldLines, newLines);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(1_000);
        expect(getDiffStats(result)).toEqual({ added: 2_501, removed: 2_500, unchanged: 0 });
        expect(result.slice(0, 2_500).every(line => line.type === 'remove')).toBe(true);
        expect(result.slice(2_500).every(line => line.type === 'add')).toBe(true);
        expect(result[0]).toEqual({ type: 'remove', content: 'old 0' });
        expect(result[2_500]).toEqual({ type: 'add', content: 'new 0' });
      });

      it('still runs the LCS just under the cap', () => {
        // 1998 x 1999 middle -> 1999 * 2000 = 3,998,000 cells
        const oldLines = Array.from({ length: 1_998 }, (_, i) => `L${i}`);
        const newLines = ['N', ...oldLines.slice(0, -1), 'M'];

        const result = computeLcsDiff(oldLines, newLines);

        expect(getDiffStats(result)).toEqual({ added: 2, removed: 1, unchanged: 1_997 });
      });
    });
  });

  describe('splitLines', () => {
    it('returns empty array for empty string', () => {
      expect(splitLines('')).toEqual([]);
    });

    it('splits on newline character', () => {
      expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
    });

    it('handles single line without newline', () => {
      expect(splitLines('single line')).toEqual(['single line']);
    });

    it('preserves empty lines in middle', () => {
      expect(splitLines('a\n\nb')).toEqual(['a', '', 'b']);
    });

    it('preserves trailing empty line', () => {
      expect(splitLines('a\nb\n')).toEqual(['a', 'b', '']);
    });

    it('handles multiple consecutive newlines', () => {
      expect(splitLines('a\n\n\nb')).toEqual(['a', '', '', 'b']);
    });
  });

  describe('getDiffStats', () => {
    it('returns zeros for empty diff', () => {
      expect(getDiffStats([])).toEqual({
        added: 0,
        removed: 0,
        unchanged: 0,
      });
    });

    it('counts all line types correctly', () => {
      const diff: DiffLine[] = [
        { type: 'same', content: 'a' },
        { type: 'remove', content: 'b' },
        { type: 'add', content: 'c' },
        { type: 'same', content: 'd' },
        { type: 'add', content: 'e' },
        { type: 'remove', content: 'f' },
        { type: 'remove', content: 'g' },
      ];

      expect(getDiffStats(diff)).toEqual({
        added: 2,
        removed: 3,
        unchanged: 2,
      });
    });

    it('handles all same lines', () => {
      const diff: DiffLine[] = [
        { type: 'same', content: 'a' },
        { type: 'same', content: 'b' },
      ];

      expect(getDiffStats(diff)).toEqual({
        added: 0,
        removed: 0,
        unchanged: 2,
      });
    });
  });

  describe('filterDiffContext', () => {
    it('returns empty for diff with no changes', () => {
      const diff: DiffLine[] = [
        { type: 'same', content: 'a' },
        { type: 'same', content: 'b' },
      ];
      expect(filterDiffContext(diff, 3)).toEqual([]);
    });

    it('returns empty for empty diff', () => {
      expect(filterDiffContext([], 3)).toEqual([]);
    });

    it('returns single hunk around one change with context', () => {
      // 5 unchanged, 1 change, 5 unchanged — context=2
      const diff: DiffLine[] = [
        { type: 'same', content: '0' },
        { type: 'same', content: '1' },
        { type: 'same', content: '2' },
        { type: 'same', content: '3' },
        { type: 'same', content: '4' },
        { type: 'add', content: 'new' },
        { type: 'same', content: '5' },
        { type: 'same', content: '6' },
        { type: 'same', content: '7' },
        { type: 'same', content: '8' },
        { type: 'same', content: '9' },
      ];
      const hunks = filterDiffContext(diff, 2);
      expect(hunks).toHaveLength(1);
      // context=2 → indices 3..7
      expect(hunks[0].startLine).toBe(3);
      expect(hunks[0].lines).toEqual([
        { type: 'same', content: '3' },
        { type: 'same', content: '4' },
        { type: 'add', content: 'new' },
        { type: 'same', content: '5' },
        { type: 'same', content: '6' },
      ]);
    });

    it('merges overlapping context regions', () => {
      // Two changes close together — their context overlaps
      const diff: DiffLine[] = [
        { type: 'same', content: '0' },
        { type: 'add', content: 'a' },
        { type: 'same', content: '1' },
        { type: 'same', content: '2' },
        { type: 'same', content: '3' },
        { type: 'remove', content: 'b' },
        { type: 'same', content: '4' },
      ];
      // context=2: first change range [0,3], second [3,6] → merged [0,6]
      const hunks = filterDiffContext(diff, 2);
      expect(hunks).toHaveLength(1);
      expect(hunks[0].startLine).toBe(0);
      expect(hunks[0].lines).toHaveLength(7);
    });

    it('produces separate hunks when changes are far apart', () => {
      const diff: DiffLine[] = [];
      // 0..4 unchanged, change at 5, 6..15 unchanged, change at 16, 17..20 unchanged
      for (let i = 0; i < 5; i++) diff.push({ type: 'same', content: `${i}` });
      diff.push({ type: 'add', content: 'x' });
      for (let i = 6; i < 16; i++) diff.push({ type: 'same', content: `${i}` });
      diff.push({ type: 'add', content: 'y' });
      for (let i = 17; i < 21; i++) diff.push({ type: 'same', content: `${i}` });

      const hunks = filterDiffContext(diff, 2);
      expect(hunks).toHaveLength(2);
    });

    it('handles change at start of file', () => {
      const diff: DiffLine[] = [
        { type: 'add', content: 'new' },
        { type: 'same', content: 'a' },
        { type: 'same', content: 'b' },
        { type: 'same', content: 'c' },
        { type: 'same', content: 'd' },
      ];
      const hunks = filterDiffContext(diff, 2);
      expect(hunks).toHaveLength(1);
      expect(hunks[0].startLine).toBe(0);
      expect(hunks[0].lines).toEqual([
        { type: 'add', content: 'new' },
        { type: 'same', content: 'a' },
        { type: 'same', content: 'b' },
      ]);
    });

    it('handles change at end of file', () => {
      const diff: DiffLine[] = [
        { type: 'same', content: 'a' },
        { type: 'same', content: 'b' },
        { type: 'same', content: 'c' },
        { type: 'same', content: 'd' },
        { type: 'remove', content: 'old' },
      ];
      const hunks = filterDiffContext(diff, 2);
      expect(hunks).toHaveLength(1);
      expect(hunks[0].startLine).toBe(2);
      expect(hunks[0].lines).toEqual([
        { type: 'same', content: 'c' },
        { type: 'same', content: 'd' },
        { type: 'remove', content: 'old' },
      ]);
    });

    it('includes entire diff when context covers everything', () => {
      const diff: DiffLine[] = [
        { type: 'same', content: 'a' },
        { type: 'add', content: 'b' },
        { type: 'same', content: 'c' },
      ];
      const hunks = filterDiffContext(diff, 10);
      expect(hunks).toHaveLength(1);
      expect(hunks[0].startLine).toBe(0);
      expect(hunks[0].lines).toEqual(diff);
    });
  });

  describe('integration: splitLines + computeLcsDiff', () => {
    it('diffs text content correctly', () => {
      const oldText = 'line 1\nline 2\nline 3';
      const newText = 'line 1\nmodified\nline 3';

      const result = computeLcsDiff(splitLines(oldText), splitLines(newText));

      expect(result).toEqual([
        { type: 'same', content: 'line 1' },
        { type: 'remove', content: 'line 2' },
        { type: 'add', content: 'modified' },
        { type: 'same', content: 'line 3' },
      ]);
    });

    it('handles real-world code diff', () => {
      const oldCode = `function hello() {
  console.log("hello");
}`;

      const newCode = `function hello() {
  console.log("hello");
  console.log("world");
}`;

      const result = computeLcsDiff(splitLines(oldCode), splitLines(newCode));

      expect(result).toEqual([
        { type: 'same', content: 'function hello() {' },
        { type: 'same', content: '  console.log("hello");' },
        { type: 'add', content: '  console.log("world");' },
        { type: 'same', content: '}' },
      ]);
    });
  });
});
