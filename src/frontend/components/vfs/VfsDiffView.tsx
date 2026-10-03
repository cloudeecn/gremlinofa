import { useMemo, type CSSProperties } from 'react';
import type { DiffHunk, DiffLine } from '../../lib/lcsDiff';

interface VfsDiffViewProps {
  diff: DiffLine[];
  /** Context-only mode: just these hunks, separated by `···` rows */
  hunks: DiffHunk[] | null;
}

interface LineNumbers {
  /** Per diff index, 1-based line in the old version; 0 for added lines. */
  old: Uint32Array;
  /** Per diff index, 1-based line in the new version; 0 for removed lines. */
  new: Uint32Array;
  /** Shared by every gutter cell so the columns line up across rows. */
  gutterStyle: CSSProperties;
}

function computeLineNumbers(diff: DiffLine[]): LineNumbers {
  const oldNumbers = new Uint32Array(diff.length);
  const newNumbers = new Uint32Array(diff.length);
  let oldLine = 0;
  let newLine = 0;
  for (let i = 0; i < diff.length; i++) {
    const { type } = diff[i];
    if (type !== 'add') oldNumbers[i] = ++oldLine;
    if (type !== 'remove') newNumbers[i] = ++newLine;
  }
  const digits = Math.max(2, String(Math.max(oldLine, newLine)).length);
  return { old: oldNumbers, new: newNumbers, gutterStyle: { width: `${digits}ch` } };
}

export default function VfsDiffView({ diff, hunks }: VfsDiffViewProps) {
  const lineNumbers = useMemo(() => computeLineNumbers(diff), [diff]);

  // Show "No differences" when empty or all lines are unchanged
  const hasChanges = diff.some(line => line.type !== 'same');
  if (diff.length === 0 || !hasChanges) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-sm text-gray-500">No differences</span>
      </div>
    );
  }

  // Context-only mode: render hunks with separators
  if (hunks) {
    return (
      <div className="font-mono text-sm">
        {hunks.map((hunk, hunkIdx) => (
          <div key={hunkIdx}>
            {hunkIdx > 0 && <HunkSeparator gutterStyle={lineNumbers.gutterStyle} />}
            {hunk.lines.map((line, lineIdx) => {
              const diffIndex = hunk.startLine + lineIdx;
              return (
                <DiffLineRow
                  key={lineIdx}
                  line={line}
                  oldLineNumber={lineNumbers.old[diffIndex]}
                  newLineNumber={lineNumbers.new[diffIndex]}
                  gutterStyle={lineNumbers.gutterStyle}
                />
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="font-mono text-sm">
      {diff.map((line, index) => (
        <DiffLineRow
          key={index}
          line={line}
          oldLineNumber={lineNumbers.old[index]}
          newLineNumber={lineNumbers.new[index]}
          gutterStyle={lineNumbers.gutterStyle}
        />
      ))}
    </div>
  );
}

const GUTTER_CELL = 'box-content shrink-0 px-2 text-right text-xs select-none';

function HunkSeparator({ gutterStyle }: { gutterStyle: CSSProperties }) {
  return (
    <div className="flex border-y border-blue-200 bg-blue-50/50 py-0.5">
      <span className={`${GUTTER_CELL} text-gray-300`} style={gutterStyle}>
        ···
      </span>
      <span className={`${GUTTER_CELL} border-r border-gray-200 text-gray-300`} style={gutterStyle}>
        ···
      </span>
      <span className="w-5 shrink-0" />
      <span className="flex-1 text-xs text-blue-400 select-none">···</span>
    </div>
  );
}

interface DiffLineRowProps {
  line: DiffLine;
  /** 0 when the line doesn't exist in that version (blank cell). */
  oldLineNumber: number;
  newLineNumber: number;
  gutterStyle: CSSProperties;
}

function DiffLineRow({ line, oldLineNumber, newLineNumber, gutterStyle }: DiffLineRowProps) {
  const bgClass =
    line.type === 'add'
      ? 'bg-green-50'
      : line.type === 'remove'
        ? 'bg-red-50'
        : 'bg-white hover:bg-gray-50';

  const textClass =
    line.type === 'add'
      ? 'text-green-800'
      : line.type === 'remove'
        ? 'text-red-800'
        : 'text-gray-700';

  const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
  const prefixClass =
    line.type === 'add'
      ? 'text-green-600'
      : line.type === 'remove'
        ? 'text-red-600'
        : 'text-gray-400';

  return (
    <div className={`flex ${bgClass}`}>
      <span className={`${GUTTER_CELL} py-0.5 text-gray-400`} style={gutterStyle}>
        {oldLineNumber || ''}
      </span>
      <span
        className={`${GUTTER_CELL} border-r border-gray-200 py-0.5 text-gray-400`}
        style={gutterStyle}
      >
        {newLineNumber || ''}
      </span>
      <span className={`w-5 shrink-0 py-0.5 text-center select-none ${prefixClass}`}>{prefix}</span>
      <span className={`flex-1 py-0.5 pr-4 break-words whitespace-pre-wrap ${textClass}`}>
        {line.content || '\u00A0'}
      </span>
    </div>
  );
}
