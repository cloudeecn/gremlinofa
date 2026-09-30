/**
 * Copies text. Falls back to a hidden textarea + `execCommand('copy')` where
 * the async Clipboard API is missing (a plain-http LAN server isn't a secure
 * context) or refuses. Never throws; resolves false when nothing was copied.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or document not focused: the legacy path may still work
    }
  }
  return copyWithExecCommand(text);
}

function copyWithExecCommand(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false;
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  // 16px so iOS doesn't zoom when select() focuses it
  textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
    previouslyFocused?.focus?.();
  }
}
