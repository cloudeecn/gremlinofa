import { useState, type InputHTMLAttributes } from 'react';

type NativeInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'onChange' | 'autoComplete'
>;

export interface SecretInputProps extends NativeInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Field name for the reveal button's accessible label ("Show <label>"). */
  label: string;
}

/**
 * Masked text input with a Show/Hide toggle, for credentials stored in
 * settings. `autoComplete="new-password"` keeps browsers from autofilling
 * a saved login into it (Chrome ignores `off` on password fields).
 */
export default function SecretInput({
  value,
  onChange,
  label,
  className = '',
  ...inputProps
}: SecretInputProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="relative">
      <input
        {...inputProps}
        type={revealed ? 'text' : 'password'}
        autoComplete="new-password"
        autoCapitalize="off"
        spellCheck={false}
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`${className} pr-16`}
      />
      <button
        type="button"
        onClick={() => setRevealed(shown => !shown)}
        aria-label={`${revealed ? 'Hide' : 'Show'} ${label}`}
        className="absolute inset-y-0 right-0 flex items-center rounded-r-lg px-3 text-xs font-medium text-gray-500 hover:text-gray-800 focus:ring-2 focus:ring-blue-500 focus:outline-none"
      >
        {revealed ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
