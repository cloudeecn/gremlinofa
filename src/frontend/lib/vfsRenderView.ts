/**
 * What the Render tab shows for a file, or null when it has no rendered form.
 * Text files all arrive as `text/plain`, so Markdown and SVG are told apart by
 * extension. Binary files carry a mime sniffed from their first bytes, which
 * in worker mode only knows PNG, JPEG, GIF and WebP; the extension covers the
 * other formats browsers can draw.
 */
export type RenderView = { kind: 'markdown' } | { kind: 'svg' } | { kind: 'image'; mime: string };

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  apng: 'image/apng',
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

export function renderViewFor(name: string, isBinary: boolean, mime: string): RenderView | null {
  const dot = name.lastIndexOf('.');
  const extension = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  if (isBinary) {
    if (mime.startsWith('image/')) return { kind: 'image', mime };
    const imageMime = IMAGE_MIME_BY_EXTENSION[extension];
    return imageMime ? { kind: 'image', mime: imageMime } : null;
  }
  if (extension === 'md' || extension === 'markdown') return { kind: 'markdown' };
  if (extension === 'svg') return { kind: 'svg' };
  return null;
}
