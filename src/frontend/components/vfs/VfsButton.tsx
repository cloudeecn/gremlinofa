import type { ButtonHTMLAttributes } from 'react';

type Tone = 'default' | 'primary' | 'danger';

const BASE_CLASS =
  'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50';

const TONE_CLASS: Record<Tone, string> = {
  default: 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50',
  primary: 'bg-blue-600 text-white hover:bg-blue-700',
  danger: 'border border-red-200 bg-white text-red-600 hover:bg-red-50',
};

const ICON_ONLY_TONE_CLASS: Record<Tone, string> = {
  default: 'text-gray-500 hover:bg-gray-100 hover:text-gray-800',
  primary: 'text-blue-600 hover:bg-blue-50',
  danger: 'text-gray-500 hover:bg-red-50 hover:text-red-600',
};

interface VfsButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon?: string;
  label: string;
  tone?: Tone;
  /** Shows only the icon; the label becomes the accessible name and tooltip. */
  iconOnly?: boolean;
}

/** The one button style of the VFS manager, so toolbars stop drifting apart. */
export default function VfsButton({
  icon,
  label,
  tone = 'default',
  iconOnly = false,
  className = '',
  type = 'button',
  ...rest
}: VfsButtonProps) {
  if (iconOnly) {
    return (
      <button
        type={type}
        aria-label={label}
        title={label}
        className={`${BASE_CLASS} w-9 ${ICON_ONLY_TONE_CLASS[tone]} ${className}`}
        {...rest}
      >
        <span aria-hidden="true">{icon}</span>
      </button>
    );
  }
  return (
    <button type={type} className={`${BASE_CLASS} px-3 ${TONE_CLASS[tone]} ${className}`} {...rest}>
      {icon && <span aria-hidden="true">{icon}</span>}
      {label}
    </button>
  );
}
