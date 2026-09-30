import { describe, it, expect } from 'vitest';
import { clipboardImageFiles, pickImageFiles } from '../imageFiles';

const png = () => new File(['png'], 'shot.png', { type: 'image/png' });
const pdf = () => new File(['pdf'], 'doc.pdf', { type: 'application/pdf' });

describe('pickImageFiles', () => {
  it('passes images through', () => {
    const files = [png(), png()];
    expect(pickImageFiles(files, 0, 10)).toEqual({ images: files });
  });

  it('drops other file types with an error, keeping the images', () => {
    const image = png();
    expect(pickImageFiles([image, pdf()], 0, 10)).toEqual({
      images: [image],
      error: 'Only image files are allowed',
    });
  });

  it('rejects a whole batch that would go over the limit', () => {
    expect(pickImageFiles([png(), png(), png()], 8, 10)).toEqual({
      images: [],
      error: 'Maximum 10 images allowed. You can add 2 more.',
    });
  });

  it('does nothing for an empty pick', () => {
    expect(pickImageFiles([], 10, 10)).toEqual({ images: [] });
  });
});

describe('clipboardImageFiles', () => {
  function clipboard(files: File[], items: DataTransferItem[] = []) {
    return { files, items } as unknown as DataTransfer;
  }

  it('takes image files from the clipboard', () => {
    const image = png();
    expect(clipboardImageFiles(clipboard([image, pdf()]))).toEqual([image]);
  });

  it('falls back to file items when files is empty', () => {
    const image = png();
    const item = { kind: 'file', type: 'image/png', getAsFile: () => image } as DataTransferItem;
    const text = { kind: 'string', type: 'text/plain', getAsFile: () => null } as DataTransferItem;

    expect(clipboardImageFiles(clipboard([], [text, item]))).toEqual([image]);
  });

  it('returns nothing for a text-only clipboard', () => {
    expect(clipboardImageFiles(clipboard([]))).toEqual([]);
  });
});
