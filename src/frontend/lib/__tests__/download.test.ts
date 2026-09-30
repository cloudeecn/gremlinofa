import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadBlob, REVOKE_DELAY_MS } from '../download';

// jsdom has no object URLs
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

describe('downloadBlob', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    createObjectURL = vi.fn(() => 'blob:fake-url');
    revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.assign(URL, { createObjectURL: originalCreate, revokeObjectURL: originalRevoke });
  });

  it('clicks a download anchor and removes it', () => {
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicked.push(this);
    });
    const blob = new Blob(['hello'], { type: 'text/plain' });

    downloadBlob(blob, 'notes.txt');

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe('notes.txt');
    expect(clicked[0].getAttribute('href')).toBe('blob:fake-url');
    expect(document.body.contains(clicked[0])).toBe(false);
  });

  it('keeps the object URL alive until the revoke delay passes', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadBlob(new Blob(['x']), 'x.bin');
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.advanceTimersByTime(REVOKE_DELAY_MS - 1);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
  });
});
