import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { copyText } from '../../lib/clipboard';

const FEEDBACK_MS = 1500;

interface CopyButtonProps {
  /** Called on click, so an expensive `JSON.stringify` only runs when needed. */
  getText: () => string;
  label: ReactNode;
  title: string;
  className?: string;
}

/** Copies on click and answers inline with ✓ or ✗ instead of a dialog. */
export default function CopyButton({ getText, label, title, className }: CopyButtonProps) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (status === 'idle') return;
    const timer = setTimeout(() => setStatus('idle'), FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const handleClick = async (e: MouseEvent) => {
    // Copy buttons sit inside clickable headers (tool result rows)
    e.stopPropagation();
    setStatus((await copyText(getText())) ? 'copied' : 'failed');
  };

  const feedbackTitle =
    status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : title;

  return (
    <button
      type="button"
      onClick={handleClick}
      className={className}
      title={feedbackTitle}
      aria-label={feedbackTitle}
    >
      {status === 'copied' ? '✓' : status === 'failed' ? '✗' : label}
    </button>
  );
}
