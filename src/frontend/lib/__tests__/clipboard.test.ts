import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyText } from '../clipboard';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true, writable: true });
}

describe('copyText', () => {
  afterEach(() => {
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else setClipboard(undefined);
    Reflect.deleteProperty(document, 'execCommand');
  });

  it('uses the async Clipboard API when it is there', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    await expect(copyText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand without the Clipboard API (insecure context)', async () => {
    setClipboard(undefined);
    let copied = '';
    const execCommand = vi.fn(() => {
      copied = document.querySelector('textarea')?.value ?? '';
      return true;
    });
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });

    await expect(copyText('from LAN')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(copied).toBe('from LAN');
    // The helper textarea is gone again
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back when the Clipboard API refuses', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    Object.defineProperty(document, 'execCommand', { value: () => true, configurable: true });

    await expect(copyText('x')).resolves.toBe(true);
  });

  it('resolves false instead of throwing when nothing works', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });

    await expect(copyText('x')).resolves.toBe(false);
  });
});
