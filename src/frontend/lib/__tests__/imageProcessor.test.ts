import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processImage, processImages } from '../imageProcessor';

const KB = 1024;

/** A base64 payload whose decoded size, as encodeCanvas estimates it, is about `kb` kilobytes */
const base64OfKb = (kb: number) => 'A'.repeat(Math.ceil((kb * KB * 4) / 3));

const fileOf = (bytes: number, type: string, name = 'image') =>
  new File([new Uint8Array(bytes).fill(7)], name, { type });

describe('imageProcessor', () => {
  // jsdom has no canvas and never loads images: stub both. toDataURL answers per
  // requested type, the way a browser falls back to PNG for types it can't encode.
  let encoderOutput: Record<string, string>;
  let imageLoads: number;
  const { createObjectURL, revokeObjectURL } = URL;

  beforeEach(() => {
    encoderOutput = {};
    imageLoads = 0;

    vi.stubGlobal(
      'Image',
      class {
        width = 800;
        height = 600;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_url: string) {
          imageLoads++;
          queueMicrotask(() => this.onload?.());
        }
      }
    );
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
      (type?: string) => encoderOutput[type ?? 'image/png'] ?? 'data:,'
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  describe('small files pass through untouched', () => {
    it.each(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])('%s', async type => {
      const file = fileOf(10 * KB, type);

      const { attachment, error } = await processImage(file);

      expect(error).toBeUndefined();
      expect(attachment?.mimeType).toBe(type);
      expect(attachment?.data).toBe(
        Buffer.from(new Uint8Array(10 * KB).fill(7)).toString('base64')
      );
      expect(imageLoads).toBe(0);
      expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled();
    });
  });

  describe('re-encoded files are labeled with the type the canvas produced', () => {
    it('labels a large GIF as PNG when the browser falls back to PNG', async () => {
      encoderOutput['image/png'] = `data:image/png;base64,${base64OfKb(300)}`;
      encoderOutput['image/gif'] = encoderOutput['image/png'];

      const { attachment } = await processImage(fileOf(600 * KB, 'image/gif'));

      expect(attachment?.mimeType).toBe('image/png');
      expect(attachment?.data).toBe(base64OfKb(300));
    });

    it('keeps the fallback PNG label when JPEG is not smaller', async () => {
      encoderOutput['image/png'] = `data:image/png;base64,${base64OfKb(700)}`;
      encoderOutput['image/webp'] = encoderOutput['image/png'];
      encoderOutput['image/jpeg'] = `data:image/jpeg;base64,${base64OfKb(800)}`;

      const { attachment } = await processImage(fileOf(600 * KB, 'image/webp'));

      expect(attachment?.mimeType).toBe('image/png');
      expect(attachment?.data).toBe(base64OfKb(700));
    });

    it('keeps WebP when the browser can encode it', async () => {
      encoderOutput['image/webp'] = `data:image/webp;base64,${base64OfKb(200)}`;

      const { attachment } = await processImage(fileOf(600 * KB, 'image/webp'));

      expect(attachment?.mimeType).toBe('image/webp');
    });

    it('switches to JPEG when it is smaller', async () => {
      encoderOutput['image/png'] = `data:image/png;base64,${base64OfKb(900)}`;
      encoderOutput['image/jpeg'] = `data:image/jpeg;base64,${base64OfKb(250)}`;

      const { attachment } = await processImage(fileOf(2048 * KB, 'image/png'));

      expect(attachment?.mimeType).toBe('image/jpeg');
      expect(attachment?.data).toBe(base64OfKb(250));
    });

    it('re-encodes as PNG when the canvas returns an unsupported type', async () => {
      encoderOutput['image/webp'] = `data:image/bmp;base64,${base64OfKb(100)}`;
      encoderOutput['image/png'] = `data:image/png;base64,${base64OfKb(120)}`;

      const { attachment } = await processImage(fileOf(600 * KB, 'image/webp'));

      expect(attachment?.mimeType).toBe('image/png');
      expect(attachment?.data).toBe(base64OfKb(120));
    });

    it('fails cleanly when the canvas cannot encode anything', async () => {
      // Every toDataURL call returns "data:," (what an unusable canvas gives)
      const { attachment, error } = await processImage(fileOf(600 * KB, 'image/gif'));

      expect(attachment).toBeNull();
      expect(error).toBe('Failed to encode image');
    });
  });

  it('rejects an image still over 1MB after compression', async () => {
    encoderOutput['image/png'] = `data:image/png;base64,${base64OfKb(1500)}`;
    encoderOutput['image/jpeg'] = `data:image/jpeg;base64,${base64OfKb(1200)}`;

    const { attachment, error } = await processImage(fileOf(3072 * KB, 'image/png'));

    expect(attachment).toBeNull();
    expect(error).toMatch(/Image too large after compression \(1200\.0KB\)/);
  });

  it('rejects unsupported formats', async () => {
    const { attachment, error } = await processImage(fileOf(KB, 'image/bmp'));

    expect(attachment).toBeNull();
    expect(error).toMatch(/Unsupported image format/);
  });

  it('processImages caps the count and prefixes errors with the file name', async () => {
    const files = [
      fileOf(KB, 'image/png', 'a.png'),
      fileOf(KB, 'image/bmp', 'b.bmp'),
      fileOf(KB, 'image/gif', 'c.gif'),
    ];

    const { attachments, errors } = await processImages(files, 2);

    expect(attachments.map(att => att.mimeType)).toEqual(['image/png']);
    expect(errors).toEqual([
      'Only the first 2 images will be attached.',
      expect.stringMatching(/^b\.bmp: Unsupported image format/),
    ]);
  });
});
