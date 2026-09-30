import { useState, type InputHTMLAttributes } from 'react';

type NativeInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'defaultValue' | 'onChange' | 'onFocus' | 'onBlur' | 'min' | 'max'
>;

export interface NumberInputProps extends NativeInputProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** Truncate fractions, like the `parseInt` this replaces. */
  integer?: boolean;
}

function parseDraft(draft: string, integer: boolean): number | undefined {
  if (draft.trim() === '') return undefined;
  const parsed = Number(draft);
  if (!Number.isFinite(parsed)) return undefined;
  return integer ? Math.trunc(parsed) : parsed;
}

/**
 * `<input type="number">` that keeps what you type as a draft instead of
 * snapping back to the last valid number. A controlled input bound straight
 * to a number can't be empty, so clearing it restores the old value and the
 * next keystroke appends to it (backspace "5", type "8", get "58").
 *
 * While typing, a draft that parses reaches `onChange` clamped to [min, max];
 * the draft text itself is only clamped on blur, so typing isn't rewritten
 * mid-keystroke. An empty or unparseable draft commits nothing and reverts to
 * `value` on blur. Either way `value` is always what the field settles to on
 * blur, so anything derived from it (a preview count) matches what a click
 * elsewhere, which blurs the field first, will act on.
 */
export default function NumberInput({
  value,
  onChange,
  min,
  max,
  integer = false,
  ...inputProps
}: NumberInputProps) {
  const [draft, setDraft] = useState(() => String(value));
  const [focused, setFocused] = useState(false);

  // A new `value` that shows up while nobody is typing came from outside (a
  // reset, a reload), so it replaces the draft. While focused, the draft wins:
  // `value` changing then is usually our own commit of that draft.
  const [mirroredValue, setMirroredValue] = useState(value);
  if (!focused && value !== mirroredValue) {
    setMirroredValue(value);
    setDraft(String(value));
  }

  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));

  return (
    <input
      {...inputProps}
      type="number"
      value={draft}
      min={min}
      max={max}
      onFocus={() => setFocused(true)}
      onChange={e => {
        const nextDraft = e.target.value;
        setDraft(nextDraft);
        const parsed = parseDraft(nextDraft, integer);
        if (parsed === undefined) return;
        const next = clamp(parsed);
        if (next !== value) onChange(next);
      }}
      onBlur={() => {
        setFocused(false);
        const parsed = parseDraft(draft, integer);
        const settled = parsed === undefined ? value : clamp(parsed);
        if (settled !== value) onChange(settled);
        setDraft(String(settled));
        setMirroredValue(settled);
      }}
    />
  );
}
